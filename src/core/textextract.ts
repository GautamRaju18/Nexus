/**
 * Zero-dependency text extraction. Pulls readable text out of the file types the CEO
 * actually uploads — plain text/markdown/csv, HTML, Word (.docx), and PDF — using only
 * Node built-ins (zlib for the compressed formats). True to Nexus's local-first,
 * dependency-light design: a file's contents never leave the machine to be "read".
 *
 * Office/PDF extraction is best-effort by nature (especially scanned PDFs, which are
 * images and carry no text). Each result carries a `quality` flag so a tool can be
 * honest with the agent when little or nothing could be recovered.
 */

import zlib from "node:zlib";

const MAX_CHARS = 60_000; // plenty for a résumé / cover letter; keeps the model prompt sane

export type ExtractQuality = "full" | "partial" | "none";
export interface Extracted {
  text: string;
  quality: ExtractQuality;
  note?: string;
}

export function extractText(buf: Buffer, name = "", type = ""): Extracted {
  const n = name.toLowerCase();
  const head = buf.subarray(0, 8).toString("latin1");
  const isPdf = /pdf/.test(type) || n.endsWith(".pdf") || head.startsWith("%PDF-");
  const isZip = head.startsWith("PK\x03\x04");
  const isDocx = n.endsWith(".docx") || /wordprocessingml/.test(type) || (isZip && /\.docx$/.test(n));

  if (isDocx || (isZip && /officedocument/.test(type))) return extractDocx(buf);
  if (isPdf) return extractPdf(buf);

  const textLike =
    /^text\//.test(type) ||
    /(json|xml|html|csv|markdown)/.test(type) ||
    /\.(txt|text|md|markdown|csv|tsv|json|log|ya?ml|xml|html?|ini|conf)$/.test(n) ||
    looksTextual(buf);
  if (textLike) {
    let t = buf.toString("utf8");
    if (/\.(html?|xml)$/.test(n) || /(html|xml)/.test(type)) t = stripTags(t);
    return clip(t, t.trim() ? "full" : "none");
  }
  return { text: "", quality: "none", note: `Can't extract text from this file type (${type || "unknown"}).` };
}

// ── helpers ─────────────────────────────────────────────────────────────────
function clip(t: string, quality: ExtractQuality): Extracted {
  const cleaned = t.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (cleaned.length <= MAX_CHARS) return { text: cleaned, quality };
  return { text: cleaned.slice(0, MAX_CHARS), quality, note: `Truncated to first ${MAX_CHARS} characters.` };
}

/** Sample the first bytes — if almost everything is printable, treat it as text. */
function looksTextual(buf: Buffer): boolean {
  const len = Math.min(buf.length, 4096);
  if (len === 0) return false;
  let printable = 0;
  for (let i = 0; i < len; i++) {
    const b = buf[i]!;
    if (b === 9 || b === 10 || b === 13 || (b >= 32 && b <= 126) || b >= 160) printable++;
  }
  return printable / len > 0.85;
}

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|li|tr|h[1-6]|br)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

// ── DOCX (OOXML: word/document.xml inside a ZIP) ──────────────────────────────
function extractDocx(buf: Buffer): Extracted {
  const xml = unzipEntry(buf, "word/document.xml");
  if (!xml) return { text: "", quality: "none", note: "Couldn't read the Word document body." };
  const s = xml.toString("utf8");
  const text = s
    .replace(/<w:tab\b[^>]*\/>/g, "\t")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<w:br\b[^>]*\/>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
  return clip(text, text.trim() ? "full" : "none");
}

/** Find one entry in a ZIP by name via local-file-header scan; inflate if deflated. */
function unzipEntry(buf: Buffer, want: string): Buffer | null {
  let i = 0;
  while (i + 30 <= buf.length) {
    if (buf.readUInt32LE(i) !== 0x04034b50) {
      // Reached the central directory or junk — stop scanning local headers.
      if (buf.readUInt32LE(i) === 0x02014b50) break;
      i++;
      continue;
    }
    const method = buf.readUInt16LE(i + 8);
    const compSize = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const nameStart = i + 30;
    const name = buf.subarray(nameStart, nameStart + nameLen).toString("latin1");
    const dataStart = nameStart + nameLen + extraLen;
    if (name === want) {
      const data = compSize > 0 ? buf.subarray(dataStart, dataStart + compSize) : buf.subarray(dataStart);
      if (method === 0) return data;
      try {
        return zlib.inflateRawSync(data);
      } catch {
        return null;
      }
    }
    if (compSize > 0) i = dataStart + compSize;
    else i = dataStart; // unknown size (data descriptor) — fall back to byte scan
  }
  return null;
}

// ── PDF (best-effort: inflate content streams, pull text-show operators) ───────
function extractPdf(buf: Buffer): Extracted {
  const s = buf.toString("latin1");
  const pieces: string[] = [];
  let from = 0;
  for (;;) {
    const st = s.indexOf("stream", from);
    if (st === -1) break;
    const en = s.indexOf("endstream", st);
    if (en === -1) break;
    let dStart = st + 6;
    if (s[dStart] === "\r") dStart++;
    if (s[dStart] === "\n") dStart++;
    const raw = buf.subarray(dStart, en);
    let decoded: string;
    try {
      decoded = zlib.inflateSync(raw).toString("latin1");
    } catch {
      try {
        decoded = zlib.inflateRawSync(raw).toString("latin1");
      } catch {
        decoded = raw.toString("latin1");
      }
    }
    if (decoded.includes("Tj") || decoded.includes("TJ")) pieces.push(pdfShowText(decoded));
    from = en + 9;
  }
  const text = pieces.join("\n");
  const cleaned = text.replace(/[ \t]{2,}/g, " ").trim();
  if (cleaned.length > 200) return clip(cleaned, "full");
  if (cleaned.length > 0) return clip(cleaned, "partial");
  return {
    text: "",
    quality: "none",
    note: "No selectable text found — this PDF is likely scanned (an image). Paste the text and I'll use it.",
  };
}

/**
 * Walk a decoded content stream, collecting text from (…)Tj and […]TJ show operators.
 * In TJ arrays the numbers between strings are horizontal kerning (in -1/1000 em); a
 * large negative gap is how many PDFs render a SPACE, so we reconstruct word breaks
 * from gaps below a threshold (small kerning tweaks are ignored).
 */
const TJ_SPACE_GAP = 120; // |adjustment| above this ≈ a word space, not letter kerning

function pdfShowText(content: string): string {
  let out = "";
  const n = content.length;
  let i = 0;

  // Read a PDF literal string starting AT the opening "(", return [text, indexAfter")"].
  const readString = (start: number): [string, number] => {
    let depth = 1;
    let j = start + 1;
    let str = "";
    while (j < n && depth > 0) {
      const c = content[j]!;
      if (c === "\\") {
        const nx = content[j + 1]!;
        if (nx === "n") str += "\n";
        else if (nx === "t") str += "\t";
        else if (nx === "r") {
          /* drop */
        } else if (nx >= "0" && nx <= "7") {
          let oct = nx;
          let k = j + 2;
          while (k < n && content[k]! >= "0" && content[k]! <= "7" && oct.length < 3) oct += content[k++]!;
          str += String.fromCharCode(parseInt(oct, 8));
          j = k;
          continue;
        } else str += nx;
        j += 2;
      } else if (c === "(") {
        depth++;
        str += c;
        j++;
      } else if (c === ")") {
        depth--;
        if (depth > 0) str += c;
        j++;
      } else {
        str += c;
        j++;
      }
    }
    return [str, j];
  };

  while (i < n) {
    const ch = content[i]!;
    if (ch === "[") {
      // TJ array: alternating strings and kerning numbers until "]".
      i++;
      while (i < n && content[i] !== "]") {
        const c = content[i]!;
        if (c === "(") {
          const [str, j] = readString(i);
          out += str;
          i = j;
        } else if (c === "-" || c === "." || (c >= "0" && c <= "9")) {
          let num = "";
          while (i < n && (content[i] === "-" || content[i] === "." || (content[i]! >= "0" && content[i]! <= "9"))) num += content[i++]!;
          if (Math.abs(parseFloat(num)) >= TJ_SPACE_GAP && !out.endsWith(" ")) out += " ";
        } else i++;
      }
      i++; // skip "]"
    } else if (ch === "(") {
      const [str, j] = readString(i);
      out += str;
      i = j;
    } else if (ch === "T" && (content[i + 1] === "*" || content[i + 1] === "d" || content[i + 1] === "D")) {
      out += "\n"; // new text line / positioned move → break
      i += 2;
    } else if (ch === "'" || ch === '"') {
      out += "\n";
      i++;
    } else {
      i++;
    }
  }
  return out;
}
