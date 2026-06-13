/**
 * Configuration, loaded from environment (.env). Validated up front so the app
 * fails loudly and early rather than deep inside an agent run.
 *
 * Run with Node's built-in env loading:  node --env-file=.env ...
 * (the npm scripts and index.ts handle this for you).
 */

import { z } from "zod";

const Schema = z.object({
  masterKey: z.string().min(8, "JARVIS_MASTER_KEY must be at least 8 characters"),
  provider: z.enum(["auto", "ollama", "gemini", "openrouter"]).default("auto"),

  ollamaHost: z.string().default("http://127.0.0.1:11434"),
  ollamaModel: z.string().default("llama3.2"),
  ollamaEmbedModel: z.string().default("nomic-embed-text"),

  geminiApiKey: z.string().default(""),
  geminiModel: z.string().default("gemini-2.5-flash"),
  geminiEmbedModel: z.string().default("text-embedding-004"),

  openrouterApiKey: z.string().default(""),
  openrouterModel: z.string().default("google/gemma-4-31b-it:free"),

  telegramToken: z.string().default(""),
  telegramOwnerId: z.string().default(""),
  dbPath: z.string().default("./data/jarvis.db"),

  googleClientId: z.string().default(""),
  googleClientSecret: z.string().default(""),
});

export type Config = z.infer<typeof Schema>;

export function loadConfig(): Config {
  const parsed = Schema.safeParse({
    masterKey: process.env.JARVIS_MASTER_KEY,
    provider: process.env.JARVIS_LLM_PROVIDER?.trim(),
    ollamaHost: process.env.OLLAMA_HOST?.trim(),
    ollamaModel: process.env.OLLAMA_MODEL?.trim(),
    ollamaEmbedModel: process.env.OLLAMA_EMBED_MODEL?.trim(),
    geminiApiKey: process.env.GEMINI_API_KEY?.trim(),
    geminiModel: process.env.GEMINI_MODEL?.trim(),
    geminiEmbedModel: process.env.GEMINI_EMBED_MODEL?.trim(),
    openrouterApiKey: process.env.OPENROUTER_API_KEY?.trim(),
    openrouterModel: process.env.OPENROUTER_MODEL?.trim(),
    telegramToken: process.env.TELEGRAM_BOT_TOKEN?.trim(),
    telegramOwnerId: process.env.TELEGRAM_OWNER_ID?.trim(),
    dbPath: process.env.JARVIS_DB_PATH?.trim(),
    // Trim credentials — a stray leading/trailing space in .env silently breaks OAuth.
    googleClientId: process.env.GOOGLE_CLIENT_ID?.trim(),
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET?.trim(),
  });

  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(
      `Invalid configuration. Copy .env.example to .env and fill it in.\n${issues}`,
    );
  }

  // Resolve "auto": prefer OpenRouter (free strong models), then Gemini, then local Ollama.
  const cfg = parsed.data;
  if (cfg.provider === "auto") {
    cfg.provider = cfg.openrouterApiKey ? "openrouter" : cfg.geminiApiKey ? "gemini" : "ollama";
  }
  return cfg;
}
