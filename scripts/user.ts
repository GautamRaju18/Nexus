/**
 * Account management for the web cockpit. Accounts are PRE-SEEDED here — there is no
 * public registration — so creating a login is a deliberate, local, admin action.
 *
 *   npm run user -- add <username>      prompt for a password (twice), create the user
 *   npm run user -- list                list usernames
 *   npm run user -- remove <username>   delete a user and end their sessions
 *
 * Passwords are read with the terminal echo muted and stored scrypt-hashed (core/auth.ts).
 */

import { createInterface, type Interface } from "node:readline/promises";
import { Writable } from "node:stream";
import { stdin } from "node:process";
import { bootstrap } from "../src/core/bootstrap";

// A stdout proxy whose echo we can mute while typing a password (interactive only).
class MutableOut extends Writable {
  muted = false;
  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error | null) => void): void {
    if (!this.muted) process.stdout.write(chunk);
    cb();
  }
}

/** Drain piped stdin to lines up front (so it isn't lost while bootstrap runs). */
async function readPipedLines(): Promise<string[]> {
  const chunks: Buffer[] = [];
  for await (const c of stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8").split(/\r?\n/);
}

async function main(): Promise<void> {
  const [cmd, arg] = process.argv.slice(2);
  const isTty = Boolean(stdin.isTTY); // false when piped (automation/tests)

  // Interactive: readline with muted-echo password entry. Piped: pre-read a line queue.
  const out = new MutableOut();
  const rl: Interface | null = isTty ? createInterface({ input: stdin, output: out, terminal: true }) : null;
  const queue: string[] = isTty ? [] : await readPipedLines();

  const ask = async (q: string): Promise<string> => {
    if (rl) return (await rl.question(q)).trim();
    process.stdout.write(q);
    return (queue.shift() ?? "").trim();
  };
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
    rt = bootstrap(() => {});
  } catch (e) {
    console.error(`\nStartup failed: ${(e as Error).message}\n`);
    rl?.close();
    process.exit(1);
  }

  try {
    switch (cmd) {
      case "add": {
        const username = arg || (await ask("Username: "));
        if (!username) {
          console.error("A username is required.");
          break;
        }
        const pw = await askHidden(`Password for "${username}": `);
        const confirm = await askHidden("Confirm password: ");
        if (pw !== confirm) {
          console.error("Passwords don't match — nothing created.");
          break;
        }
        const user = rt.auth.createUser(username, pw);
        console.log(`✓ Created user "${user.username}". They can now log in at the web cockpit.`);
        break;
      }
      case "list": {
        const users = rt.auth.listUsers();
        console.log(users.length ? users.map((u) => `  • ${u.username}`).join("\n") : "  (no users yet — add one with: npm run user -- add <username>)");
        break;
      }
      case "remove":
      case "rm":
      case "delete": {
        const username = arg || (await ask("Username to remove: "));
        const ok = rt.auth.removeUser(username);
        console.log(ok ? `✓ Removed "${username}" and ended their sessions.` : `No such user: "${username}".`);
        break;
      }
      default:
        console.log(
          [
            "Jarvis account manager — accounts are pre-seeded (no public sign-up).",
            "",
            "  npm run user -- add <username>      create a login (prompts for a password)",
            "  npm run user -- list                list usernames",
            "  npm run user -- remove <username>   delete a user",
            "",
          ].join("\n"),
        );
    }
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exitCode = 1;
  } finally {
    rl?.close();
  }
}

main();
