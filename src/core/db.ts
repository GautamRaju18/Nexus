/**
 * Local SQLite storage — a single file on your machine. Nothing here is sent
 * anywhere. Built on Node's built-in `node:sqlite` (no native build step).
 *
 * At-rest protection model for v1:
 *   - Secrets (tokens, API keys) are ALWAYS field-encrypted in the `vault` table.
 *   - The DB file itself relies on OS full-disk encryption (BitLocker on Win11).
 *     See SECURITY.md. This keeps v1 dependency-free while protecting secrets.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type DB = DatabaseSync;

export function openDb(path: string): DB {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS vault (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL            -- AES-256-GCM encrypted blob (base64)
    );

    CREATE TABLE IF NOT EXISTS memory (
      id         TEXT PRIMARY KEY,
      layer      TEXT NOT NULL,
      key        TEXT NOT NULL,
      content    TEXT NOT NULL,
      source     TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.7,
      pinned     INTEGER NOT NULL DEFAULT 0,
      embedding  TEXT,                -- JSON array of floats, or NULL
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_layer ON memory(layer);
    CREATE INDEX IF NOT EXISTS idx_memory_key   ON memory(key);

    CREATE TABLE IF NOT EXISTS audit (
      id           TEXT PRIMARY KEY,
      ts           INTEGER NOT NULL,
      actor        TEXT NOT NULL,
      action       TEXT NOT NULL,
      detail       TEXT NOT NULL,
      sensitivity  TEXT NOT NULL,
      reversible   INTEGER NOT NULL,
      status       TEXT NOT NULL,
      cost         REAL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit(ts);

    CREATE TABLE IF NOT EXISTS kv (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id         TEXT PRIMARY KEY,
      outcome    TEXT NOT NULL,
      status     TEXT NOT NULL,
      agent      TEXT,
      result     TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- Reminders / proactive nudges. The Secretary writes these; a lightweight
    -- in-process scheduler (core/scheduler.ts) fires the due ones and a surface
    -- (CLI/Telegram) delivers them. Recurring reminders reschedule themselves.
    CREATE TABLE IF NOT EXISTS reminders (
      id          TEXT PRIMARY KEY,
      text        TEXT NOT NULL,
      due_at      INTEGER NOT NULL,
      recurrence  TEXT,                          -- NULL | 'hourly' | 'daily' | 'weekly'
      agent       TEXT,                          -- which agent set it
      status      TEXT NOT NULL DEFAULT 'pending', -- pending | fired | cancelled
      created_at  INTEGER NOT NULL,
      fired_at    INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(status, due_at);

    -- Durable inbox for the Telegram surface: a message is persisted here BEFORE its
    -- update is acked to Telegram, so a crash mid-processing reprocesses it (at-least-once)
    -- instead of losing it.
    CREATE TABLE IF NOT EXISTS telegram_inbox (
      update_id  INTEGER PRIMARY KEY,
      msg        TEXT NOT NULL,
      done       INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    -- ── Multi-user (web cockpit) ──────────────────────────────────────────────
    -- Accounts are PRE-SEEDED via the user CLI (scripts/user.ts); there is no public
    -- registration. Passwords are scrypt-hashed (see core/auth.ts). Sessions are opaque
    -- random tokens carried in an HttpOnly cookie.
    CREATE TABLE IF NOT EXISTS users (
      id         TEXT PRIMARY KEY,
      username   TEXT NOT NULL UNIQUE,
      pw_hash    TEXT NOT NULL,
      pw_salt    TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

    -- Persistent, per-user chat transcripts. A conversation is one thread (the main
    -- Chief-of-Staff line, or a direct line to a single agent); messages are its turns.
    CREATE TABLE IF NOT EXISTS conversations (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      scope      TEXT NOT NULL,        -- 'main' | 'direct:<agentId>'
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id, scope);

    CREATE TABLE IF NOT EXISTS messages (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      user_id         TEXT NOT NULL,
      role            TEXT NOT NULL,   -- 'user' | 'assistant'
      content         TEXT NOT NULL,
      agent           TEXT,            -- which agent answered (display)
      ts              INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_convo ON messages(conversation_id, ts);
  `);

  // Full per-user isolation: tag previously-global stores with an owner. Existing rows
  // keep user_id = NULL, which the scoped facades treat as the legacy 'owner' tenant.
  addColumn(db, "memory", "user_id", "TEXT");
  addColumn(db, "audit", "user_id", "TEXT");
  addColumn(db, "reminders", "user_id", "TEXT");
}

/** Add a column if it isn't already present (SQLite has no ADD COLUMN IF NOT EXISTS). */
function addColumn(db: DB, table: string, column: string, decl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

/** Tiny typed key/value helper over the `kv` table for settings & flags. */
export class KeyValue {
  constructor(private db: DB) {}

  get(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row ? row.value : null;
  }

  set(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  getBool(key: string, fallback = false): boolean {
    const v = this.get(key);
    return v === null ? fallback : v === "true";
  }

  setBool(key: string, value: boolean): void {
    this.set(key, value ? "true" : "false");
  }
}
