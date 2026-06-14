/**
 * Long-term memory — the thing that makes Nexus feel like it KNOWS you rather
 * than re-meeting you every session. Layered (identity / preference / episodic /
 * semantic / procedural / relationship), with embedding-based recall and a
 * keyword fallback when embeddings are unavailable.
 *
 * Every memory records its `source` so the Memory Dashboard can answer
 * "why do you know this?" — provenance is a first-class feature, not an add-on.
 */

import { randomUUID } from "node:crypto";
import type { DB } from "./db";
import type { LLMProvider, MemoryLayer, MemoryRecord } from "../types";

interface Row {
  id: string;
  layer: string;
  key: string;
  content: string;
  source: string;
  confidence: number;
  pinned: number;
  embedding: string | null;
  created_at: number;
  updated_at: number;
  user_id: string | null;
}

/** Legacy tenant: rows written before multi-user (user_id IS NULL) belong here. */
const OWNER = "owner";
/** SQL fragment + params matching a tenant's rows, treating NULL as the owner. */
function scopeSql(userId: string): { clause: string; params: string[] } {
  return { clause: "(user_id = ? OR (user_id IS NULL AND ? = ?))", params: [userId, userId, OWNER] };
}

export class MemoryStore {
  constructor(
    private db: DB,
    private llm: LLMProvider,
  ) {}

  /** Store (or reinforce) a fact. Re-stating an existing key strengthens confidence. */
  async remember(input: {
    layer: MemoryLayer;
    key: string;
    content: string;
    source: string;
    confidence?: number;
    pinned?: boolean;
    userId?: string;
  }): Promise<string> {
    const now = Date.now();
    const userId = input.userId ?? OWNER;
    const s = scopeSql(userId);
    // Dedup within the SAME tenant only — two users may hold the same key independently.
    const existing = this.db
      .prepare(`SELECT * FROM memory WHERE layer = ? AND key = ? AND ${s.clause}`)
      .get(input.layer, input.key, ...s.params) as Row | undefined;

    const embedding = await this.safeEmbed(`${input.key}: ${input.content}`);
    const embJson = embedding ? JSON.stringify(embedding) : null;

    if (existing) {
      // Reinforcement: nudge confidence up, refresh content & recency. Also claims any
      // legacy NULL row for this tenant by stamping user_id.
      const conf = Math.min(1, Math.max(existing.confidence, input.confidence ?? 0.7) + 0.05);
      this.db
        .prepare(
          "UPDATE memory SET content=?, source=?, confidence=?, pinned=?, embedding=?, updated_at=?, user_id=? WHERE id=?",
        )
        .run(
          input.content,
          input.source,
          conf,
          input.pinned ? 1 : existing.pinned,
          embJson,
          now,
          userId,
          existing.id,
        );
      return existing.id;
    }

    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO memory (id, layer, key, content, source, confidence, pinned, embedding, created_at, updated_at, user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.layer,
        input.key,
        input.content,
        input.source,
        input.confidence ?? 0.7,
        input.pinned ? 1 : 0,
        embJson,
        now,
        now,
        userId,
      );
    return id;
  }

  /**
   * Recall the most relevant memories for a query. Semantic if possible, else keyword.
   * `minScore` filters out weakly-related memories — critical to stop an unrelated
   * memory (e.g. an earbuds note) from derailing an agent on a different task.
   */
  async recall(query: string, k = 6, minScore = 0.45, userId: string = OWNER): Promise<MemoryRecord[]> {
    const all = this.allRows(userId);
    if (all.length === 0) return [];

    const queryEmb = await this.safeEmbed(query);
    if (queryEmb) {
      // With embeddings, trust the similarity score: return only genuinely relevant
      // memories (possibly none) rather than falling back to weak keyword guesses.
      return all
        .filter((r) => r.embedding)
        .map((r) => ({ r, score: cosine(queryEmb, JSON.parse(r.embedding as string)) }))
        .filter((x) => x.score >= minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, k)
        .map((x) => toRecord(x.r));
    }

    // Keyword fallback.
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return all
      .map((r) => ({
        r,
        score: terms.reduce(
          (acc, t) => acc + (`${r.key} ${r.content}`.toLowerCase().includes(t) ? 1 : 0),
          0,
        ),
      }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || b.r.confidence - a.r.confidence)
      .slice(0, k)
      .map((x) => toRecord(x.r));
  }

  list(layer?: MemoryLayer, userId: string = OWNER): MemoryRecord[] {
    const s = scopeSql(userId);
    const rows = layer
      ? (this.db
          .prepare(`SELECT * FROM memory WHERE layer = ? AND ${s.clause} ORDER BY updated_at DESC`)
          .all(layer, ...s.params) as unknown as Row[])
      : (this.db
          .prepare(`SELECT * FROM memory WHERE ${s.clause} ORDER BY updated_at DESC`)
          .all(...s.params) as unknown as Row[]);
    return rows.map(toRecord);
  }

  forget(id: string): boolean {
    const res = this.db.prepare("DELETE FROM memory WHERE id = ?").run(id);
    return res.changes > 0;
  }

  pin(id: string, pinned = true): void {
    this.db.prepare("UPDATE memory SET pinned = ? WHERE id = ?").run(pinned ? 1 : 0, id);
  }

  count(userId: string = OWNER): number {
    const s = scopeSql(userId);
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM memory WHERE ${s.clause}`).get(...s.params) as { n: number };
    return row.n;
  }

  private allRows(userId: string = OWNER): Row[] {
    const s = scopeSql(userId);
    return this.db.prepare(`SELECT * FROM memory WHERE ${s.clause}`).all(...s.params) as unknown as Row[];
  }

  private async safeEmbed(text: string): Promise<number[] | null> {
    try {
      return await this.llm.embed(text);
    } catch {
      return null; // embeddings are best-effort; recall degrades to keyword search
    }
  }
}

function toRecord(r: Row): MemoryRecord {
  return {
    id: r.id,
    layer: r.layer as MemoryLayer,
    key: r.key,
    content: r.content,
    source: r.source,
    confidence: r.confidence,
    pinned: r.pinned === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
