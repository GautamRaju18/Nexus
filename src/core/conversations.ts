/**
 * Persistent chat transcripts — the fix for "history disappears on refresh/restart".
 * Every turn the web cockpit handles is written here, scoped to the user_id and a
 * conversation scope ('main' for the Chief-of-Staff line, 'direct:<agentId>' for a
 * private line to one agent). On load, the surface replays the stored turns so the
 * conversation comes back exactly as the user left it.
 *
 * This is verbatim transcript storage in the existing SQLite DB — distinct from the
 * semantic MemoryStore (long-term facts). No external memory service is involved.
 */

import { randomUUID } from "node:crypto";
import type { DB } from "./db";
import type { LLMMessage } from "../types";

export interface StoredMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  agent: string | null;
  ts: number;
}

export class ConversationStore {
  constructor(private db: DB) {}

  /** Find (or create) the single conversation row for a user+scope. */
  private conversationId(userId: string, scope: string): string {
    const row = this.db
      .prepare("SELECT id FROM conversations WHERE user_id = ? AND scope = ?")
      .get(userId, scope) as { id: string } | undefined;
    if (row) return row.id;
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare("INSERT INTO conversations (id, user_id, scope, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, userId, scope, now, now);
    return id;
  }

  /** Persist one user→assistant exchange. `agent` labels who answered (for display). */
  appendTurn(userId: string, scope: string, userText: string, assistantText: string, agent?: string): void {
    const convoId = this.conversationId(userId, scope);
    const now = Date.now();
    const insert = this.db.prepare(
      "INSERT INTO messages (id, conversation_id, user_id, role, content, agent, ts) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    insert.run(randomUUID(), convoId, userId, "user", userText, null, now);
    insert.run(randomUUID(), convoId, userId, "assistant", assistantText, agent ?? null, now + 1);
    this.db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(now + 1, convoId);
  }

  /** Recent turns as LLM messages (oldest→newest) to seed model context. */
  recent(userId: string, scope: string, limit = 8): LLMMessage[] {
    return this.rows(userId, scope, limit).map((m) => ({ role: m.role, content: m.content }));
  }

  /** Full message rows (oldest→newest) for replaying the thread in the UI. */
  history(userId: string, scope: string, limit = 200): StoredMessage[] {
    return this.rows(userId, scope, limit);
  }

  private rows(userId: string, scope: string, limit: number): StoredMessage[] {
    const convo = this.db
      .prepare("SELECT id FROM conversations WHERE user_id = ? AND scope = ?")
      .get(userId, scope) as { id: string } | undefined;
    if (!convo) return [];
    const rows = this.db
      .prepare(
        // newest N by ts, then return oldest→newest
        `SELECT id, role, content, agent, ts FROM messages
         WHERE conversation_id = ? ORDER BY ts DESC LIMIT ?`,
      )
      .all(convo.id, Math.min(limit, 500)) as unknown as StoredMessage[];
    return rows.reverse();
  }
}
