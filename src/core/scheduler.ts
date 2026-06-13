/**
 * The proactive heartbeat. A tiny in-process scheduler — no node-cron, no extra
 * dependency — that polls the ReminderStore on an interval and hands each due
 * reminder to a surface-supplied delivery function (CLI prints it, Telegram DMs it).
 *
 * This is the foundation the roadmap calls for under "Phase 2 — proactivity":
 * renewal watches, cold-thread nudges, and briefs become extra producers that
 * enqueue reminders, all delivered through this one loop.
 *
 * Delivery is best-effort and isolated: one reminder throwing never stops the loop
 * or blocks the others, and a reminder is settled (rescheduled or marked fired)
 * even if delivery fails, so a flaky surface can't cause an infinite re-fire.
 */

import type { Reminder, ReminderStore } from "./reminders";

export type Deliver = (reminder: Reminder) => void | Promise<void>;

export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private reminders: ReminderStore,
    private deliver: Deliver,
    private intervalMs = 30_000,
    private log: (msg: string) => void = () => {},
    /** If set, only this tenant's reminders are delivered/settled (others left pending
     *  for another surface). Single-user surfaces pass "owner"; the web passes none and
     *  routes each due reminder to its own user. */
    private userFilter?: string,
  ) {}

  /** Begin polling. Runs one tick immediately so a just-passed reminder fires at once. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    // Don't keep the event loop alive just for the scheduler (lets the CLI exit cleanly).
    (this.timer as { unref?: () => void }).unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    let due: Reminder[];
    try {
      due = this.reminders.due();
      if (this.userFilter) due = due.filter((r) => r.userId === this.userFilter);
    } catch (e) {
      this.log(`scheduler: failed to read due reminders — ${(e as Error).message}`);
      return;
    }
    for (const r of due) {
      try {
        await this.deliver(r);
      } catch (e) {
        this.log(`scheduler: delivery failed for reminder ${r.id} — ${(e as Error).message}`);
      } finally {
        // Settle regardless of delivery outcome so we never re-fire the same due window.
        try {
          this.reminders.markFired(r.id);
        } catch (e) {
          this.log(`scheduler: failed to settle reminder ${r.id} — ${(e as Error).message}`);
        }
      }
    }
  }
}
