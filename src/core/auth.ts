/**
 * Authentication for the web cockpit. Accounts are PRE-SEEDED with the user CLI
 * (scripts/user.ts) — there is no public registration. Passwords are hashed with
 * scrypt (Node built-in, no dependency) under a per-user random salt, and verified
 * in constant time. A logged-in browser carries an opaque random session token in an
 * HttpOnly cookie; the token maps to a user_id server-side and expires.
 *
 * The user_id this issues is the tenant key threaded everywhere for per-user isolation
 * (see bootstrap.ts `scope()`).
 */

import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { DB } from "./db";

export interface User {
  id: string;
  username: string;
}
export interface Session {
  userId: string;
  username: string;
}

const SCRYPT_KEYLEN = 64;
const SESSION_TTL_DAYS = 30;

function hashPassword(password: string, saltHex: string): string {
  return scryptSync(password, Buffer.from(saltHex, "hex"), SCRYPT_KEYLEN).toString("hex");
}

export class AuthStore {
  constructor(private db: DB) {}

  // ── Accounts ────────────────────────────────────────────────────────────────
  /** Create a user. Throws if the username is taken. Returns the new user. */
  createUser(username: string, password: string): User {
    const name = username.trim().toLowerCase();
    if (!/^[a-z0-9_.-]{2,32}$/.test(name)) {
      throw new Error("username must be 2–32 chars: letters, digits, and . _ - only");
    }
    if (password.length < 6) throw new Error("password must be at least 6 characters");
    if (this.findByUsername(name)) throw new Error(`user "${name}" already exists`);

    const id = randomUUID();
    const salt = randomBytes(16).toString("hex");
    const hash = hashPassword(password, salt);
    this.db
      .prepare("INSERT INTO users (id, username, pw_hash, pw_salt, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, name, hash, salt, Date.now());
    return { id, username: name };
  }

  /** Verify credentials in constant time. Returns the user, or null on any mismatch. */
  verify(username: string, password: string): User | null {
    const row = this.findByUsername(username.trim().toLowerCase());
    if (!row) {
      // Equalize timing against a dummy hash so a missing user isn't distinguishable.
      hashPassword(password, "00000000000000000000000000000000");
      return null;
    }
    const got = Buffer.from(hashPassword(password, row.pw_salt), "hex");
    const want = Buffer.from(row.pw_hash, "hex");
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    return { id: row.id, username: row.username };
  }

  listUsers(): User[] {
    const rows = this.db
      .prepare("SELECT id, username FROM users ORDER BY username")
      .all() as unknown as { id: string; username: string }[];
    return rows;
  }

  removeUser(username: string): boolean {
    const name = username.trim().toLowerCase();
    const u = this.findByUsername(name);
    if (!u) return false;
    this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(u.id);
    this.db.prepare("DELETE FROM users WHERE id = ?").run(u.id);
    return true;
  }

  // ── Sessions ──────────────────────────────────────────────────────────────────
  /** Start a session for a user id; returns the opaque token to set as a cookie. */
  startSession(userId: string, ttlDays = SESSION_TTL_DAYS): string {
    const token = randomBytes(32).toString("hex");
    const now = Date.now();
    this.db
      .prepare("INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .run(token, userId, now, now + ttlDays * 86_400_000);
    return token;
  }

  /** Resolve a session token to {userId, username}, or null if missing/expired. */
  resolve(token: string | undefined | null): Session | null {
    if (!token) return null;
    const row = this.db
      .prepare(
        `SELECT s.user_id AS userId, s.expires_at AS expiresAt, u.username AS username
         FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`,
      )
      .get(token) as unknown as { userId: string; expiresAt: number; username: string } | undefined;
    if (!row) return null;
    if (row.expiresAt < Date.now()) {
      this.endSession(token);
      return null;
    }
    return { userId: row.userId, username: row.username };
  }

  endSession(token: string): void {
    this.db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
  }

  /** Housekeeping: drop expired sessions. Safe to call on boot. */
  purgeExpired(): void {
    this.db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now());
  }

  private findByUsername(
    username: string,
  ): { id: string; username: string; pw_hash: string; pw_salt: string } | undefined {
    return this.db.prepare("SELECT id, username, pw_hash, pw_salt FROM users WHERE username = ?").get(username) as
      | { id: string; username: string; pw_hash: string; pw_salt: string }
      | undefined;
  }
}
