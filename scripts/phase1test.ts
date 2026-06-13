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

const email = AGENTS_BY_ID["email"]!;
const cal = AGENTS_BY_ID["calendar"]!;
check("Email agent has gmail_send (comms)", email.tools.includes("gmail_send"));
check("Calendar agent has gcal_create (write)", cal.tools.includes("gcal_create"));

// Sensitivity → gating expectations
check("gmail_send is 'comms'", rt.tools.get("gmail_send")!.sensitivity === "comms");
check("gmail_read is 'read'", rt.tools.get("gmail_read")!.sensitivity === "read");
check("gcal_create is 'write'", rt.tools.get("gcal_create")!.sensitivity === "write");

// Policy: at default L2, send needs approval; read is allowed
const sendDecision = rt.policy.decide(email, rt.tools.get("gmail_send")!).decision;
const readDecision = rt.policy.decide(email, rt.tools.get("gmail_read")!).decision;
check("gmail_send gated (approve) at default autonomy", sendDecision === "approve");
check("gmail_read allowed", readDecision === "allow");

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
