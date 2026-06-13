/**
 * The encrypted secret vault. Every credential Jarvis holds — Gemini key, Google
 * OAuth tokens, Telegram token, etc. — is stored here AES-256-GCM encrypted under
 * your master passphrase. Plaintext secrets exist only transiently in memory.
 *
 * A "check value" is written on first use so a wrong passphrase is detected
 * immediately (rather than producing garbage on the first decrypt).
 */

import type { DB } from "../db";
import { encrypt, decrypt } from "./crypto";

const CHECK_KEY = "__vault_check__";
const CHECK_PLAINTEXT = "jarvis-vault-ok";

export class Vault {
  constructor(
    private db: DB,
    private passphrase: string,
  ) {}

  /** Verify the passphrase, or initialise the vault on first run. Throws on mismatch. */
  unlock(): void {
    const existing = this.raw(CHECK_KEY);
    if (existing === null) {
      this.setRaw(CHECK_KEY, encrypt(CHECK_PLAINTEXT, this.passphrase));
      return;
    }

    let ok = false;
    try {
      ok = decrypt(existing, this.passphrase) === CHECK_PLAINTEXT;
    } catch {
      ok = false;
    }
    if (ok) return;

    // Wrong passphrase. If NO real secrets are stored yet, it's safe to rotate to
    // the new key (nothing to lose). Once real secrets exist, refuse — to protect them.
    if (this.list().length === 0) {
      this.setRaw(CHECK_KEY, encrypt(CHECK_PLAINTEXT, this.passphrase));
      return;
    }
    throw new Error(
      "Vault unlock failed: wrong JARVIS_MASTER_KEY. Your encrypted secrets cannot be read with this passphrase.",
    );
  }

  set(key: string, value: string): void {
    this.setRaw(key, encrypt(value, this.passphrase));
  }

  get(key: string): string | null {
    const enc = this.raw(key);
    if (enc === null) return null;
    return decrypt(enc, this.passphrase);
  }

  has(key: string): boolean {
    return this.raw(key) !== null;
  }

  delete(key: string): void {
    this.db.prepare("DELETE FROM vault WHERE key = ?").run(key);
  }

  /** Secret keys present (names only — never values). */
  list(): string[] {
    const rows = this.db
      .prepare("SELECT key FROM vault WHERE key != ? ORDER BY key")
      .all(CHECK_KEY) as unknown as { key: string }[];
    return rows.map((r) => r.key);
  }

  private raw(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM vault WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row ? row.value : null;
  }

  private setRaw(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO vault (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }
}
