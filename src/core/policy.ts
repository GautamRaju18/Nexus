/**
 * The policy / autonomy gate. Before ANY tool runs, the agent runtime asks the
 * policy engine what's allowed. This is where "draft-only by default", spending
 * limits, and the kill switch live.
 *
 * Decision values:
 *   "allow"   — run it now, just log it (read-only, or within an earned rule).
 *   "approve" — pause and require explicit human sign-off first.
 *   "block"   — refuse (kill switch engaged, or over a hard ceiling).
 */

import type { KeyValue } from "./db";
import { AutonomyLevel, type AgentSpec, type ToolDefinition } from "../types";

export type Decision = "allow" | "approve" | "block";

const KILL = "kill_switch";
const SPEND_CEILING_DAILY = "spend_ceiling_daily"; // money allowed per day before hard block
const autonomyKey = (agentId: string) => `autonomy:${agentId}`;

export class PolicyEngine {
  constructor(
    private kv: KeyValue,
    private spentTodayFn: () => number,
  ) {}

  // ── Kill switch ────────────────────────────────────────────────────────────
  isKilled(): boolean {
    return this.kv.getBool(KILL, false);
  }
  setKill(on: boolean): void {
    this.kv.setBool(KILL, on);
  }

  // ── Autonomy dial (per agent), never exceeding the agent's hard ceiling ──────
  autonomyFor(spec: AgentSpec): AutonomyLevel {
    const raw = this.kv.get(autonomyKey(spec.id));
    const set = raw === null ? AutonomyLevel.Draft : (Number(raw) as AutonomyLevel);
    return Math.min(set, spec.autonomyCeiling);
  }
  setAutonomy(agentId: string, level: AutonomyLevel): void {
    this.kv.set(autonomyKey(agentId), String(level));
  }

  // ── Daily spend ceiling (0 = money always needs approval and never auto-runs) ─
  dailyCeiling(): number {
    return Number(this.kv.get(SPEND_CEILING_DAILY) ?? "0");
  }
  setDailyCeiling(amount: number): void {
    this.kv.set(SPEND_CEILING_DAILY, String(amount));
  }

  /**
   * The core decision. Given who is acting and which tool, return the gate result.
   */
  decide(spec: AgentSpec, tool: ToolDefinition, costEstimate = 0): { decision: Decision; reason: string } {
    // Reads never have side effects — always allowed, even while paused.
    if (tool.sensitivity === "read") {
      return { decision: "allow", reason: "read-only" };
    }

    // Internal, reversible writes to Nexus's own store (memory/notes) — allowed
    // (and audited), since they have no outward effect in your name.
    if (tool.internal) {
      return { decision: "allow", reason: "internal reversible store write" };
    }

    // Kill switch pauses ALL outward/side-effecting actions.
    if (this.isKilled()) {
      return { decision: "block", reason: "kill switch engaged — all autonomy paused" };
    }

    // Money & legal are the highest gate: always human-approved in v1.
    if (tool.sensitivity === "money" || tool.sensitivity === "legal") {
      if (costEstimate > 0 && this.spentTodayFn() + costEstimate > this.dailyCeiling()) {
        // Over the daily ceiling: still allow, but only via explicit approval.
        return { decision: "approve", reason: "over daily spend ceiling — needs your sign-off" };
      }
      return { decision: "approve", reason: `${tool.sensitivity} action — always requires approval` };
    }

    // write / comms: allowed without asking only once the dial is at L4+ (earned trust).
    const level = this.autonomyFor(spec);
    if (level >= AutonomyLevel.ExecuteWithinRules) {
      return { decision: "allow", reason: `autonomy L${level} — within earned rules, reported after` };
    }
    return { decision: "approve", reason: `autonomy L${level} (draft) — needs your sign-off to send` };
  }
}
