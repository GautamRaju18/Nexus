/**
 * Reminders store — the data layer behind the Secretary's proactive nudges.
 *
 * A reminder is a bit of text that should resurface at a due time. One-shot
 * reminders fire once and are marked 'fired'; recurring ones (hourly/daily/weekly)
 * reschedule themselves to the next slot so they keep nudging. The in-process
 * Scheduler (core/scheduler.ts) polls due() and a surface delivers them.
 *
 * Reminders aren't secret (no credentials), so they live in a plain SQLite table
 * like tasks — queryable, append-friendly, and survives restarts.
 */

import { randomUUID } from "node:crypto";
import type { DB } from "./db";

export type Recurrence = "hourly" | "daily" | "weekly";
export type ReminderStatus = "pending" | "fired" | "cancelled";

export interface Reminder {
  id: string;
  text: string;
  dueAt: number;
  recurrence: Recurrence | null;
  agent: string | null;
  status: ReminderStatus;
  createdAt: number;
  firedAt: number | null;
  /** The tenant who owns this reminder; used to route delivery. */
  userId: string;
}

/** Legacy tenant: rows written before multi-user (user_id IS NULL) belong here. */
const OWNER = "owner";

const RECUR_MS: Record<Recurrence, number> = {
  hourly: 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

interface Row {
  id: string;
  text: string;
  due_at: number;
  recurrence: string | null;
  agent: string | null;
  status: string;
  created_at: number;
  fired_at: number | null;
  user_id: string | null;
}

function toReminder(r: Row): Reminder {
  return {
    id: r.id,
    text: r.text,
    dueAt: r.due_at,
    recurrence: (r.recurrence as Recurrence | null) ?? null,
    agent: r.agent,
    status: r.status as ReminderStatus,
    createdAt: r.created_at,
    firedAt: r.fired_at,
    userId: r.user_id ?? OWNER,
  };
}

export class ReminderStore {
  constructor(private db: DB) {}

  add(p: { text: string; dueAt: number; recurrence?: Recurrence | null; agent?: string; userId?: string }): Reminder {
    const r: Reminder = {
      id: randomUUID(),
      text: p.text,
      dueAt: p.dueAt,
      recurrence: p.recurrence ?? null,
      agent: p.agent ?? null,
      status: "pending",
      createdAt: Date.now(),
      firedAt: null,
      userId: p.userId ?? OWNER,
    };
    this.db
      .prepare(
        `INSERT INTO reminders (id, text, due_at, recurrence, agent, status, created_at, fired_at, user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(r.id, r.text, r.dueAt, r.recurrence, r.agent, r.status, r.createdAt, r.firedAt, r.userId);
    return r;
  }

  /** Pending reminders whose time has come (due_at <= now). */
  due(now = Date.now()): Reminder[] {
    const rows = this.db
      .prepare("SELECT * FROM reminders WHERE status = 'pending' AND due_at <= ? ORDER BY due_at ASC")
      .all(now) as unknown as Row[];
    return rows.map(toReminder);
  }

  /**
   * Settle a fired reminder. Recurring reminders roll forward to the next slot
   * (skipping any missed windows so they don't fire in a burst); one-shots are
   * marked 'fired'. Returns the next due time for recurring, or null.
   */
  markFired(id: string, now = Date.now()): number | null {
    const row = this.db.prepare("SELECT * FROM reminders WHERE id = ?").get(id) as unknown as Row | undefined;
    if (!row) return null;
    const rec = (row.recurrence as Recurrence | null) ?? null;
    if (rec && RECUR_MS[rec]) {
      const step = RECUR_MS[rec];
      let next = row.due_at + step;
      while (next <= now) next += step; // catch up past any missed windows
      this.db.prepare("UPDATE reminders SET due_at = ?, fired_at = ? WHERE id = ?").run(next, now, id);
      return next;
    }
    this.db.prepare("UPDATE reminders SET status = 'fired', fired_at = ? WHERE id = ?").run(now, id);
    return null;
  }

  cancel(id: string): boolean {
    const res = this.db
      .prepare("UPDATE reminders SET status = 'cancelled' WHERE id = ? AND status = 'pending'")
      .run(id);
    return Number(res.changes) > 0;
  }

  /** List one tenant's reminders, newest-due first. Defaults to pending only. */
  list(opts: { status?: ReminderStatus | "all"; limit?: number; userId?: string } = {}): Reminder[] {
    const limit = Math.min(opts.limit ?? 50, 200);
    const status = opts.status ?? "pending";
    const userId = opts.userId ?? OWNER;
    const scope = "(user_id = ? OR (user_id IS NULL AND ? = ?))";
    const scopeParams = [userId, userId, OWNER];
    const rows =
      status === "all"
        ? (this.db
            .prepare(`SELECT * FROM reminders WHERE ${scope} ORDER BY due_at ASC LIMIT ?`)
            .all(...scopeParams, limit) as unknown as Row[])
        : (this.db
            .prepare(`SELECT * FROM reminders WHERE status = ? AND ${scope} ORDER BY due_at ASC LIMIT ?`)
            .all(status, ...scopeParams, limit) as unknown as Row[]);
    return rows.map(toReminder);
  }
}
