/**
 * Minimal MCP (Model Context Protocol) client over stdio — no SDK, no dependencies.
 * Speaks JSON-RPC 2.0 as newline-delimited JSON, which is exactly the MCP stdio
 * transport. Spawns a server process, does the initialize handshake, lists its tools,
 * and calls them. This is how Nexus plugs into the whole MCP ecosystem (filesystem,
 * GitHub, Slack, Notion, Puppeteer, …) while staying local and dependency-light.
 */

import { spawn, type ChildProcess } from "node:child_process";

export interface McpServerCfg {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  disabled?: boolean;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: { type?: string; properties?: Record<string, unknown>; required?: string[] };
  annotations?: { readOnlyHint?: boolean; title?: string };
}

const PROTOCOL_VERSION = "2024-11-05";

/** On Windows, npm-family launchers are .cmd shims; resolve them so spawn finds them. */
function resolveCmd(cmd: string): string {
  if (process.platform !== "win32") return cmd;
  if (/^(npx|npm|pnpm|yarn|bunx)$/.test(cmd)) return cmd + ".cmd";
  return cmd;
}

export class McpClient {
  private proc: ChildProcess | null = null;
  private buf = "";
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private closed = false;
  private stderrTail = "";

  constructor(
    private cfg: McpServerCfg,
    private log: (m: string) => void = () => {},
  ) {}

  /** Launch the server, handshake, and return its tool list. */
  async connect(timeoutMs = 20000): Promise<{ tools: McpTool[]; serverInfo?: { name?: string; version?: string } }> {
    const cmd = resolveCmd(this.cfg.command);
    this.proc = spawn(cmd, this.cfg.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(this.cfg.env ?? {}) },
      cwd: this.cfg.cwd,
      windowsHide: true,
    });
    this.proc.stdout!.on("data", (d: Buffer) => this.onData(d));
    this.proc.stderr!.on("data", (d: Buffer) => { this.stderrTail = (this.stderrTail + d.toString("utf8")).slice(-800); });
    this.proc.on("exit", (code) => { this.closed = true; this.failAll(new Error(`server exited (code ${code}). ${this.stderrTail.trim().slice(-200)}`)); });
    this.proc.on("error", (e) => { this.closed = true; this.failAll(new Error(`spawn failed: ${e.message}`)); });

    const init = (await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { roots: {}, sampling: {} },
      clientInfo: { name: "nexus", version: "1.0" },
    }, timeoutMs)) as { serverInfo?: { name?: string; version?: string } } | undefined;
    this.notify("notifications/initialized", {});
    const list = (await this.request("tools/list", {}, timeoutMs)) as { tools?: McpTool[] } | undefined;
    return { tools: list?.tools ?? [], serverInfo: init?.serverInfo };
  }

  async callTool(name: string, args: unknown, timeoutMs = 60000): Promise<unknown> {
    return this.request("tools/call", { name, arguments: args ?? {} }, timeoutMs);
  }

  close(): void {
    this.closed = true;
    try { this.proc?.kill(); } catch { /* ignore */ }
  }

  // ── internals ──────────────────────────────────────────────────────────────
  private onData(d: Buffer): void {
    this.buf += d.toString("utf8");
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg: { id?: number; result?: unknown; error?: { message?: string } };
      try { msg = JSON.parse(line); } catch { continue; } // ignore non-JSON server chatter
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || "rpc error"));
        else p.resolve(msg.result);
      }
    }
  }

  private send(obj: unknown): void {
    try { this.proc?.stdin?.write(JSON.stringify(obj) + "\n"); } catch { /* ignore */ }
  }

  private request(method: string, params: unknown, timeoutMs = 20000): Promise<unknown> {
    if (this.closed || !this.proc) return Promise.reject(new Error("not connected"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`timeout: ${method}`)); }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(to); resolve(v); },
        reject: (e) => { clearTimeout(to); reject(e); },
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  private failAll(e: Error): void {
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
  }
}
