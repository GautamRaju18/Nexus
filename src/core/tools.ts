/**
 * The tool registry + the built-in v1 toolset. Agents may only call tools they
 * are licensed for (see each AgentSpec.tools). New capabilities — Gmail, Google
 * Calendar, banking-read, etc. — are added here as more tools and granted to the
 * relevant agents, with no change to the framework. That is how all 21 agents
 * deepen over time without new infrastructure.
 *
 * v1 ships a small set of genuinely-working, no-API-key tools so the whole org is
 * useful on day one: time, web fetch, best-effort web search, and memory/notes.
 */

import { z } from "zod";
import type { MemoryLayer, ToolDefinition } from "../types";

const KNOWN_LAYERS: MemoryLayer[] = [
  "identity",
  "preference",
  "episodic",
  "semantic",
  "procedural",
  "relationship",
];

/** Map a model's (possibly creative) layer string to a valid memory layer. */
function normalizeLayer(raw?: string): MemoryLayer {
  if (!raw) return "semantic";
  const v = raw.toLowerCase();
  if ((KNOWN_LAYERS as string[]).includes(v)) return v as MemoryLayer;
  if (/pref|like|favou?r|seat|taste/.test(v)) return "preference";
  if (/person|people|contact|relationship|friend|family|colleague/.test(v)) return "relationship";
  if (/identity|profile|name|address|passport|dob/.test(v)) return "identity";
  if (/event|happened|episod|history|trip|did/.test(v)) return "episodic";
  if (/workflow|process|procedure|routine|how-to|howto/.test(v)) return "procedural";
  return "semantic";
}

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    this.tools.set(tool.id, tool);
  }

  get(id: string): ToolDefinition | undefined {
    return this.tools.get(id);
  }

  /** Resolve a list of tool ids to definitions (ignoring unknown ids). */
  resolve(ids: string[]): ToolDefinition[] {
    return ids.map((id) => this.tools.get(id)).filter((t): t is ToolDefinition => Boolean(t));
  }

  all(): ToolDefinition[] {
    return [...this.tools.values()];
  }
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** Build the standard v1 toolset. */
export function builtinTools(): ToolDefinition[] {
  const currentTime: ToolDefinition = {
    id: "current_time",
    description: "Get the current date and time (local and ISO).",
    sensitivity: "read",
    scopes: [],
    input: z.object({}).strict(),
    handler: async () => {
      const now = new Date();
      return { iso: now.toISOString(), local: now.toString(), epochMs: now.getTime() };
    },
  };

  const webFetch: ToolDefinition = {
    id: "web_fetch",
    description: "Fetch a web page by URL and return its readable text (truncated).",
    sensitivity: "read",
    scopes: ["web"],
    input: z.object({}).passthrough(),
    handler: async (input) => {
      const i = input as Record<string, unknown>;
      const url = (i.url || i.link || i.href || i.u) as string | undefined;
      const maxChars = typeof i.maxChars === "number" ? i.maxChars : undefined;
      if (!url || !/^https?:\/\//.test(url)) return { error: "provide a valid http(s) url" };
      try {
        const res = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(12000) });
        if (!res.ok) return { error: `fetch failed: ${res.status}` };
        const text = stripHtml(await res.text());
        return { url, text: text.slice(0, maxChars ?? 4000) };
      } catch (e) {
        return { error: `fetch error: ${(e as Error).message}` };
      }
    },
  };

  const webSearch: ToolDefinition = {
    id: "web_search",
    description:
      "Search the web (best-effort, via DuckDuckGo). Returns a list of {title, url, snippet}.",
    sensitivity: "read",
    scopes: ["web"],
    input: z.object({}).passthrough(),
    handler: async (input) => {
      const i = input as Record<string, unknown>;
      const query = (i.query || i.q || i.search || i.text || i.keywords) as string | undefined;
      const limit = typeof i.limit === "number" ? i.limit : 6;
      if (!query) return { error: "provide a search query" };
      try {
        const res = await fetch("https://html.duckduckgo.com/html/", {
          method: "POST",
          headers: { "user-agent": UA, "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ q: query }).toString(),
          signal: AbortSignal.timeout(12000),
        });
        const html = await res.text();
        const titles = [...html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
        const snippets = [...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)];
        const results = titles.slice(0, limit).map((m, idx) => ({
          url: m[1]!,
          title: stripHtml(m[2]!),
          snippet: snippets[idx] ? stripHtml(snippets[idx]![1]!).slice(0, 300) : "",
        }));
        if (results.length === 0) {
          return { note: "No results parsed. Try web_fetch on a specific URL instead." };
        }
        // Snippets alone are usually enough to summarize, without fetching (which can 403).
        return { results };
      } catch (e) {
        return { error: `web_search unavailable: ${e}. Use web_fetch with a specific URL instead.` };
      }
    },
  };

  const weather: ToolDefinition = {
    id: "weather",
    description: "Get current weather and today's forecast for a place. Input: { location }.",
    sensitivity: "read",
    scopes: ["web"],
    input: z.object({}).passthrough(),
    handler: async (input) => {
      const i = input as Record<string, string>;
      const loc = i.location || i.city || i.place || i.q || i.query || "";
      if (!loc) return { error: "no location given; ask which city, or use a remembered home city" };
      // wttr.in returns JSON only when the user-agent looks like curl; no API key needed.
      const res = await fetch(`https://wttr.in/${encodeURIComponent(loc)}?format=j1`, {
        headers: { "user-agent": "curl/8" },
        signal: AbortSignal.timeout(12000),
      }).catch(() => null);
      if (!res || !res.ok) return { error: `weather unavailable for "${loc}"` };
      const data = (await res.json()) as any;
      const cur = data.current_condition?.[0];
      const today = data.weather?.[0];
      return {
        location: loc,
        now: cur && {
          tempC: cur.temp_C,
          feelsLikeC: cur.FeelsLikeC,
          desc: cur.weatherDesc?.[0]?.value,
          humidity: cur.humidity,
          windKmph: cur.windspeedKmph,
        },
        today: today && {
          maxC: today.maxtempC,
          minC: today.mintempC,
          sunrise: today.astronomy?.[0]?.sunrise,
          sunset: today.astronomy?.[0]?.sunset,
        },
      };
    },
  };

  const remember: ToolDefinition = {
    id: "remember",
    description:
      "Store a long-term memory about the user. layer is one of: identity, preference, episodic, semantic, procedural, relationship. Use for stable preferences, facts, people, and workflows.",
    sensitivity: "write",
    internal: true,
    scopes: ["memory"],
    // layer accepts any string and is normalized, so a creative model never fails here.
    input: z
      .object({
        layer: z.string().optional(),
        key: z.string(),
        content: z.string(),
        confidence: z.number().min(0).max(1).optional(),
      })
      .passthrough(),
    handler: async (input, ctx) => {
      const i = input as { layer?: string; key: string; content: string; confidence?: number };
      const id = await ctx.services.memory.remember({
        layer: normalizeLayer(i.layer),
        key: i.key,
        content: i.content,
        confidence: i.confidence,
        source: `agent:${ctx.agentId}`,
      });
      return { stored: true, id, layer: normalizeLayer(i.layer) };
    },
  };

  const recall: ToolDefinition = {
    id: "recall",
    description: "Recall relevant long-term memories about the user for the given query.",
    sensitivity: "read",
    internal: true,
    scopes: ["memory"],
    input: z.object({}).passthrough(),
    handler: async (input, ctx) => {
      const i = input as Record<string, unknown>;
      const query = (i.query || i.q || i.text || i.key) as string | undefined;
      const limit = typeof i.limit === "number" ? i.limit : 6;
      if (!query) return { error: "provide a query to recall" };
      const hits = await ctx.services.memory.recall(query, limit);
      return {
        memories: hits.map((m) => ({
          layer: m.layer,
          key: m.key,
          content: m.content,
          confidence: m.confidence,
        })),
      };
    },
  };

  const note: ToolDefinition = {
    id: "note",
    description: "Save a short scratch note under a key (overwrites). Use get_note to read it back.",
    sensitivity: "write",
    internal: true,
    scopes: ["notes"],
    input: z.object({ key: z.string().min(1, "a note key is required"), value: z.string().min(1, "a note value is required") }).passthrough(),
    handler: async (input, ctx) => {
      const i = input as { key: string; value: string };
      ctx.services.kv.set(`note:${i.key}`, i.value);
      return { saved: true };
    },
  };

  const getNote: ToolDefinition = {
    id: "get_note",
    description: "Read back a scratch note saved with the note tool.",
    sensitivity: "read",
    internal: true,
    scopes: ["notes"],
    input: z.object({ key: z.string().min(1, "a note key is required") }).passthrough(),
    handler: async (input, ctx) => {
      const i = input as { key: string };
      return { value: ctx.services.kv.get(`note:${i.key}`) };
    },
  };

  return [currentTime, weather, webFetch, webSearch, remember, recall, note, getNote];
}
