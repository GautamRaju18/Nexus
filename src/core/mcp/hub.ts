/**
 * McpHub — connects Nexus to MCP servers and turns their tools into native Nexus tools.
 *
 * Config lives in `mcp.json` at the project root (gitignored — it can hold tokens):
 *   {
 *     "servers": {
 *       "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "D:\\work"] },
 *       "github":     { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_TOKEN": "..." } }
 *     }
 *   }
 *
 * Each discovered tool is registered as a ToolDefinition with id `mcp_<server>_<tool>`,
 * so agents call it exactly like a built-in. Read-ish tools (get/list/search/read, or a
 * readOnlyHint) run freely; anything that could mutate is sensitivity "write", so it
 * obeys the autonomy dial and kill switch just like every other outward action.
 */

import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { McpClient, type McpServerCfg, type McpTool } from "./client";
import type { ToolRegistry } from "../tools";
import type { ToolDefinition } from "../../types";

export interface McpConfig { servers?: Record<string, McpServerCfg> }
export interface McpServerStatus { server: string; ok: boolean; tools: number; toolNames: string[]; error?: string }

const sanitize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
const READ_RE = /^(get|list|search|read|fetch|find|query|describe|show|lookup|view|browse|resolve)/i;

/** MCP tool-call result → a compact value for the agent (text content, or an error). */
function normalizeResult(res: unknown): unknown {
  const r = res as { content?: { type?: string; text?: string }[]; isError?: boolean } | null;
  if (!r) return { ok: true };
  if (Array.isArray(r.content)) {
    const text = r.content.filter((c) => c.type === "text" && c.text).map((c) => c.text).join("\n").trim();
    if (r.isError) return { error: text || "the MCP tool reported an error" };
    return { result: text || r.content };
  }
  return r;
}

export class McpHub {
  private clients = new Map<string, McpClient>();
  readonly status: McpServerStatus[] = [];
  readonly toolIds: string[] = [];

  constructor(
    private registry: ToolRegistry,
    private log: (m: string) => void = () => {},
  ) {}

  loadConfig(path: string): McpConfig {
    try {
      if (!existsSync(path)) return {};
      const cfg = JSON.parse(readFileSync(path, "utf8"));
      return cfg && typeof cfg === "object" ? (cfg as McpConfig) : {};
    } catch (e) {
      this.log(`mcp: couldn't read ${path} — ${(e as Error).message}`);
      return {};
    }
  }

  /** Connect every enabled server, register its tools, and return the new tool ids. */
  async connectAll(cfg: McpConfig): Promise<string[]> {
    const servers = cfg.servers ?? {};
    const names = Object.keys(servers);
    if (!names.length) return [];
    this.log(`mcp: connecting ${names.length} server(s)…`);
    await Promise.all(
      names.map(async (name) => {
        const sc = servers[name]!;
        if (sc.disabled) return;
        try {
          const client = new McpClient(sc, this.log);
          const { tools } = await client.connect();
          this.clients.set(name, client);
          const ids: string[] = [];
          for (const t of tools) { const id = this.registerTool(name, client, t); if (id) ids.push(id); }
          this.toolIds.push(...ids);
          this.status.push({ server: name, ok: true, tools: ids.length, toolNames: tools.map((t) => t.name) });
          this.log(`mcp: "${name}" connected — ${ids.length} tool(s)`);
        } catch (e) {
          this.status.push({ server: name, ok: false, tools: 0, toolNames: [], error: (e as Error).message });
          this.log(`mcp: "${name}" failed — ${(e as Error).message}`);
        }
      }),
    );
    return this.toolIds;
  }

  closeAll(): void {
    for (const c of this.clients.values()) c.close();
  }

  private registerTool(server: string, client: McpClient, t: McpTool): string | null {
    if (!t?.name) return null;
    const id = `mcp_${sanitize(server)}_${sanitize(t.name)}`.slice(0, 60);
    const readOnly = t.annotations?.readOnlyHint === true || READ_RE.test(t.name);
    const props = t.inputSchema?.properties
      ? Object.entries(t.inputSchema.properties)
          .map(([k, v]) => `${k}${(t.inputSchema!.required ?? []).includes(k) ? "*" : ""}: ${(v as { type?: string }).type ?? "any"}`)
          .join(", ")
      : "";
    const def: ToolDefinition = {
      id,
      sensitivity: readOnly ? "read" : "write",
      scopes: ["mcp", server],
      description: `[${server}] ${t.description || t.name}${props ? ` — input {${props}} (* = required)` : ""}`.slice(0, 700),
      input: z.object({}).passthrough(), // the MCP server validates; we pass args through
      handler: async (input: unknown) => {
        try {
          return normalizeResult(await client.callTool(t.name, input ?? {}));
        } catch (e) {
          return { error: `MCP "${server}.${t.name}" failed: ${(e as Error).message}` };
        }
      },
    };
    this.registry.register(def);
    return id;
  }
}
