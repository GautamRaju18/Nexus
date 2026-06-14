/**
 * Core type contracts shared across the whole Nexus organization.
 *
 * The mental model: YOU are the CEO. The Chief of Staff (orchestrator) turns your
 * stated outcomes into a plan, delegates to specialist agents, and every action
 * passes through the autonomy/approval gate and lands in the immutable audit log.
 */

import type { z } from "zod";

// ── Autonomy ────────────────────────────────────────────────────────────────
// How much an agent may do on its own. Defaults are conservative; trust is earned.
export enum AutonomyLevel {
  Observe = 0, // watch & learn only
  Recommend = 1, // suggest, you act
  Draft = 2, // prepare the action, you ship it   <-- v1 default everywhere
  ExecuteWithApproval = 3, // do it after one explicit approval
  ExecuteWithinRules = 4, // act freely inside guardrails, report after
  FullyAutonomous = 5, // own the outcome, you see only the recap
}

// How risky/irreversible an action is. Drives whether approval is required.
export type ToolSensitivity =
  | "read" // no side effects (search, recall, fetch)
  | "write" // changes your data (calendar event, note, file)
  | "comms" // sends something outward in your name (email, message, post)
  | "money" // moves or commits money — always the highest gate
  | "legal"; // binds you (signing, agreeing to terms)

// ── Tools ───────────────────────────────────────────────────────────────────
export interface ToolContext {
  /** The agent invoking the tool. */
  agentId: string;
  /** The tenant (web user) this action runs for; "owner" for CLI/Telegram. */
  userId: string;
  /** Shared services the tool may use (already scoped to userId). */
  services: ToolServices;
}

// Narrow service interfaces so a tool sees the SAME shape whether it's handed the raw
// global store or a per-user-scoped facade (see bootstrap.ts `scope()`). The concrete
// MemoryStore / Vault / KeyValue / ReminderStore all satisfy these structurally.
export interface MemoryService {
  remember(input: {
    layer: MemoryLayer;
    key: string;
    content: string;
    source: string;
    confidence?: number;
    pinned?: boolean;
  }): Promise<string>;
  recall(query: string, k?: number, minScore?: number): Promise<MemoryRecord[]>;
  list(layer?: MemoryLayer): MemoryRecord[];
  count(): number;
}
export interface ReminderService {
  add(p: {
    text: string;
    dueAt: number;
    recurrence?: import("./core/reminders").Recurrence | null;
    agent?: string;
  }): import("./core/reminders").Reminder;
  list(opts?: {
    status?: import("./core/reminders").ReminderStatus | "all";
    limit?: number;
  }): import("./core/reminders").Reminder[];
  cancel(id: string): boolean;
}
/** A get/set secret store (the encrypted vault, or a per-user-prefixed view of it). */
export interface SecretStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  has(key: string): boolean;
  delete(key: string): void;
  list(): string[];
}
/** A simple key/value store (the kv table, or a per-user-prefixed view of it). */
export interface KvStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  getBool(key: string, fallback?: boolean): boolean;
  setBool(key: string, value: boolean): void;
}

// Forward-declared services a tool can reach. In multi-user mode these are scoped to the
// acting user's tenant, so a tool never has to know about userId — it just reads/writes
// and isolation happens underneath.
export interface ToolServices {
  memory: MemoryService;
  vault: SecretStore;
  kv: KvStore;
  google: import("./core/google/auth").GoogleAuth;
  reminders: ReminderService;
  log: (msg: string) => void;
}

export interface ToolDefinition<TInput = unknown> {
  id: string;
  description: string;
  sensitivity: ToolSensitivity;
  /** Zod schema describing the tool input (also used to coach the model). */
  input: z.ZodType<TInput>;
  /** Permission scopes this tool needs (e.g. "calendar", "email", "web"). */
  scopes: string[];
  /**
   * True if this tool only touches Nexus's own local store (memory, notes, kv)
   * and is fully reversible. Internal tools skip approval (still audited), since
   * they have no outward effect in your name.
   */
  internal?: boolean;
  /** The actual implementation. Must be side-effect-honest about its sensitivity. */
  handler: (input: TInput, ctx: ToolContext) => Promise<unknown>;
}

// ── Agents ──────────────────────────────────────────────────────────────────
export type Department =
  | "leadership"
  | "personal"
  | "knowledge"
  | "business"
  | "finance-legal"
  | "guardian";

export interface AgentSpec {
  id: string;
  name: string;
  department: Department;
  /** One-line job description used for routing. */
  purpose: string;
  /** The agent's standing instructions (its "job training"). */
  systemPrompt: string;
  /** Tool ids this agent is licensed to use. */
  tools: string[];
  /** Data scopes this agent may touch (least privilege). */
  dataScopes: string[];
  /** The highest autonomy this agent may EVER reach, even if you raise the dial. */
  autonomyCeiling: AutonomyLevel;
}

// ── LLM ─────────────────────────────────────────────────────────────────────
export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMProvider {
  name: string;
  /** Single-shot chat completion. Returns the assistant's text. */
  chat(messages: LLMMessage[]): Promise<string>;
  /** Embed text for memory recall. Returns null if embeddings are unavailable. */
  embed(text: string): Promise<number[] | null>;
}

// ── Memory ──────────────────────────────────────────────────────────────────
export type MemoryLayer =
  | "identity" // stable facts about you
  | "preference" // how you like things done
  | "episodic" // what happened
  | "semantic" // distilled knowledge about your world
  | "procedural" // your repeatable workflows
  | "relationship"; // people in your life

export interface MemoryRecord {
  id: string;
  layer: MemoryLayer;
  /** Short handle, e.g. "seat-preference". */
  key: string;
  content: string;
  /** Where this belief came from (an event id, "user-stated", an agent id). */
  source: string;
  /** 0..1 — how sure we are. Reinforced by repetition, decayed by disuse. */
  confidence: number;
  /** Pinned memories never decay or auto-forget. */
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
}

// ── Audit ───────────────────────────────────────────────────────────────────
export interface AuditEntry {
  id: string;
  ts: number;
  actor: string; // which agent
  action: string; // what it did, e.g. "tool:web_fetch"
  detail: string; // human-readable description
  sensitivity: ToolSensitivity | "system";
  reversible: boolean;
  status: "ok" | "blocked" | "denied" | "error";
  costEstimate?: number; // money committed, if any
}

// ── Approvals ───────────────────────────────────────────────────────────────
export interface ApprovalRequest {
  agentId: string;
  /** The tenant (web user) this approval belongs to, so the surface routes it correctly. */
  userId: string;
  toolId: string;
  sensitivity: ToolSensitivity;
  /** A human-readable preview of EXACTLY what is about to happen. */
  preview: string;
  reversible: boolean;
  costEstimate?: number;
}

/** A surface (CLI, Telegram, web) implements this to get user sign-off. */
export interface Approver {
  /** Return true to allow the action, false to deny it. */
  approve(req: ApprovalRequest): Promise<boolean>;
  /** Ask the user a free-form question and get a text answer. */
  ask?(question: string): Promise<string>;
}
