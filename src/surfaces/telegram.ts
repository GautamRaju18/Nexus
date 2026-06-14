/**
 * Telegram surface — talk to your whole organization from your phone.
 *
 * - Long-polls getUpdates (offset persisted to KV; messages durably queued before ack).
 * - Routes text to the Orchestrator with rolling conversation history.
 * - Approvals are inline ✅/❌ BUTTONS (idempotent settle, boot-epoch ids, owner-only,
 *   fail-closed if the prompt can't be sent).
 * - LOCKED TO ONE OWNER (TELEGRAM_OWNER_ID); a bad/missing value fails CLOSED.
 *
 * Hardened per adversarial review: durable inbox (no silent message loss on crash),
 * resolve-before-cosmetic-edit, per-request timeouts, 429 retry on sends, and a
 * try/catch around handling so the owner ALWAYS gets a reply.
 *
 * Run:  npm run telegram   (needs TELEGRAM_BOT_TOKEN in .env)
 */

import { bootstrap, type NexusRuntime } from "../core/bootstrap";
import { AGENTS, AGENTS_BY_ID } from "../agents/specs";
import { AutonomyLevel, type ApprovalRequest, type Approver, type LLMMessage } from "../types";
import { splitChunks, parseCb } from "./telegram-util";

const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_TIMEOUT_S = 50;
const OFFSET_KEY = "telegram_offset";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Telegram API helpers ──────────────────────────────────────────────────────
/** Low-level call. Throws on a non-ok response or network/timeout error. */
async function tg(token: string, method: string, params: Record<string, unknown> = {}, timeoutMs = 20000): Promise<any> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(timeoutMs), // never hang the loop on a half-open socket
  });
  const data = (await res.json()) as any;
  if (!data.ok) {
    const err = new Error(`${method} failed ${data.error_code}: ${data.description}`);
    (err as any).retryAfter = data.parameters?.retry_after;
    (err as any).code = data.error_code;
    throw err;
  }
  return data.result;
}

/** Outbound call with retry on 429 (honoring retry_after), 5xx, and network/timeout. */
async function tgSend(token: string, method: string, params: Record<string, unknown> = {}, retries = 2): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await tg(token, method, params);
    } catch (e: any) {
      const ra: number | undefined = e?.retryAfter;
      const code: number | undefined = e?.code;
      const networkish = e?.name === "TimeoutError" || e?.name === "AbortError" || e instanceof TypeError;
      const transient = ra != null || code === 429 || (typeof code === "number" && code >= 500) || networkish;
      if (attempt >= retries || !transient) throw e;
      await sleep(((ra ?? 1) + attempt) * 1000);
    }
  }
}

/** Send plain text (no parse_mode → cannot throw "can't parse entities"), chunked, with retry. */
async function sendText(token: string, chatId: number, text: string): Promise<void> {
  for (const chunk of splitChunks(text || "…")) {
    await tgSend(token, "sendMessage", { chat_id: chatId, text: chunk }).catch((e) =>
      console.error("sendMessage error:", (e as Error).message),
    );
  }
}

// ── Approver: inline buttons, idempotent settle, fail-closed ──────────────────
interface Pending {
  resolve: (ok: boolean) => void;
  chatId: number;
  messageId: number;
  timer: NodeJS.Timeout;
  settled: boolean;
  preview: string;
}

class TelegramApprover implements Approver {
  private pending = new Map<string, Pending>();
  private counter = 0;
  private boot = Date.now().toString(36); // self-invalidates stale buttons across restarts

  constructor(
    private token: string,
    private chatId: number,
    private userId: number,
  ) {}

  async approve(req: ApprovalRequest): Promise<boolean> {
    const id = `${this.boot}.${++this.counter}`;
    const preview =
      `⚠️ Approval needed\n` +
      `Agent: ${AGENTS_BY_ID[req.agentId]?.name ?? req.agentId}\n` +
      `Action: ${req.toolId} (${req.sensitivity})\n` +
      `${req.preview}\n` +
      `Reversible: ${req.reversible ? "yes" : "no"}`;

    // Fail CLOSED: if we can't show the prompt, deny (never leave the action ambiguous).
    let sent: any;
    try {
      sent = await tgSend(this.token, "sendMessage", {
        chat_id: this.chatId,
        text: preview,
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✅ Approve", callback_data: `v1|a|${id}` },
              { text: "❌ Deny", callback_data: `v1|d|${id}` },
            ],
          ],
        },
      });
    } catch (e) {
      console.error("approval prompt failed:", (e as Error).message);
      void sendText(this.token, this.chatId, "⚠️ I couldn't show an approval prompt, so I did NOT take that action. Please try again.").catch(() => {});
      return false;
    }

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => this.settle(id, false, "timeout"), APPROVAL_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, { resolve, chatId: this.chatId, messageId: sent.message_id, timer, settled: false, preview });
    });
  }

  /** Called by the poll loop for every callback_query update. */
  async handleCallback(q: any): Promise<void> {
    const parsed = parseCb(q.data ?? "");
    if (!parsed) return void this.answer(q.id, "This button is no longer valid.");
    if (q.from?.id !== this.userId) return void this.answer(q.id, "You are not authorized.", true);

    const entry = this.pending.get(parsed.id);
    if (!entry) {
      await this.answer(q.id, "This request has expired.");
      if (q.message)
        void tgSend(this.token, "editMessageReplyMarkup", {
          chat_id: q.message.chat.id,
          message_id: q.message.message_id,
          reply_markup: { inline_keyboard: [] },
        }).catch(() => {});
      return;
    }
    await this.answer(q.id, parsed.decision ? "Approving…" : "Denying…");
    this.settle(parsed.id, parsed.decision, "user");
  }

  /** The single idempotent funnel. Resolves the waiter FIRST; the cosmetic edit is detached. */
  private settle(id: string, decision: boolean, reason: "user" | "timeout"): void {
    const entry = this.pending.get(id);
    if (!entry || entry.settled) return;
    entry.settled = true;
    clearTimeout(entry.timer);
    this.pending.delete(id); // delete BEFORE anything async → atomic against double-tap
    entry.resolve(decision); // resolve immediately — control flow never waits on the UI edit

    const verdict = decision ? "✅ Approved" : "❌ Denied";
    const suffix = reason === "timeout" ? " (timed out)" : "";
    void tgSend(this.token, "editMessageText", {
      chat_id: entry.chatId,
      message_id: entry.messageId,
      text: `${entry.preview}\n\n${verdict}${suffix}`,
      reply_markup: { inline_keyboard: [] },
    }).catch(() => {});
  }

  private async answer(callbackId: string, text?: string, alert = false): Promise<void> {
    await tgSend(this.token, "answerCallbackQuery", { callback_query_id: callbackId, text, show_alert: alert }).catch(() => {});
  }
}

// ── Remote commands (a useful subset of the CLI's) ────────────────────────────
async function handleCommand(rt: NexusRuntime, token: string, chatId: number, text: string, fromId: number): Promise<void> {
  const [cmd, ...rest] = text.slice(1).split(/\s+/);
  const reply = (m: string) => sendText(token, chatId, m);

  switch (cmd) {
    case "start":
    case "help":
      return reply(
        "I'm Nexus — your AI Chief of Staff. Just tell me an outcome:\n" +
          "• check my unread email\n• what's on my calendar this week\n• schedule a focus block tomorrow 10am\n• research X and summarize\n\n" +
          "Commands: /brief /agents /memory /audit /autonomy /kill /google /id /help",
      );
    case "id":
      return reply(`Your Telegram ID is ${fromId}.`);
    case "kill": {
      const now = !rt.policy.isKilled();
      rt.policy.setKill(now);
      return reply(now ? "⚠️ Kill switch ENGAGED — all outward actions paused." : "✅ Kill switch released.");
    }
    case "agents":
      return reply(AGENTS.map((a) => `• ${a.id} — ${a.purpose}`).join("\n"));
    case "memory": {
      const all = rt.memory.list().slice(0, 25);
      return reply(all.length ? all.map((m) => `[${m.layer}] ${m.key}: ${m.content}`).join("\n") : "(no memories yet)");
    }
    case "audit": {
      const es = rt.audit.recent(15);
      return reply(
        es.length
          ? es.map((e) => `${new Date(e.ts).toLocaleTimeString()} ${e.actor} ${e.action} ${e.status}`).join("\n")
          : "(no actions logged)",
      );
    }
    case "autonomy": {
      const [id, lvl] = rest;
      if (!id) return reply(AGENTS.map((a) => `${a.id}: L${rt.policy.autonomyFor(a)} (max L${a.autonomyCeiling})`).join("\n"));
      const spec = AGENTS_BY_ID[id];
      if (!spec) return reply(`Unknown agent: ${id}`);
      if (lvl === undefined) return reply(`${id}: L${rt.policy.autonomyFor(spec)} (max L${spec.autonomyCeiling})`);
      const n = Number(lvl);
      if (!Number.isInteger(n) || n < 0 || n > 5) return reply("Level must be 0–5.");
      if (n > spec.autonomyCeiling) return reply(`${id} is capped at L${spec.autonomyCeiling}.`);
      rt.policy.setAutonomy(id, n as AutonomyLevel);
      return reply(`${id} autonomy set to L${n}.`);
    }
    case "google":
      return reply(
        `Google: ${rt.google.isConfigured() ? "configured" : "not configured"} · ${rt.google.isConnected() ? "connected ✓" : "not connected"}`,
      );
    case "connect":
      return reply("Run /connect in the desktop CLI — it opens your browser for Google sign-in. (Can't do that over Telegram.)");
    default:
      return reply(`Unknown command: /${cmd} (try /help)`);
  }
}

// ── Main loop ─────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const rt = bootstrap((m) => console.log(`  · ${m}`));
  const token = rt.cfg.telegramToken;
  if (!token) {
    console.error("\nSet TELEGRAM_BOT_TOKEN in .env (from @BotFather). See README.\n");
    process.exit(1);
  }

  // Owner lock — fail CLOSED on a malformed value rather than running unlocked.
  const ownerRaw = rt.cfg.telegramOwnerId.trim();
  let ownerId: number | null = null;
  if (ownerRaw) {
    if (!/^\d+$/.test(ownerRaw)) {
      console.error(`\nTELEGRAM_OWNER_ID="${ownerRaw}" is not a numeric Telegram user id — refusing to start unlocked.\n`);
      process.exit(1);
    }
    ownerId = Number(ownerRaw);
  }

  let me: any;
  try {
    me = await tg(token, "getMe");
  } catch (e) {
    console.error(`\nBad TELEGRAM_BOT_TOKEN: ${(e as Error).message}\n`);
    process.exit(1);
  }

  // Durable inbox + persisted offset.
  const db = rt.db;
  const insertInbox = db.prepare("INSERT OR IGNORE INTO telegram_inbox (update_id, msg, done, created_at) VALUES (?, ?, 0, ?)");
  const markDone = db.prepare("UPDATE telegram_inbox SET done = 1 WHERE update_id = ?");
  const pendingInbox = () =>
    db.prepare("SELECT update_id, msg FROM telegram_inbox WHERE done = 0 ORDER BY update_id").all() as unknown as {
      update_id: number;
      msg: string;
    }[];

  const savedOffset = rt.kv.get(OFFSET_KEY);
  let offset = savedOffset ? Number(savedOffset) : 0;
  // First run: start clean. Resume: keep any backlog (don't drop), so nothing is lost.
  await tg(token, "deleteWebhook", { drop_pending_updates: !savedOffset }).catch(() => {});

  console.log(`\n  Nexus on Telegram as @${me.username}`);
  console.log(`  brain: ${rt.llm.name} · owner: ${ownerId ?? "(unset — first message shows the id to add)"}\n`);

  const approver = ownerId ? new TelegramApprover(token, ownerId, ownerId) : null;
  const orch = approver ? rt.buildOrchestrator(approver) : null;
  const history: LLMMessage[] = [];

  // Proactive nudges: deliver due reminders straight to the owner's chat. Only runs
  // once the owner is known (otherwise there's no one to notify).
  if (ownerId !== null) {
    rt.startScheduler((r) => {
      const when = r.recurrence ? ` _(repeats ${r.recurrence})_` : "";
      void tgSend(token, "sendMessage", { chat_id: ownerId, text: `⏰ Reminder: ${r.text}${when}`, parse_mode: "Markdown" }).catch(
        (e) => console.error("reminder send failed:", (e as Error).message),
      );
    }, "owner");
  }

  // Messages are processed serially on this chain; the poll loop NEVER awaits it
  // (otherwise a message awaiting an approval would block delivery of the button press).
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (msg: any, updateId: number) => {
    queue = queue.then(() => processMessage(msg, updateId)).catch((e) => console.error("queue error:", (e as Error).message));
  };

  // Reprocess anything left un-done from a previous crash (at-least-once).
  for (const row of pendingInbox()) {
    try {
      enqueue(JSON.parse(row.msg), row.update_id);
    } catch {
      markDone.run(row.update_id);
    }
  }

  for (;;) {
    let updates: any[];
    try {
      updates = await tg(
        token,
        "getUpdates",
        { offset, timeout: POLL_TIMEOUT_S, allowed_updates: ["message", "callback_query"] },
        (POLL_TIMEOUT_S + 15) * 1000,
      );
    } catch (e) {
      const wait = ((e as any).retryAfter ?? 3) * 1000;
      console.error(`getUpdates error (${(e as Error).message}); retrying in ${wait}ms`);
      await sleep(wait);
      continue;
    }

    for (const u of updates) {
      if (u.callback_query) {
        // Handled inline (fast) — this is what UNBLOCKS an awaiting message.
        if (approver) await approver.handleCallback(u.callback_query).catch((e) => console.error("callback error:", (e as Error).message));
        else await tgSend(token, "answerCallbackQuery", { callback_query_id: u.callback_query.id }).catch(() => {});
      } else if (u.message && typeof u.message.text === "string") {
        // Persist BEFORE advancing offset, so a crash mid-processing reprocesses it.
        // INSERT OR IGNORE: if it's already in the inbox (redelivery after a crash),
        // changes===0 and the startup-reprocess pass already enqueued it — don't double up.
        const r = insertInbox.run(u.update_id, JSON.stringify(u.message), Date.now());
        if (Number(r.changes) > 0) enqueue(u.message, u.update_id);
      }
      offset = u.update_id + 1;
    }
    if (updates.length) rt.kv.set(OFFSET_KEY, String(offset));
  }

  async function processMessage(msg: any, updateId: number): Promise<void> {
    const chatId = msg.chat.id;
    try {
      const fromId = msg.from?.id;

      // Owner lock — the security boundary.
      if (!ownerId) {
        await sendText(
          token,
          chatId,
          `👋 I'm Nexus. To activate me for your account only, add this to your .env and restart:\n\nTELEGRAM_OWNER_ID=${fromId}\n\nThis locks the bot to you.`,
        );
        return;
      }
      if (fromId !== ownerId) {
        await sendText(token, chatId, "Sorry — this Nexus is private.");
        return;
      }

      const text = msg.text.trim();
      if (!text) return;
      if (text.startsWith("/")) {
        await handleCommand(rt, token, chatId, text, fromId);
        return;
      }

      await tgSend(token, "sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
      const answer = await orch!.handle(text, { history: history.slice(-8) });
      await sendText(token, chatId, answer);
      history.push({ role: "user", content: text }, { role: "assistant", content: answer });
    } catch (e) {
      // The owner ALWAYS gets a reply, even when the brain/tools fail.
      console.error("processMessage error:", (e as Error).message);
      await sendText(token, chatId, `⚠️ Something went wrong handling that: ${(e as Error).message}`).catch(() => {});
    } finally {
      markDone.run(updateId); // attempted (replied or error-replied) → don't reprocess on restart
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
