/**
 * Offline smoke test — exercises the whole non-LLM core so we know the foundation
 * is solid before wiring a model. Run: npm run smoke
 */
import { bootstrap } from "../src/core/bootstrap";
import { AGENTS } from "../src/agents/specs";
import { encrypt, decrypt } from "../src/core/security/crypto";

let failures = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? "✓" : "✗"} ${name}`);
  if (!cond) failures++;
}

// 1. Crypto roundtrip + tamper/wrong-key detection
const blob = encrypt("top-secret-token", "correct horse battery staple");
check("crypto: roundtrip", decrypt(blob, "correct horse battery staple") === "top-secret-token");
let wrongKeyThrew = false;
try {
  decrypt(blob, "wrong passphrase");
} catch {
  wrongKeyThrew = true;
}
check("crypto: wrong key rejected", wrongKeyThrew);

// 2. Bootstrap the runtime
const rt = bootstrap((m) => console.log("  ·", m));
check("bootstrap: ok", Boolean(rt));
check("agents: all 21+ registered", AGENTS.length >= 21);
console.log(`  (registered ${AGENTS.length} agents)`);

// 3. Vault encrypted set/get
rt.vault.set("test-secret", "hunter2");
check("vault: encrypted roundtrip", rt.vault.get("test-secret") === "hunter2");
check("vault: lists key names only", rt.vault.list().includes("test-secret"));
rt.vault.delete("test-secret");

// 4. Memory (keyword recall works even without embeddings)
await rt.memory.remember({
  layer: "preference",
  key: "seat-preference",
  content: "Always books the aisle seat; never red-eye flights.",
  source: "smoke-test",
});
const recalled = await rt.memory.recall("which seat does the user like on flights");
check("memory: store + recall", recalled.some((m) => m.key === "seat-preference"));

// 5. Audit log appends
rt.audit.record({
  actor: "smoke",
  action: "test",
  detail: "smoke entry",
  sensitivity: "system",
  reversible: true,
  status: "ok",
});
check("audit: append + read", rt.audit.recent(5).some((e) => e.actor === "smoke"));

// 6. Policy gate behaves
const webFetch = rt.tools.get("web_fetch")!;
const remember = rt.tools.get("remember")!;
const cos = AGENTS.find((a) => a.id === "chief-of-staff")!;
check("policy: read tool allowed", rt.policy.decide(cos, webFetch).decision === "allow");
check("policy: internal write allowed", rt.policy.decide(cos, remember).decision === "allow");
rt.policy.setKill(true);
// (reads still allowed; there are no outward tools in v1 builtin set to block, so just verify flag)
check("policy: kill switch flag set", rt.policy.isKilled());
rt.policy.setKill(false);

console.log(failures === 0 ? "\nALL CHECKS PASSED ✓" : `\n${failures} CHECK(S) FAILED ✗`);
process.exit(failures === 0 ? 0 : 1);
