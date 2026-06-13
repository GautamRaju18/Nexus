/**
 * Finance tools for the Finance Agent — read-only money awareness, ₹0 to run.
 *
 * v1 ingests a bank/card CSV export (the universal no-API path) and stores the
 * parsed transactions AES-256-GCM ENCRYPTED in the vault. Everything else is
 * aggregation over that local data:
 *
 *   bank_import       — parse a CSV file of transactions into the encrypted store
 *   bank_summary      — totals, net, spend-by-category, top merchants (optional month)
 *   bank_transactions — list/filter transactions (month, category, text search)
 *
 * There is deliberately NO "move money" tool — moving money is always a human
 * action (see the Finance agent's prompt and the policy gate). This is read-only.
 */

import { readFileSync } from "node:fs";
import { z } from "zod";
import type { ToolContext, ToolDefinition } from "../types";

const TXN_KEY = "finance_transactions";

interface Txn {
  date: string; // ISO date (YYYY-MM-DD) when parseable, else the raw cell
  description: string;
  amount: number; // + = money in (credit), − = money out (debit)
  category: string;
}

function readTxns(ctx: ToolContext): Txn[] {
  try {
    const raw = ctx.services.vault.get(TXN_KEY);
    const a = raw ? JSON.parse(raw) : [];
    return Array.isArray(a) ? (a as Txn[]) : [];
  } catch {
    return [];
  }
}
function writeTxns(ctx: ToolContext, txns: Txn[]): void {
  ctx.services.vault.set(TXN_KEY, JSON.stringify(txns));
}

// ── CSV parsing ───────────────────────────────────────────────────────────────
/** Parse CSV text into rows of cells. Handles quoted fields, escaped quotes, CRLF. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else cell += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    if (row.some((c) => c.trim() !== "")) rows.push(row);
  }
  return rows;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/[^a-z]/g, "");

/** Find the index of the first header that matches any of the given aliases. */
function col(headers: string[], aliases: string[]): number {
  const H = headers.map(norm);
  for (const a of aliases) {
    const idx = H.indexOf(norm(a));
    if (idx >= 0) return idx;
  }
  return -1;
}

function toIsoDate(raw: string): string {
  const s = raw.trim();
  const ms = Date.parse(s);
  if (!Number.isNaN(ms)) return new Date(ms).toISOString().slice(0, 10);
  // dd/mm/yyyy or dd-mm-yyyy → ISO (common in Indian/EU bank exports)
  const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (m) {
    const [, d, mo, y] = m;
    const year = y!.length === 2 ? `20${y}` : y;
    return `${year}-${mo!.padStart(2, "0")}-${d!.padStart(2, "0")}`;
  }
  return s;
}

/** Parse a money cell: strips currency symbols/commas, treats (123) as −123. */
function parseAmount(raw: string): number | null {
  let s = raw.trim().replace(/[₹$€£,\s]/g, "");
  if (!s) return null;
  let sign = 1;
  if (/^\(.*\)$/.test(s)) {
    sign = -1;
    s = s.slice(1, -1);
  }
  const n = Number(s);
  return Number.isFinite(n) ? sign * n : null;
}

// Light, transparent keyword categorization for rows without a category column.
const CATEGORY_RULES: [RegExp, string][] = [
  [/uber|ola|lyft|metro|irctc|fuel|petrol|diesel|shell|bpcl|hpcl/i, "Transport"],
  [/swiggy|zomato|restaurant|cafe|coffee|starbucks|mcdonald|domino|pizza|food/i, "Food & Dining"],
  [/amazon|flipkart|myntra|store|mart|retail|shop/i, "Shopping"],
  [/netflix|spotify|prime|hotstar|youtube|subscription|membership/i, "Subscriptions"],
  [/electricity|water|gas bill|broadband|airtel|jio|vodafone|wifi|utility/i, "Utilities"],
  [/rent|landlord|maintenance/i, "Housing"],
  [/salary|payroll|stipend|interest|dividend|refund|cashback/i, "Income"],
  [/pharmacy|hospital|clinic|apollo|medical|doctor|health/i, "Health"],
  [/atm|cash withdrawal/i, "Cash"],
];

function categorize(description: string, amount: number): string {
  for (const [re, cat] of CATEGORY_RULES) if (re.test(description)) return cat;
  return amount > 0 ? "Income" : "Uncategorized";
}

const monthOf = (isoDate: string) => isoDate.slice(0, 7); // YYYY-MM

export function financeTools(): ToolDefinition[] {
  const bankImport: ToolDefinition = {
    id: "bank_import",
    description:
      "Import bank/card transactions from a local CSV file into the encrypted finance store. " +
      "Input: { path } — an absolute path to a CSV exported from your bank. Recognizes columns named " +
      "Date, Description/Narration/Details, Amount (or separate Debit/Credit), and Category if present. " +
      "Adds only new rows (dedupes by date+description+amount). Read-only with respect to your bank — it just reads the file.",
    sensitivity: "write",
    internal: true,
    scopes: ["finance"],
    input: z.object({ path: z.string().min(1, "provide the path to a CSV file") }).passthrough(),
    handler: async (input, ctx) => {
      const path = (input as { path?: string; file?: string }).path || (input as { file?: string }).file;
      if (!path) return { error: "provide the path to a CSV file" };
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch (e) {
        return { error: `couldn't read file: ${(e as Error).message}` };
      }
      const rows = parseCsv(text);
      if (rows.length < 2) return { error: "the CSV has no data rows" };

      const headers = rows[0]!;
      const di = col(headers, ["date", "transaction date", "txn date", "value date", "posted date"]);
      const desi = col(headers, ["description", "narration", "details", "particulars", "transaction", "memo", "merchant", "name"]);
      const ai = col(headers, ["amount", "transaction amount", "value"]);
      const debiti = col(headers, ["debit", "withdrawal", "withdrawal amt", "dr"]);
      const crediti = col(headers, ["credit", "deposit", "deposit amt", "cr"]);
      const cati = col(headers, ["category", "type", "tag"]);

      if (di < 0 || desi < 0 || (ai < 0 && debiti < 0 && crediti < 0)) {
        return {
          error:
            "couldn't find the expected columns. Need a Date column, a Description/Narration column, and either an Amount column or Debit/Credit columns.",
          headersFound: headers,
        };
      }

      const existing = readTxns(ctx);
      const seen = new Set(existing.map((t) => `${t.date}|${t.description}|${t.amount}`));
      const added: Txn[] = [];
      let skipped = 0;

      for (const r of rows.slice(1)) {
        const description = (r[desi] ?? "").trim();
        let amount: number | null = null;
        if (ai >= 0) amount = parseAmount(r[ai] ?? "");
        if (amount === null && (debiti >= 0 || crediti >= 0)) {
          const dr = debiti >= 0 ? parseAmount(r[debiti] ?? "") : null;
          const cr = crediti >= 0 ? parseAmount(r[crediti] ?? "") : null;
          if (cr) amount = Math.abs(cr);
          else if (dr) amount = -Math.abs(dr);
        }
        if (amount === null || !description) {
          skipped++;
          continue;
        }
        const date = toIsoDate(r[di] ?? "");
        const category = cati >= 0 && (r[cati] ?? "").trim() ? (r[cati] ?? "").trim() : categorize(description, amount);
        const key = `${date}|${description}|${amount}`;
        if (seen.has(key)) {
          skipped++;
          continue;
        }
        seen.add(key);
        added.push({ date, description, amount, category });
      }

      const next = [...existing, ...added].sort((a, b) => a.date.localeCompare(b.date));
      writeTxns(ctx, next);
      return {
        imported: added.length,
        skipped,
        total: next.length,
        note: added.length
          ? `Imported ${added.length} new transaction(s). Use bank_summary to see where the money went.`
          : "No new transactions (everything was already imported).",
      };
    },
  };

  const bankSummary: ToolDefinition = {
    id: "bank_summary",
    description:
      "Summarize the imported transactions: total in, total out, net, and a spend-by-category breakdown with top merchants. " +
      "Optional { month: 'YYYY-MM' } to scope to one month. Read-only.",
    sensitivity: "read",
    internal: true,
    scopes: ["finance"],
    input: z.object({}).passthrough(),
    handler: async (input, ctx) => {
      const month = (input as { month?: string }).month?.trim();
      let txns = readTxns(ctx);
      if (!txns.length) return { note: "No transactions imported yet — use bank_import on a bank CSV first." };
      if (month) txns = txns.filter((t) => monthOf(t.date) === month);
      if (!txns.length) return { note: `No transactions for ${month}.`, months: [...new Set(readTxns(ctx).map((t) => monthOf(t.date)))].sort() };

      let income = 0;
      let spend = 0;
      const byCategory: Record<string, number> = {};
      const merchantSpend: Record<string, number> = {};
      for (const t of txns) {
        if (t.amount >= 0) income += t.amount;
        else {
          spend += -t.amount;
          byCategory[t.category] = (byCategory[t.category] ?? 0) + -t.amount;
          merchantSpend[t.description] = (merchantSpend[t.description] ?? 0) + -t.amount;
        }
      }
      const round = (n: number) => Math.round(n * 100) / 100;
      const spendByCategory = Object.entries(byCategory)
        .sort((a, b) => b[1] - a[1])
        .map(([category, amt]) => ({ category, spent: round(amt) }));
      const topMerchants = Object.entries(merchantSpend)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([merchant, amt]) => ({ merchant, spent: round(amt) }));

      return {
        scope: month ?? "all time",
        transactions: txns.length,
        totalIn: round(income),
        totalOut: round(spend),
        net: round(income - spend),
        spendByCategory,
        topMerchants,
      };
    },
  };

  const bankTransactions: ToolDefinition = {
    id: "bank_transactions",
    description:
      "List imported transactions, newest first. Optional filters: { month: 'YYYY-MM', category, search (text in description), limit }. Read-only.",
    sensitivity: "read",
    internal: true,
    scopes: ["finance"],
    input: z.object({}).passthrough(),
    handler: async (input, ctx) => {
      const i = input as { month?: string; category?: string; search?: string; limit?: number };
      let txns = readTxns(ctx);
      if (!txns.length) return { note: "No transactions imported yet — use bank_import on a bank CSV first." };
      if (i.month) txns = txns.filter((t) => monthOf(t.date) === i.month!.trim());
      if (i.category) txns = txns.filter((t) => t.category.toLowerCase() === i.category!.trim().toLowerCase());
      if (i.search) {
        const q = i.search.toLowerCase();
        txns = txns.filter((t) => t.description.toLowerCase().includes(q));
      }
      const limit = Math.min(typeof i.limit === "number" ? i.limit : 25, 200);
      const sorted = [...txns].sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit);
      return { transactions: sorted, count: sorted.length, totalMatching: txns.length };
    },
  };

  return [bankImport, bankSummary, bankTransactions];
}
