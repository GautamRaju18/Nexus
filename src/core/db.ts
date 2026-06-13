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

    -- Durable inbox for the Telegram surface: a message is persisted here BEFORE its
    -- update is acked to Telegram, so a crash mid-processing reprocesses it (at-least-once)
    -- instead of losing it.
    CREATE TABLE IF NOT EXISTS telegram_inbox (
      update_id  INTEGER PRIMARY KEY,
      msg        TEXT NOT NULL,
      done       INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
  `);
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
