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
import { ReminderStore } from "./reminders";
import { Scheduler, type Deliver } from "./scheduler";
import { GoogleAuth } from "./google/auth";
import { AuthStore } from "./auth";
import { ConversationStore } from "./conversations";
import { Orchestrator } from "./orchestrator";
import type { AgentDeps } from "./agent";
import type { Approver, LLMProvider, ToolServices } from "../types";

/** The default tenant for single-user surfaces (CLI/Telegram) and legacy data. */
export const OWNER = "owner";

export interface JarvisRuntime {
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
  services: ToolServices;
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

export function bootstrap(log: (msg: string) => void = () => {}): JarvisRuntime {
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
  for (const t of builtinTools()) tools.register(t);
  for (const t of googleTools()) tools.register(t);
  for (const t of jobTools()) tools.register(t);
  for (const t of reminderTools()) tools.register(t);
  for (const t of financeTools()) tools.register(t);

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
    services,
    scope,
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
