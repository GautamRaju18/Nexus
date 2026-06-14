/**
 * Web cockpit — a local GUI for Nexus. Runs an HTTP server bound to 127.0.0.1
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
const PORT = Number(process.env.NEXUS_WEB_PORT ?? 4321);
const HOST = "127.0.0.1";

// ── Server-Sent Events hub ────────────────────────────────────────────────────
// Each client is tagged with its userId so we can target a single tenant (their chat
// progress, reminders, and approval cards) and never leak one user's activity to another.
class SseHub {
  private clients = new Map<ServerResponse, string>();
  add(res: ServerResponse, userId: string): void {
    this.clients.set(res, userId);
    res.on("close", () => this.clients.delete(res));
  }
  /** Send to one user's clients (userId set), or broadcast to everyone (userId omitted). */
  send(event: string, data: unknown, userId?: string): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const [res, uid] of this.clients) {
      if (userId && uid !== userId) continue;
      try {
        res.write(payload);
      } catch {
        /* client gone */
      }
    }
  }
}

// ── Approver: pushes a card over SSE, resolves on POST /api/approve ───────────
// The card is routed to the requesting user's clients, and only that same user may
// settle it (checked in the /api/approve handler).
class WebApprover implements Approver {
  private pending = new Map<string, { resolve: (b: boolean) => void; timer: NodeJS.Timeout; userId: string }>();
  private counter = 0;
  constructor(private sse: SseHub) {}

  approve(req: ApprovalRequest): Promise<boolean> {
    const id = `a${++this.counter}`;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => this.settle(id, false), 5 * 60 * 1000);
      timer.unref?.();
      this.pending.set(id, { resolve, timer, userId: req.userId });
      this.sse.send(
        "approval",
        {
          id,
          agent: AGENTS_BY_ID[req.agentId]?.name ?? req.agentId,
          tool: req.toolId,
          sensitivity: req.sensitivity,
          preview: req.preview,
          reversible: req.reversible,
        },
        req.userId,
      );
    });
  }

  /** Settle a pending approval. If `byUserId` is given, it must own the approval. */
  settle(id: string, decision: boolean, byUserId?: string): boolean {
    const e = this.pending.get(id);
    if (!e) return false;
    if (byUserId && e.userId !== byUserId) return false;
    clearTimeout(e.timer);
    this.pending.delete(id);
    e.resolve(decision);
    this.sse.send("approval_resolved", { id, decision }, e.userId);
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
function json(res: ServerResponse, code: number, obj: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(code, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(obj));
}
const SESSION_COOKIE = "nexus_session";
/** Parse the request's Cookie header into a name→value map. */
function parseCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
/** Build a Set-Cookie value for the session token (HttpOnly, SameSite=Strict, loopback). */
function sessionCookie(token: string, maxAgeSec: number): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}`;
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
  rt.auth.purgeExpired();

  // Per-user encrypted file store, built on that tenant's scoped vault/kv view.
  const filesFor = (userId: string): FileStore => {
    const s = rt.scope(userId);
    return new FileStore(s.vault, s.kv);
  };
  // Resolve the session cookie to the acting user, or null if unauthenticated.
  const sessionUser = (req: IncomingMessage) => rt.auth.resolve(parseCookies(req)[SESSION_COOKIE]);

  // Proactive nudges: deliver each due reminder ONLY to its own user's clients.
  rt.startScheduler((r) =>
    sse.send("reminder", { id: r.id, text: r.text, recurrence: r.recurrence, due: r.dueAt }, r.userId),
  );
  let chatQueue: Promise<void> = Promise.resolve();

  // Per-user state. memoryCount is the user's; autonomy/kill are global safety controls.
  const state = (userId: string) => ({
    brain: rt.llm.name,
    killed: rt.policy.isKilled(),
    memoryCount: rt.memory.count(userId),
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

      // ── Auth (login is the only public API; accounts are pre-seeded via the user CLI) ──
      if (method === "POST" && path === "/api/auth/login") {
        const body = await readJson(req).catch(() => ({}));
        const user = rt.auth.verify(String(body.username ?? ""), String(body.password ?? ""));
        if (!user) return json(res, 401, { error: "invalid username or password" });
        const token = rt.auth.startSession(user.id);
        return json(res, 200, { user: { username: user.username } }, { "set-cookie": sessionCookie(token, 30 * 86400) });
      }
      if (method === "GET" && path === "/api/auth/me") {
        const sess = sessionUser(req);
        return sess ? json(res, 200, { user: { username: sess.username } }) : json(res, 401, { error: "not authenticated" });
      }

      // ── Gate: everything below requires a valid session ──
      const sess = sessionUser(req);
      if (!sess) return json(res, 401, { error: "authentication required" });
      const userId = sess.userId;

      if (method === "POST" && path === "/api/auth/logout") {
        const token = parseCookies(req)[SESSION_COOKIE];
        if (token) rt.auth.endSession(token);
        return json(res, 200, { ok: true }, { "set-cookie": sessionCookie("", 0) });
      }

      if (method === "GET" && path === "/api/events") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.write(": connected\n\n");
        sse.add(res, userId);
        return; // keep the connection open
      }

      if (method === "GET" && path === "/api/state") return json(res, 200, state(userId));
      if (method === "GET" && path === "/api/memory") return json(res, 200, { memories: rt.memory.list(undefined, userId).slice(0, 100) });
      // Save a memory directly (used by the Drop Dock's "remember" action).
      if (method === "POST" && path === "/api/memory") {
        const body = await readJson(req).catch(() => ({}));
        const content = String(body.content ?? "").trim();
        if (!content) return json(res, 400, { error: "empty memory" });
        const key = String(body.key ?? content.slice(0, 40)).trim() || "note";
        const id = await rt.scope(userId).memory.remember({ layer: "semantic", key, content, source: "dropped by user" });
        return json(res, 200, { ok: true, id });
      }
      if (method === "GET" && path === "/api/audit") return json(res, 200, { entries: rt.audit.recent(50, userId) });

      // ── Conversations (multi-chat for the main channel) ──
      if (method === "GET" && path === "/api/conversations") {
        return json(res, 200, { conversations: rt.conversations.listConversations(userId) });
      }
      if (method === "POST" && path === "/api/conversations") {
        const convo = rt.conversations.createConversation(userId);
        return json(res, 200, convo);
      }
      if (method === "POST" && path === "/api/conversations/delete") {
        const body = await readJson(req).catch(() => ({}));
        return json(res, 200, { ok: rt.conversations.deleteConversation(String(body.id ?? ""), userId) });
      }
      if (method === "POST" && path === "/api/conversations/rename") {
        const body = await readJson(req).catch(() => ({}));
        return json(res, 200, { ok: rt.conversations.renameConversation(String(body.id ?? ""), userId, String(body.title ?? "")) });
      }

      // Replay a transcript (survives refresh AND server restart). By conversation id for the
      // main channel; falls back to a scope (e.g. a direct line) when no id is given.
      if (method === "GET" && path === "/api/history") {
        const conversation = url.searchParams.get("conversation");
        if (conversation) return json(res, 200, { messages: rt.conversations.messagesOf(conversation, userId, 200) });
        const scope = (url.searchParams.get("scope") || "main").slice(0, 60);
        return json(res, 200, { messages: rt.conversations.history(userId, scope, 200) });
      }

      if (method === "GET" && path === "/api/weather") {
        const city = (url.searchParams.get("city") || process.env.NEXUS_HOME_CITY || "Hyderabad").slice(0, 60);
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

      // ── Encrypted local file store (isolated per user) ──
      const files = filesFor(userId);
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
        // Which main conversation this belongs to (multi-chat). May be empty/unknown — we
        // resolve or create one when persisting so a turn is never lost.
        let conversationId = typeof body.conversationId === "string" ? body.conversationId : "";
        const services = rt.scope(userId); // this user's isolated stores
        let answer = "";
        // Every live event is targeted to THIS user's clients only.
        const cb = {
          onProgress: (m: string) => sse.send("progress", { text: m }, userId),
          onAgent: (id: string, active: boolean) => sse.send("agent", { id, active }, userId),
          onA2A: (from: string, to: string, msg: string) => sse.send("a2a", { from, to, msg: msg.slice(0, 90) }, userId),
          onTurn: (id: string, msg: string) => sse.send("turn", { id, name: AGENTS_BY_ID[id]?.name ?? id, message: msg }, userId),
          userId,
          services,
        };
        // Persist to a SPECIFIC main conversation; create one if the id is missing/not theirs.
        const saveMain = (agent?: string) => {
          if (!conversationId || !rt.conversations.appendTo(conversationId, userId, message, answer, agent)) {
            conversationId = rt.conversations.createConversation(userId).id;
            rt.conversations.appendTo(conversationId, userId, message, answer, agent);
          }
        };
        // Serialize chats so two overlapping requests can't interleave persisted turns.
        await (chatQueue = chatQueue
          .then(async () => {
            if (agents && agents.length >= 2) {
              answer = await orch.runWired(agents, message, cb); // turns surface live via onTurn
              saveMain();
            } else if (agentId) {
              const scope = `direct:${agentId}`;
              const h = rt.conversations.recent(userId, scope, 8);
              answer = await orch.runDirect(agentId, message, { history: h, ...cb });
              rt.conversations.appendTurn(userId, scope, message, answer, agentId);
            } else {
              const h = conversationId ? rt.conversations.recentOf(conversationId, userId, 8) : [];
              answer = await orch.handle(message, { history: h, ...cb });
              saveMain();
            }
          })
          .catch((e) => {
            const m = (e as Error).message || String(e);
            answer = /Ollama|fetch failed|rate.?limit|quota|RESOURCE_EXHAUSTED|429|overload/i.test(m)
              ? "⚠️ The free AI brains are rate-limited right now (this happens on free tiers under load). Give it ~30–60 seconds and try again — I auto-recover. For unlimited, fully-offline use, install Ollama (ollama.com)."
              : `⚠️ Something went wrong: ${m}`;
          })
          .finally(() => sse.send("done", {}, userId))); // clear any lingering active pulses
        // Return the conversation id so the client can track a freshly-created chat.
        return json(res, 200, { answer, conversationId: agentId ? undefined : conversationId });
      }

      if (method === "POST" && path === "/api/approve") {
        const body = await readJson(req);
        // byUserId ensures one user can't settle another user's approval card.
        return json(res, 200, { ok: approver.settle(String(body.id), Boolean(body.decision), userId) });
      }

      if (method === "POST" && path === "/api/autonomy") {
        const body = await readJson(req);
        const spec = AGENTS_BY_ID[String(body.agentId)];
        if (!spec) return json(res, 400, { error: "unknown agent" });
        const n = Number(body.level);
        if (!Number.isInteger(n) || n < 0 || n > 5 || n > spec.autonomyCeiling)
          return json(res, 400, { error: `level must be 0–${spec.autonomyCeiling}` });
        rt.policy.setAutonomy(spec.id, n as AutonomyLevel);
        sse.send("state", state(userId), userId);
        return json(res, 200, { ok: true });
      }

      if (method === "POST" && path === "/api/kill") {
        const body = await readJson(req).catch(() => ({}));
        const on = body.on === undefined ? !rt.policy.isKilled() : Boolean(body.on);
        rt.policy.setKill(on);
        sse.send("state", state(userId), userId);
        return json(res, 200, { killed: on });
      }

      if (method === "POST" && path === "/api/connect") {
        if (!rt.google.isConfigured()) return json(res, 400, { error: "Google not configured in .env (see SETUP-GOOGLE.md)" });
        rt.google
          .connect((m) => sse.send("progress", { text: m }, userId))
          .then(() => sse.send("state", state(userId), userId))
          .catch((e) => sse.send("progress", { text: `Google connect failed: ${(e as Error).message}` }, userId));
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
      console.log(`Nexus is already running on ${HOST}:${PORT} — opening it.`);
      if (process.env.NEXUS_NO_OPEN !== "1") openBrowser(`http://${HOST}:${PORT}`);
      process.exit(0);
    }
    console.error(e);
    process.exit(1);
  });

  server.listen(PORT, HOST, () => {
    const url = `http://${HOST}:${PORT}`;
    console.log(`\n  ✦ Nexus web cockpit → ${url}`);
    console.log(`  brain: ${rt.llm.name} · agents: ${AGENTS.length}\n`);
    if (process.env.NEXUS_NO_OPEN !== "1") openBrowser(url);
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
