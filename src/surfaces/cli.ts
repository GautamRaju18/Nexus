/**
 * The CLI surface — talk to your whole organization from the terminal.
 * Implements the Approver so outward actions pause for your sign-off right here.
 *
 * Slash commands:
 *   /agents       list the org
 *   /memory       show what Jarvis remembers
 *   /audit        recent actions (the trust log)
 *   /autonomy     view / set an agent's autonomy dial
 *   /kill         engage/release the kill switch (pause all autonomy)
 *   /brief        a quick status brief
 *   /help  /quit
 */

import { createInterface, type Interface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { bootstrap, type JarvisRuntime } from "../core/bootstrap";
import { AGENTS, AGENTS_BY_ID } from "../agents/specs";
import { AutonomyLevel, type ApprovalRequest, type Approver, type LLMMessage } from "../types";

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
};

class CliApprover implements Approver {
  constructor(private rl: Interface) {}

  async approve(req: ApprovalRequest): Promise<boolean> {
    console.log(c.yellow("\n  ⚠ APPROVAL NEEDED"));
    console.log(`  Agent:   ${AGENTS_BY_ID[req.agentId]?.name ?? req.agentId}`);
    console.log(`  Action:  ${req.toolId}  ${c.dim(`(${req.sensitivity})`)}`);
    console.log(`  Preview: ${req.preview}`);
    console.log(`  Reversible: ${req.reversible ? "yes" : c.red("no")}`);
    const ans = (await this.rl.question(c.yellow("  Approve? [y/N] "))).trim().toLowerCase();
    return ans === "y" || ans === "yes";
  }

  async ask(question: string): Promise<string> {
    return (await this.rl.question(c.cyan(`  ${question} `))).trim();
  }
}

async function main(): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });
  let rt: JarvisRuntime;
  try {
    rt = bootstrap((m) => console.log(c.dim(`  · ${m}`)));
  } catch (e) {
    console.error(c.red(`\nStartup failed: ${(e as Error).message}\n`));
    rl.close();
    process.exitCode = 1;
    return;
  }

  const approver = new CliApprover(rl);
  const orch = rt.buildOrchestrator(approver);

  console.log(c.bold("\n  JARVIS") + c.dim("  — your local AI Chief of Staff"));
  console.log(c.dim(`  brain: ${rt.llm.name}   memories: ${rt.memory.count()}   agents: ${AGENTS.length}`));
  if (rt.policy.isKilled()) console.log(c.red("  ⚠ kill switch is ENGAGED — outward actions are paused (/kill to release)"));
  console.log(c.dim("  Type an outcome, or /help. Ctrl+C to exit.\n"));

  // Rolling conversation history so Jarvis remembers the thread (e.g. a city you
  // just named in answer to "which city?"). Trimmed when passed to the model.
  const history: LLMMessage[] = [];

  while (true) {
    let line: string;
    try {
      line = (await rl.question(c.green("you ▸ "))).trim();
    } catch {
      break; // Ctrl+C / EOF
    }
    if (!line) continue;

    if (line.startsWith("/")) {
      const done = await handleCommand(line, rt, approver);
      if (done) break;
      continue;
    }

    try {
      const answer = await orch.handle(line, {
        history: history.slice(-8),
        onProgress: (m) => console.log(c.dim(`  · ${m}`)),
      });
      console.log(`\n${c.cyan("jarvis ▸")} ${answer}\n`);
      history.push({ role: "user", content: line }, { role: "assistant", content: answer });
    } catch (e) {
      console.log(c.red(`\n  Error: ${(e as Error).message}\n`));
    }
  }

  rl.close();
}

async function handleCommand(line: string, rt: JarvisRuntime, approver: Approver): Promise<boolean> {
  const [cmd, ...rest] = line.slice(1).split(/\s+/);
  const arg = rest.join(" ");

  switch (cmd) {
    case "quit":
    case "exit":
      console.log(c.dim("  bye."));
      return true;

    case "help":
      console.log(
        [
          "",
          "  /agents              list the organization",
          "  /connect             authorize Gmail + Calendar (Google)",
          "  /google              Google connection status (/google disconnect to revoke)",
          "  /memory              show long-term memory",
          "  /audit               recent actions (trust log)",
          "  /autonomy [id] [0-5] view or set an agent's autonomy",
          "  /kill                toggle the kill switch (pause all autonomy)",
          "  /brief               quick status",
          "  /quit                exit",
          "",
        ].join("\n"),
      );
      return false;

    case "agents": {
      const byDept = new Map<string, string[]>();
      for (const a of AGENTS) {
        const list = byDept.get(a.department) ?? [];
        list.push(`${c.bold(a.id.padEnd(14))} ${c.dim(a.purpose)}`);
        byDept.set(a.department, list);
      }
      console.log("");
      for (const [dept, list] of byDept) {
        console.log(`  ${c.cyan(dept.toUpperCase())}`);
        for (const l of list) console.log(`    ${l}`);
      }
      console.log("");
      return false;
    }

    case "memory": {
      const all = rt.memory.list();
      if (all.length === 0) console.log(c.dim("  (no memories yet — tell Jarvis things to remember)"));
      for (const m of all.slice(0, 40)) {
        console.log(
          `  ${c.bold(`[${m.layer}]`)} ${m.key}: ${m.content} ${c.dim(`(conf ${m.confidence.toFixed(2)}, via ${m.source})`)}`,
        );
      }
      console.log("");
      return false;
    }

    case "audit": {
      const entries = rt.audit.recent(20);
      if (entries.length === 0) console.log(c.dim("  (no actions logged yet)"));
      for (const e of entries) {
        const t = new Date(e.ts).toLocaleTimeString();
        const status = e.status === "ok" ? c.green(e.status) : c.yellow(e.status);
        console.log(`  ${c.dim(t)} ${e.actor.padEnd(14)} ${e.action.padEnd(22)} ${status} ${c.dim(e.detail)}`);
      }
      console.log("");
      return false;
    }

    case "autonomy": {
      const [id, lvl] = rest;
      if (!id) {
        console.log("");
        for (const a of AGENTS) {
          const level = rt.policy.autonomyFor(a);
          console.log(`  ${a.id.padEnd(14)} L${level} ${c.dim(`(ceiling L${a.autonomyCeiling})`)}`);
        }
        console.log("");
        return false;
      }
      const spec = AGENTS_BY_ID[id];
      if (!spec) {
        console.log(c.red(`  unknown agent: ${id}`));
        return false;
      }
      if (lvl === undefined) {
        console.log(`  ${id}: L${rt.policy.autonomyFor(spec)} (ceiling L${spec.autonomyCeiling})`);
        return false;
      }
      const n = Number(lvl);
      if (!Number.isInteger(n) || n < 0 || n > 5) {
        console.log(c.red("  level must be 0–5"));
        return false;
      }
      if (n > spec.autonomyCeiling) {
        console.log(c.red(`  ${id} is capped at L${spec.autonomyCeiling} for safety; cannot set L${n}.`));
        return false;
      }
      rt.policy.setAutonomy(id, n as AutonomyLevel);
      console.log(c.green(`  ${id} autonomy set to L${n}.`));
      return false;
    }

    case "kill": {
      const now = !rt.policy.isKilled();
      rt.policy.setKill(now);
      console.log(now ? c.red("  ⚠ kill switch ENGAGED — all outward actions paused.") : c.green("  kill switch released."));
      return false;
    }

    case "brief": {
      console.log(
        `\n  ${c.bold("Status")}  brain ${rt.llm.name} · ${rt.memory.count()} memories · ${AGENTS.length} agents · ` +
          `${rt.policy.isKilled() ? c.red("PAUSED") : c.green("active")}\n`,
      );
      // Let the Chief of Staff produce a real brief too.
      const orch = rt.buildOrchestrator(approver);
      const brief = await orch.handle("Give me a short status brief and ask what I'd like to get done.");
      console.log(`  ${brief}\n`);
      return false;
    }

    case "connect": {
      // Phase 1: authorize Google (Gmail + Calendar).
      if (!rt.google.isConfigured()) {
        console.log(
          c.yellow(
            "  Google isn't configured yet. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env\n  (see SETUP-GOOGLE.md), then run /connect again.",
          ),
        );
        return false;
      }
      try {
        await rt.google.connect((m) => console.log(c.dim(`  · ${m}`)));
        console.log(c.green("  Gmail + Calendar are now connected. Try: 'check my unread email' or 'what's on my calendar this week'."));
      } catch (e) {
        console.log(c.red(`  Connect failed: ${(e as Error).message}`));
      }
      return false;
    }

    case "google": {
      const cfgd = rt.google.isConfigured();
      const conn = rt.google.isConnected();
      console.log(
        `\n  Google: ${cfgd ? c.green("configured") : c.yellow("not configured (set GOOGLE_CLIENT_ID/SECRET in .env)")} · ` +
          `${conn ? c.green("connected ✓") : c.yellow("not connected (run /connect)")}\n`,
      );
      if (rest[0] === "disconnect") {
        rt.google.disconnect();
        console.log(c.green("  Disconnected — Google refresh token removed from your vault.\n"));
      }
      return false;
    }

    default:
      console.log(c.red(`  unknown command: /${cmd} (try /help)`));
      return false;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
