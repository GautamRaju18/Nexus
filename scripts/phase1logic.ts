/**
 * Phase 1 LOGIC check — exercises the new reminder/finance code paths WITHOUT
 * SQLite, so it runs even on Node < 22.5. Uses fake services (a Map-backed vault)
 * and a fake reminder store. Covers the parts most likely to harbor bugs: CSV
 * parsing, spend aggregation, reminder time-parsing, and scheduler firing/settling.
 */
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { financeTools } from "../src/core/tools-finance";
import { reminderTools } from "../src/core/tools-reminders";
import { Scheduler } from "../src/core/scheduler";
import type { Reminder } from "../src/core/reminders";

let fail = 0;
const check = (name: string, cond: boolean) => {
  console.log(`${cond ? "✓" : "✗"} ${name}`);
  if (!cond) fail++;
};

// ── Fakes ─────────────────────────────────────────────────────────────────────
function fakeCtx(agentId: string) {
  const store = new Map<string, string>();
  const reminders: Reminder[] = [];
  let n = 0;
  return {
    agentId,
    services: {
      vault: { get: (k: string) => store.get(k) ?? null, set: (k: string, v: string) => void store.set(k, v) },
      reminders: {
        add: (p: any) => {
          const r: Reminder = {
            id: `r${++n}`,
            text: p.text,
            dueAt: p.dueAt,
            recurrence: p.recurrence ?? null,
            agent: p.agent ?? null,
            status: "pending",
            createdAt: Date.now(),
            firedAt: null,
          };
          reminders.push(r);
          return r;
        },
        list: (o: any) => reminders.filter((r) => (o?.status && o.status !== "all" ? r.status === o.status : true)),
        cancel: (id: string) => {
          const r = reminders.find((x) => x.id === id);
          if (r) r.status = "cancelled";
          return !!r;
        },
      },
    },
    _reminders: reminders,
  } as any;
}

// ── Finance: CSV import + summary ───────────────────────────────────────────────
const fin = Object.fromEntries(financeTools().map((t) => [t.id, t]));
const csv = [
  "Date,Description,Amount,Category",
  "2026-06-01,Salary June,50000,Income",
  "2026-06-02,Swiggy order,-450,",
  '2026-06-03,"Amazon, India",-1200,',
  "2026-06-04,Netflix,-499,",
  "2026-06-05,Uber ride,-230,",
  "2026-06-06,Swiggy order,-300,",
].join("\n");
const csvPath = join(tmpdir(), `jarvis_phase1_${Date.now()}.csv`);
writeFileSync(csvPath, csv, "utf8");

const ctx = fakeCtx("finance");
const imp = (await fin.bank_import!.handler({ path: csvPath }, ctx)) as any;
check("CSV import parses all 6 rows", imp.imported === 6);

const imp2 = (await fin.bank_import!.handler({ path: csvPath }, ctx)) as any;
check("re-import dedupes (0 new)", imp2.imported === 0 && imp2.skipped === 6);

const sum = (await fin.bank_summary!.handler({}, ctx)) as any;
check("summary totalIn = 50000", sum.totalIn === 50000);
check("summary totalOut = 2679", sum.totalOut === 2679);
check("summary net = 47321", sum.net === 47321);
check("Food & Dining is a spend category (Swiggy auto-categorized)", sum.spendByCategory.some((c: any) => c.category === "Food & Dining" && c.spent === 750));
check("top merchant is Amazon (single 1200 charge)", sum.topMerchants[0]?.merchant === "Amazon, India" && sum.topMerchants[0]?.spent === 1200);

const monthSum = (await fin.bank_summary!.handler({ month: "2026-06" }, ctx)) as any;
check("month filter keeps all June rows", monthSum.transactions === 6);
const emptyMonth = (await fin.bank_summary!.handler({ month: "2025-01" }, ctx)) as any;
check("empty month returns a note, not totals", typeof emptyMonth.note === "string" && emptyMonth.totalIn === undefined);

const txns = (await fin.bank_transactions!.handler({ search: "swiggy" }, ctx)) as any;
check("transaction search finds both Swiggy rows", txns.count === 2);

// Quoted-comma field stayed intact through CSV parsing
const amazon = (await fin.bank_transactions!.handler({ search: "amazon" }, ctx)) as any;
check("quoted comma preserved: 'Amazon, India'", amazon.transactions[0]?.description === "Amazon, India");

rmSync(csvPath, { force: true });

// ── Reminders: time parsing ─────────────────────────────────────────────────────
const rem = Object.fromEntries(reminderTools().map((t) => [t.id, t]));
const rctx = fakeCtx("secretary");

const setMin = (await rem.reminder_set!.handler({ text: "drink water", inMinutes: 30 }, rctx)) as any;
check("reminder_set via inMinutes works", setMin.set === true && new Date(setMin.due).getTime() > Date.now());

const setIso = (await rem.reminder_set!.handler({ text: "standup", at: "2030-01-01T09:00:00Z", recurrence: "daily" }, rctx)) as any;
check("reminder_set via ISO + recurrence works", setIso.set === true && setIso.recurrence === "daily");

const badTime = (await rem.reminder_set!.handler({ text: "x", at: "not a date" }, rctx)) as any;
check("unparseable time is rejected", typeof badTime.error === "string");

const noTime = (await rem.reminder_set!.handler({ text: "x" }, rctx)) as any;
check("missing time is rejected", typeof noTime.error === "string");

// ── Scheduler: fires due, settles, isolates failures ────────────────────────────
function makeStore(initial: Reminder[]) {
  let store = [...initial];
  const fired: string[] = [];
  return {
    due: () => store.filter((r) => r.status === "pending" && r.dueAt <= Date.now()),
    markFired: (id: string) => {
      fired.push(id);
      store = store.map((r) => (r.id === id ? { ...r, status: "fired" as const } : r));
      return null;
    },
    _fired: fired,
  };
}
const now = Date.now();
const mk = (id: string, due: number): Reminder => ({ id, text: id, dueAt: due, recurrence: null, agent: null, status: "pending", createdAt: now, firedAt: null });

const s1 = makeStore([mk("a", now - 1000), mk("b", now + 600000)]);
const delivered: string[] = [];
const sched = new Scheduler(s1 as any, (r) => void delivered.push(r.id), 999999);
await (sched as any).tick();
check("scheduler delivers only the due reminder", delivered.length === 1 && delivered[0] === "a");
check("scheduler settles the fired reminder", s1._fired.length === 1 && s1._fired[0] === "a");

const s2 = makeStore([mk("c", now - 1000)]);
const sched2 = new Scheduler(
  s2 as any,
  () => {
    throw new Error("delivery boom");
  },
  999999,
);
await (sched2 as any).tick();
check("a throwing delivery still settles the reminder (no infinite re-fire)", s2._fired.length === 1);

console.log(fail === 0 ? "\nPHASE 1 LOGIC OK ✓" : `\n${fail} CHECK(S) FAILED ✗`);
process.exit(fail === 0 ? 0 : 1);
