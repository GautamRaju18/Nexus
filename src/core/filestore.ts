/**
 * Local, encrypted file store. The CEO's files are AES-256-GCM encrypted (via the vault)
 * and never leave the machine. Content lives in the vault under `file:<id>`; a lightweight
 * index (name/size/type/date) lives in the kv store. Single-user, local-first.
 */

import { randomUUID } from "node:crypto";
import type { Vault } from "./security/vault";
import type { KeyValue } from "./db";

export interface FileMeta {
  id: string;
  name: string;
  type: string;
  size: number;
  date: string;
}

const INDEX = "files:index";
const MAX_BYTES = 8 * 1024 * 1024; // 8 MB per file

export class FileStore {
  constructor(
    private vault: Vault,
    private kv: KeyValue,
  ) {}

  list(): FileMeta[] {
    try {
      const raw = this.kv.get(INDEX);
      const a = raw ? JSON.parse(raw) : [];
      return Array.isArray(a) ? (a as FileMeta[]) : [];
    } catch {
      return [];
    }
  }

  private writeIndex(list: FileMeta[]): void {
    this.kv.set(INDEX, JSON.stringify(list));
  }

  /** Store a base64-encoded file. Throws on empty/oversized input. */
  save(name: string, type: string, dataB64: string): FileMeta {
    const buf = Buffer.from(dataB64 || "", "base64");
    if (buf.length === 0) throw new Error("empty or unreadable file");
    if (buf.length > MAX_BYTES) throw new Error(`file too large (max ${Math.round(MAX_BYTES / 1024 / 1024)} MB)`);
    const id = randomUUID();
    this.vault.set(`file:${id}`, dataB64); // encrypted at rest
    const meta: FileMeta = {
      id,
      name: (name || "file").replace(/[\r\n"]/g, "").slice(0, 200),
      type: (type || "application/octet-stream").slice(0, 120),
      size: buf.length,
      date: new Date().toISOString(),
    };
    const list = this.list();
    list.unshift(meta);
    this.writeIndex(list);
    return meta;
  }

  get(id: string): { meta: FileMeta; data: Buffer } | null {
    const meta = this.list().find((f) => f.id === id);
    if (!meta) return null;
    const b64 = this.vault.get(`file:${id}`);
    if (b64 === null) return null;
    return { meta, data: Buffer.from(b64, "base64") };
  }

  remove(id: string): boolean {
    const list = this.list();
    const next = list.filter((f) => f.id !== id);
    if (next.length === list.length) return false;
    this.vault.delete(`file:${id}`);
    this.writeIndex(next);
    return true;
  }
}
