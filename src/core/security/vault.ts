/**
 * The encrypted secret vault. Every credential Nexus holds — Gemini key, Google
 * OAuth tokens, Telegram token, etc. — is stored here AES-256-GCM encrypted under
 * your master passphrase. Plaintext secrets exist only transiently in memory.
 *
 * A "check value" is written on first use so a wrong passphrase is detected
 * immediately (rather than producing garbage on the first decrypt).
 */

import type { DB } from "../db";
import { encrypt, decrypt } from "./crypto";

const CHECK_KEY = "__vault_check__";
const CHECK_PLAINTEXT = "nexus-vault-ok";
// Vaults created before the Jarvis→Nexus rebrand stored this sentinel. We still accept
// it on unlock (then transparently re-stamp the new one) so existing vaults aren't
// locked out by the rename. The master passphrase itself is unchanged.
const LEGACY_CHECK_PLAINTEXT = "jarvis-vault-ok";

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
      const dec = decrypt(existing, this.passphrase);
      if (dec === CHECK_PLAINTEXT) {
        ok = true;
      } else if (dec === LEGACY_CHECK_PLAINTEXT) {
        // Correct passphrase, pre-rebrand sentinel — migrate it in place.
        this.setRaw(CHECK_KEY, encrypt(CHECK_PLAINTEXT, this.passphrase));
        ok = true;
      }
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
      "Vault unlock failed: wrong NEXUS_MASTER_KEY. Your encrypted secrets cannot be read with this passphrase.",
    );
  }

  /**
   * Rotate the master passphrase. Re-encrypts EVERY stored secret (and the check value)
   * under `newPassphrase`, then switches this live instance to it. Must be called on a
   * vault already unlocked with the current passphrase. Atomic: the whole re-encryption
   * runs in one transaction, so a crash can't leave the vault half old-key / half new-key.
   * Returns the number of secrets re-encrypted.
   */
  rekey(newPassphrase: string): number {
    if (!newPassphrase || newPassphrase.length < 8) {
      throw new Error("the new master key must be at least 8 characters");
    }
    // Refuse unless we can actually read the vault with the CURRENT passphrase — otherwise
    // we'd "rotate" garbage and permanently lose the real secrets.
    const check = this.raw(CHECK_KEY);
    if (check !== null) {
      const dec = decrypt(check, this.passphrase); // throws if the current key is wrong
      if (dec !== CHECK_PLAINTEXT && dec !== LEGACY_CHECK_PLAINTEXT) {
        throw new Error("vault is not unlocked with the current passphrase — refusing to rekey");
      }
    }
    const keys = this.list();
    // Decrypt-then-reencrypt everything up front (in memory) so a bad decrypt aborts
    // BEFORE we write anything.
    const reencrypted = keys.map((key) => {
      const enc = this.raw(key);
      return { key, value: enc === null ? null : encrypt(decrypt(enc, this.passphrase), newPassphrase) };
    });
    this.db.exec("BEGIN");
    try {
      for (const { key, value } of reencrypted) if (value !== null) this.setRaw(key, value);
      this.setRaw(CHECK_KEY, encrypt(CHECK_PLAINTEXT, newPassphrase));
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    this.passphrase = newPassphrase;
    return keys.length;
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
