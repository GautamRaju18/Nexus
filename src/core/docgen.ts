/**
 * Zero-dependency document generators. The Document agent writes content as Markdown;
 * these turn it into real, openable files — PDF, Word (.docx), Excel (.xlsx), HTML,
 * Markdown, CSV, and plain text — with no external libraries (true to Nexus's
 * local-first, dependency-light design).
 *
 * Office files (.docx/.xlsx) are OOXML: small XML parts inside a ZIP. We hand-roll a
 * minimal STORED (uncompressed) ZIP writer with a CRC32, and minimal-but-valid XML that
 * opens in Word/Excel/Google Docs/LibreOffice. The PDF is a hand-built text PDF.
 */

// ── ZIP (stored / no compression) + CRC32 ──────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = (CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
  name: string;
  data: Buffer;
}
function zip(entries: ZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const crc = crc32(e.data);
    const size = e.data.length;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(0, 8); // method 0 = stored
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0x21, 12); // fixed date
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(size, 18);
    lh.writeUInt32LE(size, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    parts.push(lh, nameBuf, e.data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(size, 20);
    ch.writeUInt32LE(size, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([ch, nameBuf]));
    offset += 30 + nameBuf.length + size;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralBuf, eocd]);
}

// ── Markdown → blocks (a tiny subset: #/##/### headings, -/* bullets, --- rule) ──
export interface Block {
  type: "h1" | "h2" | "h3" | "p" | "li" | "hr";
  text: string;
}
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Strip inline emphasis markers so plain-text targets stay clean. */
const inline = (s: string) => s.replace(/\*\*(.+?)\*\*/g, "$1").replace(/\*(.+?)\*/g, "$1").replace(/`(.+?)`/g, "$1").replace(/!?\[(.*?)\]\((.*?)\)/g, "$1");

export function mdBlocks(src: string): Block[] {
  const out: Block[] = [];
  for (const raw of (src || "").replace(/\r/g, "").split("\n")) {
    const line = raw.trimEnd();
    const t = line.trim();
    if (!t) continue;
    if (/^###\s+/.test(line)) out.push({ type: "h3", text: inline(line.replace(/^###\s+/, "")) });
    else if (/^##\s+/.test(line)) out.push({ type: "h2", text: inline(line.replace(/^##\s+/, "")) });
    else if (/^#\s+/.test(line)) out.push({ type: "h1", text: inline(line.replace(/^#\s+/, "")) });
    else if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) out.push({ type: "hr", text: "" });
    else if (/^\s*[-*+]\s+/.test(line)) out.push({ type: "li", text: inline(line.replace(/^\s*[-*+]\s+/, "")) });
    else if (/^\s*\d+\.\s+/.test(line)) out.push({ type: "li", text: inline(line.replace(/^\s*\d+\.\s+/, "")) });
    else out.push({ type: "p", text: inline(line) });
  }
  return out;
}

// ── HTML ────────────────────────────────────────────────────────────────────────
export function toHtml(title: string, blocks: Block[]): Buffer {
  const body: string[] = [];
  let inList = false;
  const closeList = () => { if (inList) { body.push("</ul>"); inList = false; } };
  for (const b of blocks) {
    if (b.type === "li") { if (!inList) { body.push("<ul>"); inList = true; } body.push(`<li>${xml(b.text)}</li>`); continue; }
    closeList();
    if (b.type === "hr") body.push("<hr>");
    else if (b.type === "p") body.push(`<p>${xml(b.text)}</p>`);
    else body.push(`<${b.type}>${xml(b.text)}</${b.type}>`);
  }
  closeList();
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${xml(title)}</title>
<style>body{font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:760px;margin:48px auto;padding:0 20px;line-height:1.55;color:#1a1a1a}
h1{font-size:1.9em;border-bottom:2px solid #eee;padding-bottom:.2em}h2{font-size:1.4em;margin-top:1.4em}h3{font-size:1.15em}
hr{border:none;border-top:1px solid #ddd;margin:1.6em 0}li{margin:.25em 0}</style></head>
<body>${title ? `<h1>${xml(title)}</h1>` : ""}\n${body.join("\n")}\n</body></html>`;
  return Buffer.from(html, "utf8");
}

// ── DOCX (minimal WordprocessingML, direct run formatting — no styles part needed) ──
export function toDocx(title: string, blocks: Block[]): Buffer {
  const para = (text: string, opts: { size?: number; bold?: boolean } = {}) => {
    const sz = opts.size ?? 22; // half-points (22 = 11pt)
    const rpr = `<w:rPr>${opts.bold ? "<w:b/>" : ""}<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/></w:rPr>`;
    return `<w:p><w:pPr><w:spacing w:after="120"/></w:pPr><w:r>${rpr}<w:t xml:space="preserve">${xml(text)}</w:t></w:r></w:p>`;
  };
  const paras: string[] = [];
  if (title) paras.push(para(title, { size: 40, bold: true }));
  for (const b of blocks) {
    if (b.type === "h1") paras.push(para(b.text, { size: 34, bold: true }));
    else if (b.type === "h2") paras.push(para(b.text, { size: 28, bold: true }));
    else if (b.type === "h3") paras.push(para(b.text, { size: 24, bold: true }));
    else if (b.type === "hr") paras.push(`<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr></w:pPr></w:p>`);
    else if (b.type === "li") paras.push(para("•  " + b.text));
    else paras.push(para(b.text));
  }
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paras.join("")}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
  return zip([
    { name: "[Content_Types].xml", data: Buffer.from(contentTypes, "utf8") },
    { name: "_rels/.rels", data: Buffer.from(rels, "utf8") },
    { name: "word/document.xml", data: Buffer.from(documentXml, "utf8") },
  ]);
}

// ── XLSX (minimal SpreadsheetML, inline strings — no sharedStrings part needed) ──
export function toXlsx(rows: string[][]): Buffer {
  const colRef = (n: number) => {
    let s = "";
    n++;
    while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
    return s;
  };
  const rowXml = rows
    .map((cells, r) => {
      const cs = cells
        .map((val, c) => {
          const ref = `${colRef(c)}${r + 1}`;
          const num = val !== "" && !isNaN(Number(val)) && /^-?\d*\.?\d+$/.test(String(val).trim());
          return num
            ? `<c r="${ref}"><v>${xml(String(val).trim())}</v></c>`
            : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(String(val))}</t></is></c>`;
        })
        .join("");
      return `<row r="${r + 1}">${cs}</row>`;
    })
    .join("");
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowXml}</sheetData></worksheet>`;
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  return zip([
    { name: "[Content_Types].xml", data: Buffer.from(contentTypes, "utf8") },
    { name: "_rels/.rels", data: Buffer.from(rels, "utf8") },
    { name: "xl/workbook.xml", data: Buffer.from(workbook, "utf8") },
    { name: "xl/_rels/workbook.xml.rels", data: Buffer.from(wbRels, "utf8") },
    { name: "xl/worksheets/sheet1.xml", data: Buffer.from(sheet, "utf8") },
  ]);
}

// ── PDF (hand-built text PDF, Helvetica, multi-page) ────────────────────────────
function pdfEsc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)").replace(/[^\x20-\x7e]/g, "");
}
function wrap(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > maxChars && cur) { lines.push(cur); cur = w; }
    else cur = (cur ? cur + " " : "") + w;
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}
export function toPdf(title: string, blocks: Block[]): Buffer {
  const flow: { text: string; size: number; gap: number }[] = [];
  const add = (t: string, size: number, gap: number) => { for (const w of wrap(t, Math.floor(496 / (size * 0.5)))) flow.push({ text: w, size, gap }); };
  if (title) add(title, 20, 12);
  for (const b of blocks) {
    if (b.type === "h1") add(b.text, 16, 8);
    else if (b.type === "h2") add(b.text, 14, 7);
    else if (b.type === "h3") add(b.text, 12, 6);
    else if (b.type === "hr") flow.push({ text: "", size: 6, gap: 8 });
    else if (b.type === "li") add("•  " + b.text, 11, 4);
    else add(b.text, 11, 5);
  }
  const top = 740, bottom = 56, left = 56;
  const pages: { text: string; size: number; y: number }[][] = [];
  let cur: { text: string; size: number; y: number }[] = [];
  let y = top;
  for (const ln of flow) {
    const adv = ln.size + ln.gap;
    if (y - adv < bottom) { pages.push(cur); cur = []; y = top; }
    y -= adv;
    cur.push({ text: ln.text, size: ln.size, y });
  }
  if (cur.length) pages.push(cur);
  if (!pages.length) pages.push([{ text: "", size: 11, y: top }]);

  // Object numbers: 1 catalog, 2 pages, 3 font, then per page: content(4,6,…) page(5,7,…)
  const objs: string[] = [];
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  const kids: string[] = [];
  pages.forEach((page, i) => {
    const contentNum = 4 + i * 2;
    const pageNum = 5 + i * 2;
    let s = "BT\n";
    for (const c of page) {
      if (c.text === "") continue;
      s += `/F1 ${c.size} Tf\n1 0 0 1 ${left} ${c.y.toFixed(1)} Tm\n(${pdfEsc(c.text)}) Tj\n`;
    }
    s += "ET";
    objs[contentNum] = `<< /Length ${Buffer.byteLength(s, "latin1")} >>\nstream\n${s}\nendstream`;
    objs[pageNum] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentNum} 0 R >>`;
    kids.push(`${pageNum} 0 R`);
  });
  objs[2] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages.length} >>`;

  const maxNum = objs.length - 1;
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let n = 1; n <= maxNum; n++) {
    if (!objs[n]) continue;
    offsets[n] = Buffer.byteLength(pdf, "latin1");
    pdf += `${n} 0 obj\n${objs[n]}\nendobj\n`;
  }
  const xrefStart = Buffer.byteLength(pdf, "latin1");
  let xref = `xref\n0 ${maxNum + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxNum; n++) {
    xref += objs[n] ? `${String(offsets[n]).padStart(10, "0")} 00000 n \n` : `0000000000 00000 f \n`;
  }
  pdf += xref + `trailer\n<< /Size ${maxNum + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}

// ── Dispatcher ──────────────────────────────────────────────────────────────────
export type DocFormat = "pdf" | "docx" | "xlsx" | "html" | "md" | "csv" | "txt";
export const DOC_FORMATS: DocFormat[] = ["pdf", "docx", "xlsx", "html", "md", "csv", "txt"];
export const MIME: Record<DocFormat, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  html: "text/html",
  md: "text/markdown",
  csv: "text/csv",
  txt: "text/plain",
};

/** Parse simple CSV text into rows (handles quoted fields with commas/quotes). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cell); if (row.some((c) => c !== "")) rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); if (row.some((c) => c !== "")) rows.push(row); }
  return rows;
}

/** Generate a document. `content` is Markdown for prose formats, or CSV for csv/xlsx. */
export function generate(format: DocFormat, title: string, content: string): Buffer {
  switch (format) {
    case "txt": return Buffer.from((title ? title + "\n\n" : "") + content, "utf8");
    case "md": return Buffer.from((title ? `# ${title}\n\n` : "") + content, "utf8");
    case "csv": return Buffer.from(content, "utf8");
    case "html": return toHtml(title, mdBlocks(content));
    case "pdf": return toPdf(title, mdBlocks(content));
    case "docx": return toDocx(title, mdBlocks(content));
    case "xlsx": return toXlsx(parseCsv(content));
  }
}
