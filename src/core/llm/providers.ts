/**
 * The LLM brain, behind one interface so agents never care which model runs.
 *
 *   OllamaProvider  — fully local. Prompts never leave your machine. Most private.
 *   GeminiProvider  — Google's free tier. Higher quality; prompts go to Google.
 *
 * Both use plain fetch (no SDK dependency). Tool use is handled by the agent
 * runtime via a model-agnostic JSON protocol, so providers only need chat + embed.
 */

import type { Config } from "../../config";
import type { LLMMessage, LLMProvider } from "../../types";

// ── Ollama (local) ────────────────────────────────────────────────────────────
export class OllamaProvider implements LLMProvider {
  name: string;
  constructor(private cfg: Config) {
    this.name = `ollama:${cfg.ollamaModel}`;
  }

  async chat(messages: LLMMessage[]): Promise<string> {
    const res = await fetch(`${this.cfg.ollamaHost}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.cfg.ollamaModel,
        messages,
        stream: false,
        options: { temperature: 0.4 },
      }),
    }).catch((e) => {
      throw new Error(
        `Cannot reach Ollama at ${this.cfg.ollamaHost}. Is it running? Try: ollama serve  (and: ollama pull ${this.cfg.ollamaModel}). [${e}]`,
      );
    });
    if (!res.ok) throw new Error(`Ollama chat failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { message?: { content?: string } };
    return data.message?.content ?? "";
  }

  async embed(text: string): Promise<number[] | null> {
    const res = await fetch(`${this.cfg.ollamaHost}/api/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.cfg.ollamaEmbedModel, prompt: text }),
    }).catch(() => null);
    if (!res || !res.ok) return null;
    const data = (await res.json()) as { embedding?: number[] };
    return data.embedding ?? null;
  }
}

// ── Gemini (cloud, free tier) ──────────────────────────────────────────────────
export class GeminiProvider implements LLMProvider {
  name: string;
  private base = "https://generativelanguage.googleapis.com/v1beta";
  private embedOff = false; // set once Gemini embeddings prove unavailable on this key
  constructor(private cfg: Config) {
    this.name = `gemini:${cfg.geminiModel}`;
  }

  async chat(messages: LLMMessage[]): Promise<string> {
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const contents = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));

    const res = await fetch(
      `${this.base}/models/${this.cfg.geminiModel}:generateContent?key=${this.cfg.geminiApiKey}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents,
          ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
          generationConfig: { temperature: 0.4 },
        }),
      },
    );
    if (!res.ok) {
      const body = await res.text();
      if (res.status === 429) {
        throw new Error(
          "Gemini quota exhausted (429). This key has no/low free-tier quota — get a valid key (format AIzaSy…) at https://aistudio.google.com/apikey, or set NEXUS_LLM_PROVIDER=ollama.",
        );
      }
      throw new Error(`Gemini chat failed (${res.status}): ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    return data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  }

  async embed(text: string): Promise<number[] | null> {
    if (this.embedOff) return null; // don't keep hitting a known-unavailable endpoint
    const res = await fetch(
      `${this.base}/models/${this.cfg.geminiEmbedModel}:embedContent?key=${this.cfg.geminiApiKey}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: `models/${this.cfg.geminiEmbedModel}`,
          content: { parts: [{ text }] },
        }),
      },
    ).catch(() => null);
    if (!res || !res.ok) {
      this.embedOff = true;
      return null;
    }
    const data = (await res.json()) as { embedding?: { values?: number[] } };
    return data.embedding?.values ?? null;
  }
}

// ── OpenRouter (free + premium models, OpenAI-compatible) ───────────────────────
export class OpenRouterProvider implements LLMProvider {
  name: string;
  constructor(private cfg: Config) {
    this.name = `openrouter:${cfg.openrouterModel}`;
  }

  async chat(messages: LLMMessage[]): Promise<string> {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.cfg.openrouterApiKey}`,
        "content-type": "application/json",
        "HTTP-Referer": "http://127.0.0.1:4321",
        "X-Title": "Nexus",
      },
      body: JSON.stringify({ model: this.cfg.openrouterModel, messages, temperature: 0.4 }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      choices?: { message?: { content?: string } }[];
      error?: { message?: string; code?: number };
    };
    if (!res.ok || data.error) {
      const msg = data.error?.message ?? `HTTP ${res.status}`;
      const err = new Error(`OpenRouter (${this.cfg.openrouterModel}) failed: ${msg}`);
      if (res.status === 429 || /rate.?limit|quota/i.test(msg)) (err as any).retryAfter = 5;
      throw err;
    }
    return data.choices?.[0]?.message?.content ?? "";
  }

  // OpenRouter is used for chat only; embeddings fall back to local Ollama.
  async embed(): Promise<number[] | null> {
    return null;
  }
}

/**
 * Wraps a primary provider with a fallback. If the primary fails (quota/429,
 * network, etc.) we use the fallback and — for persistent failures like a dead
 * quota — trip a one-way breaker so we stop hammering the dead primary this session.
 * This is what stops a bad Gemini key from bricking the whole app.
 */
export class ResilientProvider implements LLMProvider {
  name: string;
  private cooldownUntil = 0; // skip the primary until this time (TRANSIENT rate-limit/overload)
  private permaDead = false; // primary abandoned for the session (dead key / zero quota only)
  private warned = false;
  constructor(
    private primary: LLMProvider,
    private fallback: LLMProvider,
    private warn: (msg: string) => void,
  ) {
    this.name = `${primary.name} → fallback ${fallback.name}`;
  }

  async chat(messages: LLMMessage[]): Promise<string> {
    if (!this.permaDead && Date.now() >= this.cooldownUntil) {
      try {
        const r = await this.primary.chat(messages);
        this.warned = false; // recovered — let future trouble warn again
        return r;
      } catch (e) {
        const msg = String(e);
        const retryAfter = (e as { retryAfter?: number }).retryAfter;
        if (/limit: ?0|api key not valid|invalid api key|no .{0,12}quota/i.test(msg)) {
          // A dead key or genuinely zero quota won't recover this session — stop trying it.
          this.permaDead = true;
          this.warn(`${this.primary.name} unavailable (quota/key). Using ${this.fallback.name} for this session.`);
        } else if (retryAfter || /429|rate.?limit|quota|RESOURCE_EXHAUSTED|overload|temporar/i.test(msg)) {
          // TRANSIENT: free models get rate-limited/overloaded. Cool down briefly, then retry the primary.
          const cd = retryAfter ? retryAfter * 1000 : 45000;
          this.cooldownUntil = Date.now() + cd;
          this.warnOnce(`${this.primary.name} busy (rate-limited) — using ${this.fallback.name} for ~${Math.round(cd / 1000)}s, then retrying.`);
        } else {
          this.cooldownUntil = Date.now() + 15000;
          this.warnOnce(`${this.primary.name} hiccup — using ${this.fallback.name} briefly. [${msg.slice(0, 70)}]`);
        }
      }
    }
    return this.fallback.chat(messages);
  }

  async embed(text: string): Promise<number[] | null> {
    if (!this.permaDead && Date.now() >= this.cooldownUntil) {
      const r = await this.primary.embed(text).catch(() => null);
      if (r) return r;
    }
    return this.fallback.embed(text);
  }

  private warnOnce(msg: string): void {
    if (!this.warned) {
      this.warned = true;
      this.warn(msg);
    }
  }
}

export function makeProvider(cfg: Config, warn: (msg: string) => void = () => {}): LLMProvider {
  const ollama = new OllamaProvider(cfg);
  // The best available local/cloud fallback: Gemini (if keyed) then Ollama, else Ollama.
  const lowerFallback: LLMProvider = cfg.geminiApiKey
    ? new ResilientProvider(new GeminiProvider(cfg), ollama, warn)
    : ollama;

  if (cfg.provider === "openrouter") {
    if (!cfg.openrouterApiKey) {
      throw new Error("Provider is 'openrouter' but OPENROUTER_API_KEY is empty. Set it in .env.");
    }
    // OpenRouter free models can rate-limit/overload → fall back to Gemini → Ollama.
    return new ResilientProvider(new OpenRouterProvider(cfg), lowerFallback, warn);
  }
  if (cfg.provider === "gemini") {
    if (!cfg.geminiApiKey) {
      throw new Error("Provider is 'gemini' but GEMINI_API_KEY is empty. Set it in .env.");
    }
    // Gemini primary (best free-tier quality + consistency) → OpenRouter (if keyed) → Ollama.
    const below: LLMProvider = cfg.openrouterApiKey
      ? new ResilientProvider(new OpenRouterProvider(cfg), ollama, warn)
      : ollama;
    return new ResilientProvider(new GeminiProvider(cfg), below, warn);
  }
  return ollama;
}
