/**
 * Authenticated symmetric encryption for secrets at rest.
 *
 * Uses AES-256-GCM (confidentiality + integrity). The key is derived from your
 * master passphrase with scrypt and a per-install random salt, so the passphrase
 * itself is never stored. Encrypted blobs are self-describing: salt + iv + tag are
 * packed alongside the ciphertext.
 */

import {
  randomBytes,
  scryptSync,
  createCipheriv,
  createDecipheriv,
  timingSafeEqual,
} from "node:crypto";

const ALGO = "aes-256-gcm";
const KEY_LEN = 32;
const IV_LEN = 12;
const SALT_LEN = 16;
const TAG_LEN = 16;

/** Derive a 256-bit key from a passphrase + salt. */
export function deriveKey(passphrase: string, salt: Buffer): Buffer {
  // scrypt parameters tuned for interactive use; raise N for more hardness.
  // N=2^15 needs ~32MB, so lift maxmem above Node's 32MB default.
  return scryptSync(passphrase, salt, KEY_LEN, {
    N: 2 ** 15,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
}

/**
 * Encrypt a UTF-8 string. Output layout (base64):
 *   [ salt(16) | iv(12) | tag(16) | ciphertext ]
 * The salt is embedded so each value can be decrypted with only the passphrase.
 */
export function encrypt(plaintext: string, passphrase: string): string {
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = deriveKey(passphrase, salt);

  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([salt, iv, tag, ciphertext]).toString("base64");
}

/** Decrypt a value produced by encrypt(). Throws if the passphrase is wrong or data tampered. */
export function decrypt(packed: string, passphrase: string): string {
  const buf = Buffer.from(packed, "base64");
  const salt = buf.subarray(0, SALT_LEN);
  const iv = buf.subarray(SALT_LEN, SALT_LEN + IV_LEN);
  const tag = buf.subarray(SALT_LEN + IV_LEN, SALT_LEN + IV_LEN + TAG_LEN);
  const ciphertext = buf.subarray(SALT_LEN + IV_LEN + TAG_LEN);

  const key = deriveKey(passphrase, salt);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/** Constant-time string compare for secrets (e.g. verifying a stored check value). */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
