/**
 * Exercises all 23 agents with a representative task each. SAFE:
 *  - a deny-all approver, so no outward action (send/book/buy/post/create) executes;
 *  - reads (inbox, calendar, web) and reasoning/drafts run normally;
 *  - intended to be run against a COPY of the DB (see the npm/runner command).
 */
import { bootstrap } from "../src/core/bootstrap";
import { runAgent, type AgentDeps } from "../src/core/agent";
import { AGENTS } from "../src/agents/specs";
import type { Approver, ApprovalRequest } from "../src/types";

class DenyApprover implements Approver {
  async approve(req: ApprovalRequest): Promise<boolean> {
    console.log(`     ⛔ outward action auto-denied for test: ${req.toolId}`);
    return false;
  }
}

const TASKS: Record<string, string> = {
  "chief-of-staff": "In 2 sentences, how would you help me run my week as my chief of staff?",
  secretary: "What's the weather in Hyderabad right now, and note a reminder to call mom at 6pm.",
  calendar: "What's on my calendar over the next 7 days?",
  email: "Summarize my 5 most recent unread emails (sender + one-line gist each).",
  travel: "Suggest a 3-day Goa itinerary next month for a mid-range budget. Don't book anything.",
  booking: "Find a few dermatologist options in Hyderabad for this week (no booking).",
  shopping: "Compare 3 good wireless earbuds under 5000 rupees and recommend one (don't buy).",
  health: "I've been sleeping poorly lately. What should I track and what should I ask a doctor?",
  learning: "Give me a focused one-week plan to learn the basics of SQL.",
  career: "Briefly, how should I structure my MBA application process?",
  research: "Find the 3 biggest AI stories this week and summarize them.",
  pr: "Draft a short, punchy PR pitch for a fintech startup's seed round.",
  marketing: "Outline a one-week social content calendar for a new coffee brand.",
  social: "Write 3 LinkedIn post variants announcing a product launch (don't post).",
  recruitment: "Write a concise job description for a backend engineer.",
  operations: "Outline a simple month-end bookkeeping checklist for a small business.",
  support: "Draft a polite reply to a customer complaining about a late delivery.",
  events: "Plan a 20-person team offsite: a few venue ideas and a short run-of-show.",
  negotiation: "Give me a short script to negotiate 15% off with a SaaS vendor.",
  finance: "How should I think about budgeting on a monthly income of 1 lakh rupees?",
  legal: "Plainly explain the key clauses to watch in a freelance contract.",
  guardian: "Scan recent activity and memory for anything risky or unusual; report briefly.",
  librarian: "What do you know about me so far? Summarize my stored preferences.",
};

async function run(): Promise<void> {
  const rt = bootstrap(() => {});
  const deps: AgentDeps = {
    llm: rt.llm,
    tools: rt.tools,
    policy: rt.policy,
    audit: rt.audit,
    approver: new DenyApprover(),
    services: rt.services,
  };
  console.log(`Brain: ${rt.llm.name}  ·  Google connected: ${rt.google.isConnected()}\n`);

  const filter = (process.env.AGENT_FILTER ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const list = filter.length ? AGENTS.filter((a) => filter.includes(a.id)) : AGENTS;

  let pass = 0;
  let n = 0;
  for (const spec of list) {
    n++;
    const task = TASKS[spec.id] ?? "Briefly introduce your role and how you'd help.";
    console.log("─".repeat(72));
    console.log(`[${n}/${list.length}] ${spec.name}  (${spec.id})`);
    console.log(`  task: ${task}`);
    const t0 = Date.now();
    try {
      const res = await runAgent(spec, task, deps);
      const tools = rt.audit
        .recent(1000)
        .filter((e) => e.actor === spec.id && e.action.startsWith("tool:") && e.ts >= t0)
        .map((e) => e.action.replace("tool:", ""));
      const uniqTools = [...new Set(tools)];
      const ok = Boolean(res.message && res.message.trim().length > 10);
      if (ok) pass++;
      console.log(`  ${ok ? "✓" : "✗"}  ${((Date.now() - t0) / 1000).toFixed(1)}s · tools: ${uniqTools.join(", ") || "(reasoning only)"}`);
      console.log(`  → ${res.message.replace(/\s+/g, " ").trim().slice(0, 260)}`);
    } catch (e) {
      console.log(`  ✗ ERROR: ${(e as Error).message}`);
    }
  }
  console.log("─".repeat(72));
  console.log(`\nRESULT: ${pass}/${list.length} agents responded.\n`);
  process.exit(0);
}

run();
