/**
 * Runs the revised agents on a DB copy with a deny-all approver and writes their FULL
 * replies to ./data/qa.json — so a verification pass can judge complete outputs, not the
 * truncated previews agenttest prints. AGENT_FILTER controls which agents run.
 */
import { writeFileSync } from "node:fs";
import { bootstrap } from "../src/core/bootstrap";
import { runAgent, type AgentDeps } from "../src/core/agent";
import { AGENTS } from "../src/agents/specs";
import type { Approver, ApprovalRequest } from "../src/types";

class DenyApprover implements Approver {
  async approve(_req: ApprovalRequest): Promise<boolean> {
    return false;
  }
}

const TASKS: Record<string, string> = {
  learning: "Give me a focused one-week plan to learn the basics of SQL.",
  career: "Briefly, how should I structure my MBA application process?",
  research: "Find the 3 biggest AI stories this week and summarize them.",
  pr: "Draft a short, punchy PR pitch for a fintech startup's seed round.",
  marketing: "Outline a one-week social content calendar for a new coffee brand.",
  social: "Write 3 LinkedIn post variants announcing a product launch (don't post).",
  recruitment: "Write a concise job description for a backend engineer.",
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
  const filter = (process.env.AGENT_FILTER ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const list = AGENTS.filter((a) => (filter.length ? filter.includes(a.id) : !!TASKS[a.id]));
  const out: { id: string; name: string; task: string; reply: string }[] = [];
  for (const spec of list) {
    const task = TASKS[spec.id] ?? "Briefly introduce your role.";
    try {
      const res = await runAgent(spec, task, deps);
      out.push({ id: spec.id, name: spec.name, task, reply: res.message });
      console.log(`done: ${spec.id} (${res.message.length} chars)`);
    } catch (e) {
      out.push({ id: spec.id, name: spec.name, task, reply: `ERROR: ${(e as Error).message}` });
      console.log(`error: ${spec.id}`);
    }
  }
  writeFileSync("./data/qa.json", JSON.stringify(out, null, 2));
  console.log(`wrote ./data/qa.json (${out.length} agents)`);
  process.exit(0);
}

run();
