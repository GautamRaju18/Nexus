/**
 * Phase 1 wiring check (offline — no Google calls, no LLM).
 * Confirms the Gmail/Calendar tools are registered, granted to the right agents,
 * and that the OAuth config gate behaves.
 */
import { bootstrap } from "../src/core/bootstrap";
import { AGENTS_BY_ID } from "../src/agents/specs";

let fail = 0;
const check = (name: string, cond: boolean) => {
  console.log(`${cond ? "✓" : "✗"} ${name}`);
  if (!cond) fail++;
};

const rt = bootstrap(() => {});

const toolIds = rt.tools.all().map((t) => t.id);
check("gmail tools registered", ["gmail_list", "gmail_read", "gmail_draft", "gmail_send"].every((id) => toolIds.includes(id)));
check("calendar tools registered", ["gcal_list", "gcal_create", "gcal_update"].every((id) => toolIds.includes(id)));
check("reminder tools registered", ["reminder_set", "reminder_list", "reminder_cancel"].every((id) => toolIds.includes(id)));
check("finance tools registered", ["bank_import", "bank_summary", "bank_transactions"].every((id) => toolIds.includes(id)));

const email = AGENTS_BY_ID["email"]!;
const cal = AGENTS_BY_ID["calendar"]!;
const secretary = AGENTS_BY_ID["secretary"]!;
const finance = AGENTS_BY_ID["finance"]!;
check("Email agent has gmail_send (comms)", email.tools.includes("gmail_send"));
check("Calendar agent has gcal_create (write)", cal.tools.includes("gcal_create"));
check("Secretary has reminder_set", secretary.tools.includes("reminder_set"));
check("Finance has bank_import + bank_summary", finance.tools.includes("bank_import") && finance.tools.includes("bank_summary"));

// Sensitivity → gating expectations
check("gmail_send is 'comms'", rt.tools.get("gmail_send")!.sensitivity === "comms");
check("gmail_read is 'read'", rt.tools.get("gmail_read")!.sensitivity === "read");
check("gcal_create is 'write'", rt.tools.get("gcal_create")!.sensitivity === "write");

// Policy: at default L2, send needs approval; read is allowed
const sendDecision = rt.policy.decide(email, rt.tools.get("gmail_send")!).decision;
const readDecision = rt.policy.decide(email, rt.tools.get("gmail_read")!).decision;
check("gmail_send gated (approve) at default autonomy", sendDecision === "approve");
check("gmail_read allowed", readDecision === "allow");

// Reminders & finance are internal (own store) → always allowed even at default autonomy.
check("reminder_set runs without approval (internal)", rt.policy.decide(secretary, rt.tools.get("reminder_set")!).decision === "allow");
check("bank_import runs without approval (internal)", rt.policy.decide(finance, rt.tools.get("bank_import")!).decision === "allow");
check("bank_summary is read-only", rt.tools.get("bank_summary")!.sensitivity === "read");

// Reminder round-trip: set one in the past, scheduler-style due() finds it, markFired clears it.
const r = rt.reminders.add({ text: "phase1 test nudge", dueAt: Date.now() - 1000 });
check("reminder is due immediately", rt.reminders.due().some((x) => x.id === r.id));
rt.reminders.markFired(r.id);
check("fired reminder no longer due", !rt.reminders.due().some((x) => x.id === r.id));
rt.reminders.cancel(rt.reminders.add({ text: "to cancel", dueAt: Date.now() + 60000 }).id);
check("a recurring reminder reschedules instead of clearing", (() => {
  const rec = rt.reminders.add({ text: "daily standup", dueAt: Date.now() - 1000, recurrence: "daily" });
  const next = rt.reminders.markFired(rec.id);
  return next !== null && next > Date.now();
})());

// OAuth config gate
check("google not configured without creds", rt.google.isConfigured() === Boolean(rt.cfg.googleClientId && rt.cfg.googleClientSecret));
check("google not connected initially", rt.google.isConnected() === false);

let threw = false;
try {
  await rt.google.connect(() => {});
} catch {
  threw = true;
}
// If creds are absent it must throw a clear "configure first" error; if present, it would open a browser (skip).
check("connect() guards on missing config", rt.google.isConfigured() ? true : threw);

console.log(fail === 0 ? "\nPHASE 1 WIRING OK ✓" : `\n${fail} CHECK(S) FAILED ✗`);
process.exit(fail === 0 ? 0 : 1);
