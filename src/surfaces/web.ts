/**
 * Web cockpit — a local GUI for Jarvis. Runs an HTTP server bound to 127.0.0.1
 * (loopback only) and serves a single-page UI plus a small JSON API. Approvals are
 * pushed live to the browser over Server-Sent Events and resolved via POST /api/approve.
 *
 * Unlike the Telegram poll loop, HTTP requests are independent, so /api/chat (which
 * awaits an approval) and /api/approve (which resolves it) run concurrently — no
 * special decoupling needed.
 *
 * Run:  npm run web   (opens http://127.0.0.1:4321)
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { exec } from "node:child_process";
import { bootstrap } from "../core/bootstrap";
import { FileStore } from "../core/filestore";
import { AGENTS, AGENTS_BY_ID } from "../agents/specs";
import { AutonomyLevel, type ApprovalRequest, type Approver, type LLMMessage } from "../types";

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_PATH = join(HERE, "..", "..", "public", "index.html");
const PORT = Number(process.env.JARVIS_WEB_PORT ?? 4321);
const HOST = "127.0.0.1";

// ── Server-Sent Events hub ────────────────────────────────────────────────────
class SseHub {
  private clients = new Set<ServerResponse>();
  add(res: ServerResponse): void {
    this.clients.add(res);
    res.on("close", () => this.clients.delete(res));
  }
  send(event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.clients) {
      try {
        res.write(payload);
      } catch {
        /* client gone */
      }
    }
  }
}

// ── Approver: pushes a card over SSE, resolves on POST /api/approve ───────────
class WebApprover implements Approver {
  private pending = new Map<string, { resolve: (b: boolean) => void; timer: NodeJS.Timeout }>();
  private counter = 0;
  constructor(private sse: SseHub) {}

  approve(req: ApprovalRequest): Promise<boolean> {
    const id = `a${++this.counter}`;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => this.settle(id, false), 5 * 60 * 1000);
      timer.unref?.();
      this.pending.set(id, { resolve, timer });
      this.sse.send("approval", {
        id,
        agent: AGENTS_BY_ID[req.agentId]?.name ?? req.agentId,
        tool: req.toolId,
        sensitivity: req.sensitivity,
        preview: req.preview,
        reversible: req.reversible,
      });
    });
  }

  settle(id: string, decision: boolean): boolean {
    const e = this.pending.get(id);
    if (!e) return false;
    clearTimeout(e.timer);
    this.pending.delete(id);
    e.resolve(decision);
    this.sse.send("approval_resolved", { id, decision });
    return true;
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────
function readJson(req: IncomingMessage, maxBytes = 2_000_000): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > maxBytes) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}
function json(res: ServerResponse, code: number, obj: unknown): void {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}
function isLoopback(req: IncomingMessage): boolean {
  const a = req.socket.remoteAddress ?? "";
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}

const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);

/** DNS-rebinding defense: the Host header must be one of ours. */
function hostOk(req: IncomingMessage): boolean {
  return ALLOWED_HOSTS.has((req.headers.host ?? "").toLowerCase());
}

/**
 * CSRF defense. A malicious page in the user's browser can fire "simple" POSTs at
 * localhost (text/plain bypasses the CORS preflight), and our state-changing endpoints
 * would run. Browsers always attach an Origin header to such cross-origin POSTs, so we
 * reject any mutating request whose Origin isn't ours. A missing Origin means a non-browser
 * caller (curl/the user themselves) — allowed.
 */
function originOk(req: IncomingMessage): boolean {
  const o = req.headers.origin;
  if (!o) return true;
  try {
    return ALLOWED_HOSTS.has(new URL(o).host.toLowerCase());
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const rt = bootstrap(() => {});
  const sse = new SseHub();
  const approver = new WebApprover(sse);
  const orch = rt.buildOrchestrator(approver);
  const history: LLMMessage[] = [];
  const directHist = new Map<string, LLMMessage[]>(); // per-agent history for direct-line chats
  const files = new FileStore(rt.vault, rt.kv); // encrypted local file store
  let chatQueue: Promise<void> = Promise.resolve();

  const state = () => ({
    brain: rt.llm.name,
    killed: rt.policy.isKilled(),
    memoryCount: rt.memory.count(),
    google: { configured: rt.google.isConfigured(), connected: rt.google.isConnected() },
    agents: AGENTS.map((a) => ({
      id: a.id,
      name: a.name,
      department: a.department,
      purpose: a.purpose,
      autonomy: rt.policy.autonomyFor(a),
      ceiling: a.autonomyCeiling,
    })),
  });

  const server = createServer(async (req, res) => {
    // Defense-in-depth: bound to loopback, but also refuse non-local sockets and foreign Hosts.
    if (!isLoopback(req)) {
      res.writeHead(403);
      return res.end("forbidden");
    }
    if (!hostOk(req)) {
      res.writeHead(403);
      return res.end("bad host");
    }
    const url = new URL(req.url ?? "/", `http://${HOST}`);
    const path = url.pathname;
    const method = req.method ?? "GET";

    // CSRF: block cross-origin mutating requests (foreign Origin header).
    if (method !== "GET" && !originOk(req)) {
      res.writeHead(403);
      return res.end("bad origin");
    }

    try {
      if (method === "GET" && (path === "/" || path === "/index.html")) {
        const html = await readFile(UI_PATH, "utf8");
        // no-store so a UI update is never masked by a stale cached page.
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return res.end(html);
      }

      if (method === "GET" && path === "/api/events") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.write(": connected\n\n");
        sse.add(res);
        return; // keep the connection open
      }

      if (method === "GET" && path === "/api/state") return json(res, 200, state());
      if (method === "GET" && path === "/api/memory") return json(res, 200, { memories: rt.memory.list().slice(0, 100) });
      if (method === "GET" && path === "/api/audit") return json(res, 200, { entries: rt.audit.recent(50) });

      if (method === "GET" && path === "/api/weather") {
        const city = (url.searchParams.get("city") || process.env.JARVIS_HOME_CITY || "Hyderabad").slice(0, 60);
        try {
          const r = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=j1`, {
            headers: { "user-agent": "curl/8" },
            signal: AbortSignal.timeout(12000),
          });
          if (!r.ok) return json(res, 200, { error: "weather unavailable" });
          const d = (await r.json()) as any;
          const c = d.current_condition?.[0];
          const days = (d.weather ?? []).slice(0, 3).map((w: any) => ({
            date: w.date,
            maxC: w.maxtempC,
            minC: w.mintempC,
            sunrise: w.astronomy?.[0]?.sunrise,
            sunset: w.astronomy?.[0]?.sunset,
            desc: w.hourly?.[4]?.weatherDesc?.[0]?.value,
          }));
          return json(res, 200, {
            city,
            now: c && {
              tempC: c.temp_C,
              feelsLikeC: c.FeelsLikeC,
              desc: c.weatherDesc?.[0]?.value,
              humidity: c.humidity,
              windKmph: c.windspeedKmph,
              windDir: c.winddir16Point,
              precipMM: c.precipMM,
              visKm: c.visibility,
              pressure: c.pressure,
              uv: c.uvIndex,
            },
            days,
          });
        } catch {
          return json(res, 200, { error: "weather unavailable" });
        }
      }

      // ── Encrypted local file store ──
      if (method === "GET" && path === "/api/files") return json(res, 200, { files: files.list() });

      if (method === "POST" && path === "/api/files") {
        const body = await readJson(req, 14_000_000); // allow ~10MB files (base64-inflated)
        try {
          const meta = files.save(String(body.name ?? ""), String(body.type ?? ""), String(body.data ?? ""));
          return json(res, 200, { ok: true, file: meta });
        } catch (e) {
          return json(res, 400, { error: (e as Error).message });
        }
      }

      if (method === "GET" && path === "/api/files/get") {
        const id = url.searchParams.get("id") ?? "";
        const f = files.get(id);
        if (!f) {
          res.writeHead(404);
          return res.end("not found");
        }
        const safe = f.meta.name.replace(/[^\w.\- ]/g, "_");
        const disp = url.searchParams.get("inline") === "1" ? "inline" : "attachment";
        res.writeHead(200, {
          "content-type": f.meta.type || "application/octet-stream",
          "content-length": String(f.data.length),
          "content-disposition": `${disp}; filename="${safe}"`,
          "cache-control": "no-store",
        });
        return res.end(f.data);
      }

      if (method === "POST" && path === "/api/files/delete") {
        const body = await readJson(req);
        return json(res, 200, { ok: files.remove(String(body.id ?? "")) });
      }

      if (method === "POST" && path === "/api/chat") {
        const body = await readJson(req);
        const message = String(body.message ?? "").trim();
        if (!message) return json(res, 400, { error: "empty message" });
        // Optional targeting: a single agent (direct line) or a list (wired circuit).
        const agentId = typeof body.agentId === "string" ? body.agentId : undefined;
        const agents = Array.isArray(body.agents) ? body.agents.map((x: unknown) => String(x)) : undefined;
        let answer = "";
        const cb = {
          onProgress: (m: string) => sse.send("progress", { text: m }),
          onAgent: (id: string, active: boolean) => sse.send("agent", { id, active }),
          onA2A: (from: string, to: string, msg: string) => sse.send("a2a", { from, to, msg: msg.slice(0, 90) }),
          onTurn: (id: string, msg: string) => sse.send("turn", { id, name: AGENTS_BY_ID[id]?.name ?? id, message: msg }),
        };
        // Serialize chats so two overlapping requests can't interleave history.
        await (chatQueue = chatQueue
          .then(async () => {
            if (agents && agents.length >= 2) {
              answer = await orch.runWired(agents, message, cb); // turns surface live via onTurn
            } else if (agentId) {
              const h = directHist.get(agentId) ?? [];
              answer = await orch.runDirect(agentId, message, { history: h.slice(-8), ...cb });
              h.push({ role: "user", content: message }, { role: "assistant", content: answer });
              directHist.set(agentId, h);
            } else {
              answer = await orch.handle(message, { history: history.slice(-8), ...cb });
              history.push({ role: "user", content: message }, { role: "assistant", content: answer });
            }
          })
          .catch((e) => {
            const m = (e as Error).message || String(e);
            answer = /Ollama|fetch failed|rate.?limit|quota|RESOURCE_EXHAUSTED|429|overload/i.test(m)
              ? "⚠️ The free AI brains are rate-limited right now (this happens on free tiers under load). Give it ~30–60 seconds and try again — I auto-recover. For unlimited, fully-offline use, install Ollama (ollama.com)."
              : `⚠️ Something went wrong: ${m}`;
          })
          .finally(() => sse.send("done", {}))); // clear any lingering active pulses
        return json(res, 200, { answer });
      }

      if (method === "POST" && path === "/api/approve") {
        const body = await readJson(req);
        return json(res, 200, { ok: approver.settle(String(body.id), Boolean(body.decision)) });
      }

      if (method === "POST" && path === "/api/autonomy") {
        const body = await readJson(req);
        const spec = AGENTS_BY_ID[String(body.agentId)];
        if (!spec) return json(res, 400, { error: "unknown agent" });
        const n = Number(body.level);
        if (!Number.isInteger(n) || n < 0 || n > 5 || n > spec.autonomyCeiling)
          return json(res, 400, { error: `level must be 0–${spec.autonomyCeiling}` });
        rt.policy.setAutonomy(spec.id, n as AutonomyLevel);
        sse.send("state", state());
        return json(res, 200, { ok: true });
      }

      if (method === "POST" && path === "/api/kill") {
        const body = await readJson(req).catch(() => ({}));
        const on = body.on === undefined ? !rt.policy.isKilled() : Boolean(body.on);
        rt.policy.setKill(on);
        sse.send("state", state());
        return json(res, 200, { killed: on });
      }

      if (method === "POST" && path === "/api/connect") {
        if (!rt.google.isConfigured()) return json(res, 400, { error: "Google not configured in .env (see SETUP-GOOGLE.md)" });
        rt.google
          .connect((m) => sse.send("progress", { text: m }))
          .then(() => sse.send("state", state()))
          .catch((e) => sse.send("progress", { text: `Google connect failed: ${(e as Error).message}` }));
        return json(res, 200, { started: true });
      }

      res.writeHead(404);
      res.end("not found");
    } catch (e) {
      json(res, 500, { error: (e as Error).message });
    }
  });

  server.on("error", (e: any) => {
    if (e?.code === "EADDRINUSE") {
      // Already running (e.g. auto-start + a manual launch). Just open the existing one.
      console.log(`Jarvis is already running on ${HOST}:${PORT} — opening it.`);
      if (process.env.JARVIS_NO_OPEN !== "1") openBrowser(`http://${HOST}:${PORT}`);
      process.exit(0);
    }
    console.error(e);
    process.exit(1);
  });

  server.listen(PORT, HOST, () => {
    const url = `http://${HOST}:${PORT}`;
    console.log(`\n  ✦ Jarvis web cockpit → ${url}`);
    console.log(`  brain: ${rt.llm.name} · agents: ${AGENTS.length}\n`);
    if (process.env.JARVIS_NO_OPEN !== "1") openBrowser(url);
  });

  // SSE keep-alive so proxies/browsers don't drop the stream.
  setInterval(() => sse.send("ping", { t: Date.now() }), 25000).unref?.();
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "win32" ? `start "" "${url}"` : process.platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
