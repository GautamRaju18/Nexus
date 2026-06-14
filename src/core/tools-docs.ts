/**
 * Document generation for the Document agent. The agent WRITES the content (as Markdown
 * for prose; as CSV for spreadsheets), then calls make_document to render a real file —
 * PDF, Word, Excel, HTML, Markdown, CSV, or text — straight into the user's encrypted
 * File Vault, where it appears for download. No external services, no API cost.
 *
 * It's `internal` (writes only to the user's own local vault, reversible) so it runs
 * without an approval gate, like notes and reminders.
 */

import { z } from "zod";
import type { ToolDefinition } from "../types";
import { FileStore } from "./filestore";
import { generate, DOC_FORMATS, MIME, type DocFormat } from "./docgen";

const FORMAT_ALIASES: Record<string, DocFormat> = {
  pdf: "pdf",
  word: "docx", doc: "docx", docx: "docx",
  excel: "xlsx", xls: "xlsx", xlsx: "xlsx", spreadsheet: "xlsx", sheet: "xlsx",
  html: "html", web: "html",
  md: "md", markdown: "md",
  csv: "csv",
  txt: "txt", text: "txt", plain: "txt",
};

function safeName(name: string, ext: string): string {
  let base = (name || "document").replace(/\.[a-z0-9]{1,5}$/i, "").replace(/[^\w \-]+/g, "").trim().slice(0, 60) || "document";
  return `${base}.${ext}`;
}

export function docTools(): ToolDefinition[] {
  const makeDocument: ToolDefinition = {
    id: "make_document",
    description:
      "Generate a real, downloadable file in the user's File Vault. Input: { format, title, content, filename? }. " +
      "format ∈ pdf | docx (Word) | xlsx (Excel) | html | md | csv | txt. " +
      "For pdf/docx/html/md/txt, write `content` as MARKDOWN (use #, ##, ### for headings, - for bullets). " +
      "For xlsx/csv, write `content` as CSV (comma-separated, one row per line; first row = headers). " +
      "Write the COMPLETE document content yourself — never placeholders. The file is saved to the vault and the user can download it.",
    sensitivity: "write",
    internal: true,
    scopes: ["files"],
    input: z
      .object({
        format: z.string().min(1, "format is required (pdf, docx, xlsx, html, md, csv, txt)"),
        title: z.string().optional(),
        content: z.string().min(1, "content is required — write the full document"),
        filename: z.string().optional(),
      })
      .passthrough(),
    handler: async (input, ctx) => {
      const i = input as { format: string; title?: string; content: string; filename?: string };
      const fmt = FORMAT_ALIASES[String(i.format || "").toLowerCase().trim()];
      if (!fmt) return { error: `unknown format "${i.format}". Use one of: ${DOC_FORMATS.join(", ")}.` };
      const title = (i.title || "").trim();
      const content = i.content || "";
      if (!content.trim()) return { error: "content is empty — write the full document body" };

      let bytes: Buffer;
      try {
        bytes = generate(fmt, title, content);
      } catch (e) {
        return { error: `failed to render ${fmt}: ${(e as Error).message}` };
      }

      const name = safeName(i.filename || title || "document", fmt);
      try {
        const files = new FileStore(ctx.services.vault, ctx.services.kv);
        const meta = files.save(name, MIME[fmt], bytes.toString("base64"));
        return {
          created: true,
          file: { id: meta.id, name: meta.name, size: meta.size, type: meta.type },
          note: `Created "${meta.name}" (${fmt.toUpperCase()}, ${Math.max(1, Math.round(meta.size / 1024))} KB) — it's in your File Vault, ready to download.`,
        };
      } catch (e) {
        return { error: `couldn't save to vault: ${(e as Error).message}` };
      }
    },
  };

  return [makeDocument];
}
