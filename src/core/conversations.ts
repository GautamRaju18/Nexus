/**
 * Persistent chat transcripts — the fix for "history disappears on refresh/restart".
 *
 * Two addressing models share the `conversations`/`messages` tables:
 *  - The MAIN channel supports MANY conversations per user (ChatGPT-style: create new,
 *    switch, delete). These are addressed by conversation id (scope='main').
 *  - Direct lines to one agent ('direct:<agentId>') stay a single thread per scope.
 *
 * Verbatim transcript storage in the local SQLite DB — distinct from the semantic
 * MemoryStore (long-term facts). No external memory service is involved.
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

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: number;
  count: number;
}

/** A short, single-line title derived from the first user message. */
function titleFrom(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return (t.length > 48 ? t.slice(0, 48) + "…" : t) || "New chat";
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

  // ── Multi-chat: many named MAIN conversations per user ──────────────────────

  /** Create a new (empty) main conversation; returns its id + display title. */
  createConversation(userId: string, title?: string): { id: string; title: string } {
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare("INSERT INTO conversations (id, user_id, scope, title, created_at, updated_at) VALUES (?, ?, 'main', ?, ?, ?)")
      .run(id, userId, title ?? null, now, now);
    return { id, title: title ?? "New chat" };
  }

  /** A user's main conversations, newest-activity first — drives the chat list. */
  listConversations(userId: string): ConversationSummary[] {
    const rows = this.db
      .prepare(
        `SELECT c.id, c.title, c.updated_at AS updatedAt,
                (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS count
         FROM conversations c
         WHERE c.user_id = ? AND c.scope = 'main'
         ORDER BY c.updated_at DESC`,
      )
      .all(userId) as unknown as { id: string; title: string | null; updatedAt: number; count: number }[];
    return rows.map((r) => ({ id: r.id, title: r.title || this.fallbackTitle(r.id), updatedAt: r.updatedAt, count: r.count }));
  }

  /** Append a turn to a SPECIFIC conversation the user owns. Returns false if not theirs. */
  appendTo(conversationId: string, userId: string, userText: string, assistantText: string, agent?: string): boolean {
    if (!this.owns(conversationId, userId)) return false;
    const now = Date.now();
    const insert = this.db.prepare(
      "INSERT INTO messages (id, conversation_id, user_id, role, content, agent, ts) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    insert.run(randomUUID(), conversationId, userId, "user", userText, null, now);
    insert.run(randomUUID(), conversationId, userId, "assistant", assistantText, agent ?? null, now + 1);
    // Auto-title from the first user message if still untitled.
    const cur = this.db.prepare("SELECT title FROM conversations WHERE id = ?").get(conversationId) as { title: string | null } | undefined;
    if (cur && !cur.title) {
      this.db.prepare("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?").run(titleFrom(userText), now + 1, conversationId);
    } else {
      this.db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(now + 1, conversationId);
    }
    return true;
  }

  /** Recent turns of a specific conversation as LLM context. */
  recentOf(conversationId: string, userId: string, limit = 8): LLMMessage[] {
    if (!this.owns(conversationId, userId)) return [];
    return this.rowsOf(conversationId, limit).map((m) => ({ role: m.role, content: m.content }));
  }

  /** Full messages of a specific conversation for UI replay. */
  messagesOf(conversationId: string, userId: string, limit = 200): StoredMessage[] {
    if (!this.owns(conversationId, userId)) return [];
    return this.rowsOf(conversationId, limit);
  }

  renameConversation(conversationId: string, userId: string, title: string): boolean {
    if (!this.owns(conversationId, userId)) return false;
    this.db.prepare("UPDATE conversations SET title = ? WHERE id = ?").run(title.slice(0, 80), conversationId);
    return true;
  }

  deleteConversation(conversationId: string, userId: string): boolean {
    if (!this.owns(conversationId, userId)) return false;
    this.db.prepare("DELETE FROM messages WHERE conversation_id = ?").run(conversationId);
    this.db.prepare("DELETE FROM conversations WHERE id = ?").run(conversationId);
    return true;
  }

  private owns(conversationId: string, userId: string): boolean {
    const row = this.db.prepare("SELECT user_id FROM conversations WHERE id = ?").get(conversationId) as
      | { user_id: string }
      | undefined;
    return !!row && row.user_id === userId;
  }
  private fallbackTitle(conversationId: string): string {
    const row = this.db
      .prepare("SELECT content FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY ts ASC LIMIT 1")
      .get(conversationId) as { content: string } | undefined;
    return row ? titleFrom(row.content) : "New chat";
  }
  private rowsOf(conversationId: string, limit: number): StoredMessage[] {
    const rows = this.db
      .prepare("SELECT id, role, content, agent, ts FROM messages WHERE conversation_id = ? ORDER BY ts DESC LIMIT ?")
      .all(conversationId, Math.min(limit, 500)) as unknown as StoredMessage[];
    return rows.reverse();
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
