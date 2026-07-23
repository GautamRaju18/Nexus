/**
 * Bootstrap — wire every subsystem together once and hand back a runtime.
 * Surfaces (CLI, Telegram, web) call this, supply an Approver, and get an
 * Orchestrator they can drive.
 */

import { loadConfig, type Config } from "../config";
import { openDb, KeyValue, type DB } from "./db";
import { Vault } from "./security/vault";
import { makeProvider } from "./llm/providers";
import { MemoryStore } from "./memory";
import { AuditLog } from "./audit";
import { PolicyEngine } from "./policy";
import { ToolRegistry, builtinTools } from "./tools";
import { googleTools } from "./tools-google";
import { jobTools } from "./tools-jobs";
import { reminderTools } from "./tools-reminders";
import { financeTools } from "./tools-finance";
import { docTools } from "./tools-docs";
import { fileTools } from "./tools-files";
import { codeTools } from "./tools-code";
import { systemTools } from "./tools-system";
import { McpHub } from "./mcp/hub";
import { AGENTS_BY_ID } from "../agents/specs";
import { join } from "node:path";
import { ReminderStore } from "./reminders";
import { Scheduler, type Deliver } from "./scheduler";
import { GoogleAuth } from "./google/auth";
import { AuthStore } from "./auth";
import { ConversationStore } from "./conversations";
import { Orchestrator } from "./orchestrator";
import type { AgentDeps } from "./agent";
import { AutonomyLevel } from "../types";
import type { Approver, LLMProvider, ToolServices } from "../types";

/** The default tenant for single-user surfaces (CLI/Telegram) and legacy data. */
export const OWNER = "owner";

export interface NexusRuntime {
  cfg: Config;
  db: DB;
  kv: KeyValue;
  vault: Vault;
  llm: LLMProvider;
  memory: MemoryStore;
  audit: AuditLog;
  policy: PolicyEngine;
  tools: ToolRegistry;
  google: GoogleAuth;
  reminders: ReminderStore;
  auth: AuthStore;
  conversations: ConversationStore;
  mcp: McpHub;
  services: ToolServices;
  /** Connect the MCP servers from mcp.json, register their tools, and grant them to the
   *  Integrations agent. Async + idempotent; surfaces call this once at startup. */
  connectMcp(): Promise<string[]>;
  /** Build a ToolServices bundle whose stores are isolated to one tenant (web user). */
  scope(userId: string): ToolServices;
  buildOrchestrator(approver: Approver): Orchestrator;
  /** Start the proactive reminder loop, delivering due nudges via `deliver`.
   *  Pass `userFilter` to deliver only one tenant's reminders (single-user surfaces). */
  startScheduler(deliver: Deliver, userFilter?: string): Scheduler;
}

function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function bootstrap(log: (msg: string) => void = () => {}): NexusRuntime {
  const cfg = loadConfig();
  const db = openDb(cfg.dbPath);
  const kv = new KeyValue(db);

  const vault = new Vault(db, cfg.masterKey);
  vault.unlock(); // verifies the master passphrase before anything else runs

  const llm = makeProvider(cfg, log);
  const memory = new MemoryStore(db, llm);
  const audit = new AuditLog(db);
  const policy = new PolicyEngine(kv, () => audit.spentSince(startOfToday()));

  const google = new GoogleAuth(vault, cfg);
  const reminders = new ReminderStore(db);
  const auth = new AuthStore(db);
  const conversations = new ConversationStore(db);

  const tools = new ToolRegistry();
  const mcp = new McpHub(tools, log);
  for (const t of builtinTools()) tools.register(t);
  for (const t of googleTools()) tools.register(t);
  for (const t of jobTools()) tools.register(t);
  for (const t of reminderTools()) tools.register(t);
  for (const t of financeTools()) tools.register(t);
  for (const t of docTools()) tools.register(t);
  for (const t of fileTools()) tools.register(t);
  for (const t of codeTools()) tools.register(t);
  for (const t of systemTools()) tools.register(t);

  // The System agent controls the machine (open apps/URLs, media). Ship it at L4 so it
  // acts without nagging — the kill switch and its autonomy dial still govern it. Only
  // seed once (respects any level the CEO later sets, including turning it down).
  if (kv.get("autonomy:system") === null) policy.setAutonomy("system", AutonomyLevel.ExecuteWithinRules);

  /**
   * Per-tenant service bundle. memory/reminders inject the userId; vault/kv get a
   * key-prefixed view so per-user tool data (notes, files, job profile, finance) is
   * isolated. The OWNER tenant uses an EMPTY prefix so pre-multi-user data stays
   * exactly where it was. System code (policy, google) keeps using the RAW stores.
   */
  const scope = (userId: string): ToolServices => {
    const prefix = userId === OWNER ? "" : `u:${userId}:`;
    return {
      memory: {
        remember: (input) => memory.remember({ ...input, userId }),
        recall: (q, k, minScore) => memory.recall(q, k, minScore, userId),
        list: (layer) => memory.list(layer, userId),
        count: () => memory.count(userId),
      },
      reminders: {
        add: (p) => reminders.add({ ...p, userId }),
        list: (opts) => reminders.list({ ...opts, userId }),
        cancel: (id) => reminders.cancel(id),
      },
      vault: {
        get: (k) => vault.get(prefix + k),
        set: (k, v) => vault.set(prefix + k, v),
        has: (k) => vault.has(prefix + k),
        delete: (k) => vault.delete(prefix + k),
        list: () => (prefix ? vault.list().filter((x) => x.startsWith(prefix)).map((x) => x.slice(prefix.length)) : vault.list()),
      },
      kv: {
        get: (k) => kv.get(prefix + k),
        set: (k, v) => kv.set(prefix + k, v),
        getBool: (k, fb) => kv.getBool(prefix + k, fb),
        setBool: (k, v) => kv.setBool(prefix + k, v),
      },
      google,
      log,
    };
  };

  // Default bundle = the owner tenant; CLI/Telegram and legacy callers use this.
  const services: ToolServices = scope(OWNER);

  return {
    cfg,
    db,
    kv,
    vault,
    llm,
    memory,
    audit,
    policy,
    tools,
    google,
    reminders,
    auth,
    conversations,
    mcp,
    services,
    scope,
    async connectMcp(): Promise<string[]> {
      const path = process.env.NEXUS_MCP_CONFIG?.trim() || join(process.cwd(), "mcp.json");
      const ids = await mcp.connectAll(mcp.loadConfig(path));
      // Grant every discovered MCP tool to the Integrations agent (dynamic capability).
      const spec = AGENTS_BY_ID["integrations"];
      if (spec) for (const id of ids) if (!spec.tools.includes(id)) spec.tools.push(id);
      return ids;
    },
    buildOrchestrator(approver: Approver): Orchestrator {
      const deps: AgentDeps = { llm, tools, policy, audit, approver, services, userId: OWNER };
      return new Orchestrator(deps);
    },
    startScheduler(deliver: Deliver, userFilter?: string): Scheduler {
      const scheduler = new Scheduler(reminders, deliver, 30_000, log, userFilter);
      scheduler.start();
      return scheduler;
    },
  };
}
