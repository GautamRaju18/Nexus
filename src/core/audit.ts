/**
 * The immutable audit log — the foundation of trust. Every action by every agent
 * is appended here: what, when, who, why, how reversible, and any cost. There is
 * deliberately no update() or delete(): the log is append-only ground truth.
 *
 * This is what makes it SAFE to grant Nexus authority — nothing happens
 * off-camera, and you can always answer "what did my staff do, and what did it cost?"
 */

import { randomUUID } from "node:crypto";
import type { DB } from "./db";
import type { AuditEntry, ToolSensitivity } from "../types";

interface Row {
  id: string;
  ts: number;
  actor: string;
  action: string;
  detail: string;
  sensitivity: string;
  reversible: number;
  status: string;
  cost: number | null;
  user_id: string | null;
}

/** Legacy tenant: rows written before multi-user (user_id IS NULL) belong here. */
const OWNER = "owner";

export class AuditLog {
  constructor(private db: DB) {}

  record(entry: {
    actor: string;
    action: string;
    detail: string;
    sensitivity: ToolSensitivity | "system";
    reversible: boolean;
    status: AuditEntry["status"];
    costEstimate?: number;
    userId?: string;
  }): AuditEntry {
    const row: AuditEntry = {
      id: randomUUID(),
      ts: Date.now(),
      actor: entry.actor,
      action: entry.action,
      detail: entry.detail,
      sensitivity: entry.sensitivity,
      reversible: entry.reversible,
      status: entry.status,
      costEstimate: entry.costEstimate,
    };
    this.db
      .prepare(
        `INSERT INTO audit (id, ts, actor, action, detail, sensitivity, reversible, status, cost, user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.ts,
        row.actor,
        row.action,
        row.detail,
        row.sensitivity,
        row.reversible ? 1 : 0,
        row.status,
        row.costEstimate ?? null,
        entry.userId ?? OWNER,
      );
    return row;
  }

  /** Recent actions for one tenant (NULL rows count as the legacy owner). */
  recent(limit = 25, userId: string = OWNER): AuditEntry[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM audit WHERE (user_id = ? OR (user_id IS NULL AND ? = ?)) ORDER BY ts DESC LIMIT ?",
      )
      .all(userId, userId, OWNER, limit) as unknown as Row[];
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      actor: r.actor,
      action: r.action,
      detail: r.detail,
      sensitivity: r.sensitivity as AuditEntry["sensitivity"],
      reversible: r.reversible === 1,
      status: r.status as AuditEntry["status"],
      costEstimate: r.cost ?? undefined,
    }));
  }

  /** Total money committed today (for the global daily spend ceiling). */
  spentSince(sinceTs: number): number {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(cost), 0) AS total FROM audit WHERE ts >= ? AND status = 'ok'")
      .get(sinceTs) as { total: number };
    return row.total;
  }
}
