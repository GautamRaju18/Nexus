/**
 * Rotate the vault master passphrase (NEXUS_MASTER_KEY).
 *
 *   npm run rekey
 *
 * Re-encrypts every stored secret under a NEW passphrase and then updates .env so the
 * next boot uses it — otherwise the vault would be locked out. STOP any running Nexus
 * (web/CLI/Telegram) first: rekeying while a process holds the vault open with the old
 * key would corrupt newly-written secrets.
 *
 * Passwords are read with the terminal echo muted; the key is never logged.
 */

import { createInterface, type Interface } from "node:readline/promises";
import { Writable } from "node:stream";
import { stdin } from "node:process";
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { bootstrap } from "../src/core/bootstrap";

class MutableOut extends Writable {
  muted = false;
  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error | null) => void): void {
    if (!this.muted) process.stdout.write(chunk);
    cb();
  }
}

async function readPipedLines(): Promise<string[]> {
  const chunks: Buffer[] = [];
  for await (const c of stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8").split(/\r?\n/);
}

/** Replace (or append) NEXUS_MASTER_KEY in .env, keeping a one-time backup. Returns true on success. */
function updateEnvKey(newKey: string): boolean {
  const path = ".env";
  if (!existsSync(path)) return false;
  try {
    const raw = readFileSync(path, "utf8");
    if (!existsSync(".env.prerekey")) copyFileSync(path, ".env.prerekey");
    const line = `NEXUS_MASTER_KEY=${newKey}`;
    const next = /^NEXUS_MASTER_KEY=.*$/m.test(raw)
      ? raw.replace(/^NEXUS_MASTER_KEY=.*$/m, line)
      : `${line}\n${raw}`;
    writeFileSync(path, next, "utf8");
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const isTty = Boolean(stdin.isTTY);
  const out = new MutableOut();
  const rl: Interface | null = isTty ? createInterface({ input: stdin, output: out, terminal: true }) : null;
  const queue: string[] = isTty ? [] : await readPipedLines();
  const askHidden = async (q: string): Promise<string> => {
    process.stdout.write(q);
    if (rl) {
      out.muted = true;
      const ans = await rl.question("");
      out.muted = false;
      process.stdout.write("\n");
      return ans;
    }
    const ans = queue.shift() ?? "";
    process.stdout.write("\n");
    return ans;
  };

  let rt;
  try {
    rt = bootstrap(() => {}); // unlocks the vault with the CURRENT NEXUS_MASTER_KEY
  } catch (e) {
    console.error(`\nCan't open the vault with the current NEXUS_MASTER_KEY: ${(e as Error).message}\n`);
    rl?.close();
    process.exit(1);
  }

  try {
    const secrets = rt.vault.list().length;
    console.log(`Vault unlocked. ${secrets} secret(s) will be re-encrypted under the new key.\n`);
    const next = await askHidden("New master key (min 8 chars): ");
    if (next.length < 8) {
      console.error("Too short — the new master key must be at least 8 characters. Nothing changed.");
      return;
    }
    const confirm = await askHidden("Confirm new master key: ");
    if (next !== confirm) {
      console.error("Keys don't match — nothing changed.");
      return;
    }
    const n = rt.vault.rekey(next);
    const envOk = updateEnvKey(next);
    console.log(`\n✓ Re-encrypted ${n} secret(s) under the new master key.`);
    if (envOk) {
      console.log("✓ Updated NEXUS_MASTER_KEY in .env (old .env saved as .env.prerekey).");
      console.log("  Restart Nexus — it'll unlock with the new key. Delete .env.prerekey once you've confirmed it works.");
    } else {
      console.log("⚠ Couldn't update .env automatically. Set NEXUS_MASTER_KEY in .env to your NEW key before restarting,");
      console.log("  or the vault will be locked out.");
    }
  } catch (e) {
    console.error(`Rekey failed (vault unchanged): ${(e as Error).message}`);
    process.exitCode = 1;
  } finally {
    rl?.close();
  }
}

main();
