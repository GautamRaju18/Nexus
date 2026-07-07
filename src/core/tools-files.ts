/**
 * File-Vault read tools. These let an agent actually USE the CEO's uploaded files —
 * e.g. the Job agent reading the real résumé to tailor an application — without the
 * file ever leaving the machine. Content is decrypted from the per-user encrypted vault
 * in memory, text is extracted locally (see textextract.ts), and only the text is handed
 * to the agent's reasoning. Read-only and internal (no outward effect).
 *
 * Files live where the web File Vault put them: content in vault `file:<id>` and a small
 * index in kv `files:index`. FileStore is the single source of truth for both.
 */

import { z } from "zod";
import type { ToolDefinition, ToolContext } from "../types";
import { FileStore } from "./filestore";
import { extractText } from "./textextract";

function store(ctx: ToolContext): FileStore {
  return new FileStore(ctx.services.vault, ctx.services.kv);
}

/** Resolve a file by exact id, then by case-insensitive name (exact, then substring). */
function findFile(files: FileStore, ref: string) {
  const list = files.list();
  const q = ref.trim().toLowerCase();
  return (
    list.find((f) => f.id === ref) ||
    list.find((f) => f.name.toLowerCase() === q) ||
    list.find((f) => f.name.toLowerCase().includes(q)) ||
    null
  );
}

export function fileTools(): ToolDefinition[] {
  const fileList: ToolDefinition = {
    id: "file_list",
    description:
      "List the files the CEO has uploaded to their encrypted File Vault (name, type, size, date). " +
      "Call this to see what's available before reading — e.g. to find their résumé/CV.",
    sensitivity: "read",
    internal: true,
    scopes: ["files"],
    input: z.object({}).passthrough(),
    handler: async (_input, ctx) => {
      const files = store(ctx).list();
      if (!files.length) return { files: [], note: "No files in the vault yet. The CEO can upload one in the File Vault." };
      return {
        files: files.map((f) => ({ id: f.id, name: f.name, type: f.type, sizeKB: Math.max(1, Math.round(f.size / 1024)), date: f.date })),
        total: files.length,
      };
    },
  };

  const fileRead: ToolDefinition = {
    id: "file_read",
    description:
      "Read and extract the TEXT of one file from the CEO's encrypted File Vault. " +
      "Input: { file } — a file id, exact name, or part of the name (e.g. \"resume\" or \"Gautam_SDE.pdf\"). " +
      "Supports text/markdown/csv/html, Word (.docx) and PDF. Use this to read the CEO's real résumé/CV or any document before working from it — never invent its contents.",
    sensitivity: "read",
    internal: true,
    scopes: ["files"],
    input: z.object({ file: z.string().min(1, "provide a file id or (part of) its name") }).passthrough(),
    handler: async (input, ctx) => {
      const ref = String((input as { file: string }).file);
      const files = store(ctx);
      const meta = findFile(files, ref);
      if (!meta) {
        const have = files.list().map((f) => f.name);
        return {
          error: `No file matching "${ref}".`,
          available: have.length ? have : undefined,
          note: have.length ? "Pick one of the available files by name." : "The vault is empty — ask the CEO to upload the file first.",
        };
      }
      const got = files.get(meta.id);
      if (!got) return { error: `"${meta.name}" couldn't be decrypted.` };
      const { text, quality, note } = extractText(got.data, meta.name, meta.type);
      if (quality === "none") {
        return { file: { id: meta.id, name: meta.name, type: meta.type }, extracted: false, note: note ?? "No readable text found." };
      }
      return {
        file: { id: meta.id, name: meta.name, type: meta.type, sizeKB: Math.max(1, Math.round(meta.size / 1024)) },
        extracted: true,
        quality,
        note,
        text,
      };
    },
  };

  return [fileList, fileRead];
}
