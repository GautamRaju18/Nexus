/**
 * Multi-turn conversation test — reproduces the "weather → city follow-up" thread
 * from the screenshot to prove Jarvis now carries context across turns.
 * Run: npm run convotest
 */
import { bootstrap } from "../src/core/bootstrap";
import type { Approver, ApprovalRequest, LLMMessage } from "../src/types";

class AutoApprover implements Approver {
  async approve(_req: ApprovalRequest): Promise<boolean> {
    return true;
  }
}

const TURNS = [
  "hi whats the weather in hyd today",
  "what about the chance of rain and humidity there?",
];

async function run(): Promise<void> {
  const rt = bootstrap(() => {});
  console.log(`Brain: ${rt.llm.name}\n`);
  const orch = rt.buildOrchestrator(new AutoApprover());
  const history: LLMMessage[] = [];

  for (const turn of TURNS) {
    console.log("─".repeat(70));
    console.log(`CEO ▸ ${turn}`);
    const ans = await orch.handle(turn, {
      history: history.slice(-8),
      onProgress: (m) => console.log("   ·", m),
    });
    console.log(`JARVIS ▸ ${ans}\n`);
    history.push({ role: "user", content: turn }, { role: "assistant", content: ans });
  }

  console.log("─".repeat(70));
  console.log("AUDIT (weather tool calls — check the location it used):");
  for (const e of rt.audit.recent(12).reverse()) {
    if (e.action.includes("weather")) console.log(`   ${e.action}  ${e.detail}`);
  }
}

run().then(() => process.exit(0));
