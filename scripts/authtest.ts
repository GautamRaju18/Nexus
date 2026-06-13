/**
 * Auth + per-user isolation check (real SQLite, temp DB). Verifies that accounts work,
 * sessions resolve/expire, and that two users CANNOT see each other's chat history,
 * long-term memory, or vault data.
 *
 * Run: JARVIS_MASTER_KEY=... JARVIS_DB_PATH=<temp> npm run authtest
 */
import { bootstrap } from "../src/core/bootstrap";

let fail = 0;
const check = (name: string, cond: boolean) => {
  console.log(`${cond ? "✓" : "✗"} ${name}`);
  if (!cond) fail++;
};

const rt = bootstrap(() => {});

// ── Accounts ────────────────────────────────────────────────────────────────
const alice = rt.auth.createUser("alice", "alice-secret");
const bob = rt.auth.createUser("bob", "bob-secret");
check("created two users", alice.username === "alice" && bob.username === "bob");
check("duplicate username rejected", (() => { try { rt.auth.createUser("alice", "x123456"); return false; } catch { return true; } })());

check("wrong password rejected", rt.auth.verify("alice", "nope") === null);
check("right password accepted", rt.auth.verify("alice", "alice-secret")?.id === alice.id);
check("unknown user rejected", rt.auth.verify("carol", "whatever") === null);

// ── Sessions ──────────────────────────────────────────────────────────────────
const aTok = rt.auth.startSession(alice.id);
const bTok = rt.auth.startSession(bob.id);
check("session resolves to its user", rt.auth.resolve(aTok)?.username === "alice");
check("bad token resolves to null", rt.auth.resolve("deadbeef") === null);
check("expired session resolves to null", (() => { const t = rt.auth.startSession(alice.id, -1); return rt.auth.resolve(t) === null; })());

// ── Isolation: long-term memory ────────────────────────────────────────────────
const aScope = rt.scope(alice.id);
const bScope = rt.scope(bob.id);
await aScope.memory.remember({ layer: "preference", key: "seat", content: "prefers aisle seats", source: "test" });
check("alice sees her own memory", aScope.memory.list().some((m) => m.key === "seat"));
check("bob does NOT see alice's memory", bScope.memory.list().length === 0);
check("alice memory count = 1, bob = 0", aScope.memory.count() === 1 && bScope.memory.count() === 0);

// ── Isolation: chat transcripts ────────────────────────────────────────────────
rt.conversations.appendTurn(alice.id, "main", "hi from alice", "hello alice");
check("alice history has her turn", rt.conversations.history(alice.id, "main").length === 2);
check("bob history is empty", rt.conversations.history(bob.id, "main").length === 0);
check("alice recent() returns her turns", rt.conversations.recent(alice.id, "main").length === 2);

// ── Isolation: per-user vault (job profile / finance live here) ─────────────────
aScope.vault.set("finance_transactions", "ALICE-ONLY");
check("alice reads her vault key", aScope.vault.get("finance_transactions") === "ALICE-ONLY");
check("bob CANNOT read alice's vault key", bScope.vault.get("finance_transactions") === null);

// ── removeUser ends sessions ────────────────────────────────────────────────────
rt.auth.removeUser("bob");
check("removed user's session is gone", rt.auth.resolve(bTok) === null);
check("removed user can't log in", rt.auth.verify("bob", "bob-secret") === null);

console.log(fail === 0 ? "\nAUTH + ISOLATION OK ✓" : `\n${fail} CHECK(S) FAILED ✗`);
process.exit(fail === 0 ? 0 : 1);
