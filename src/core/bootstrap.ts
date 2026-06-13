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
import { GoogleAuth } from "./google/auth";
import { Orchestrator } from "./orchestrator";
import type { AgentDeps } from "./agent";
import type { Approver, LLMProvider, ToolServices } from "../types";

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
  services: ToolServices;
  buildOrchestrator(approver: Approver): Orchestrator;
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

  const tools = new ToolRegistry();
  for (const t of builtinTools()) tools.register(t);
  for (const t of googleTools()) tools.register(t);
  for (const t of jobTools()) tools.register(t);

  const services: ToolServices = { memory, vault, kv, google, log };

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
    services,
    buildOrchestrator(approver: Approver): Orchestrator {
      const deps: AgentDeps = { llm, tools, policy, audit, approver, services };
      return new Orchestrator(deps);
    },
  };
}
