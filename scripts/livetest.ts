/**
 * Live end-to-end test — drives the real orchestrator with the configured LLM
 * brain through a few outcomes, then shows what landed in memory and the audit log.
 * Uses a throwaway DB + master key so your real ./data/jarvis.db stays pristine.
 *
 * Run (PowerShell):
 *   $env:JARVIS_MASTER_KEY="livetest"; $env:JARVIS_DB_PATH="./data/livetest.db"; npm run livetest
 */
import { bootstrap } from "../src/core/bootstrap";
import type { Approver, ApprovalRequest } from "../src/types";

// During the test, auto-approve so any gated tool runs (and we can see it). In real
// use the CLI asks you. v1's built-in tools are read/internal, so this rarely fires.
class AutoApprover implements Approver {
  async approve(req: ApprovalRequest): Promise<boolean> {
    console.log(`   [auto-approved for test] ${req.agentId} → ${req.toolId}`);
    return true;
  }
}

const PROMPTS = [
  "hi",
  "What's the weather in Mumbai today?",
  "How should I structure my MBA application process?",
  "Research the 3 biggest fintech stories this week and summarize.",
];

async function run(): Promise<void> {
  const rt = bootstrap((m) => console.log("   ·", m));
  console.log(`\nBrain: ${rt.llm.name}\n`);
  const orch = rt.buildOrchestrator(new AutoApprover());

  for (const p of PROMPTS) {
    console.log("─".repeat(70));
    console.log(`CEO ▸ ${p}`);
    const t0 = Date.now();
    try {
      const answer = await orch.handle(p, (m) => console.log("   ·", m));
      console.log(`\nJARVIS ▸ ${answer}`);
    } catch (e) {
      console.log(`\n[error] ${(e as Error).message}`);
    }
    console.log(`   (${((Date.now() - t0) / 1000).toFixed(1)}s)\n`);
  }

  console.log("─".repeat(70));
  console.log("MEMORY captured:");
  for (const m of rt.memory.list()) {
    console.log(`   [${m.layer}] ${m.key}: ${m.content}`);
  }
  console.log("\nAUDIT (recent):");
  for (const e of rt.audit.recent(10).reverse()) {
    console.log(`   ${e.actor.padEnd(14)} ${e.action.padEnd(20)} ${e.status}  ${e.detail.slice(0, 50)}`);
  }
}

run().then(() => process.exit(0));
