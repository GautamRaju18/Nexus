/**
 * Reminder tools for the Secretary (and Chief of Staff). These write to Nexus's
 * OWN local store, so they're `internal` (audited but never gated) — a reminder
 * is a note-to-self, not an outward action.
 *
 *   reminder_set    — schedule a nudge at an ISO time or in N minutes (optionally recurring)
 *   reminder_list   — see what's pending
 *   reminder_cancel — drop a pending reminder
 *
 * The Scheduler (core/scheduler.ts) fires due reminders; a surface delivers them.
 */

import { z } from "zod";
import type { ToolDefinition } from "../types";
import type { Recurrence } from "./reminders";

const RECURRENCES = ["hourly", "daily", "weekly"] as const;

/** Parse a due time from either an ISO datetime (`at`) or a relative `inMinutes`. */
function resolveDueAt(i: Record<string, unknown>): { dueAt?: number; error?: string } {
  const at = (i.at || i.when || i.time || i.datetime) as string | undefined;
  const inMinutes =
    typeof i.inMinutes === "number"
      ? i.inMinutes
      : typeof i.in_minutes === "number"
        ? i.in_minutes
        : typeof i.minutes === "number"
          ? i.minutes
          : undefined;

  if (typeof inMinutes === "number") {
    if (!Number.isFinite(inMinutes) || inMinutes <= 0) return { error: "inMinutes must be a positive number" };
    return { dueAt: Date.now() + inMinutes * 60_000 };
  }
  if (at) {
    const ms = Date.parse(at);
    if (Number.isNaN(ms)) return { error: `couldn't parse the time "${at}" — pass an ISO datetime like 2026-06-13T18:30:00` };
    return { dueAt: ms };
  }
  return { error: "provide either an ISO `at` time or `inMinutes`" };
}

export function reminderTools(): ToolDefinition[] {
  const reminderSet: ToolDefinition = {
    id: "reminder_set",
    description:
      "Set a reminder/nudge. Input: { text, at? (ISO datetime), inMinutes? (number), recurrence? (hourly|daily|weekly) }. " +
      "Provide text plus EITHER an ISO `at` time OR `inMinutes`. Use recurrence for repeating nudges. " +
      "Nexus will surface the reminder when it's due.",
    sensitivity: "write",
    internal: true,
    scopes: ["personal"],
    input: z
      .object({
        text: z.string().min(1, "what should I remind you about?"),
        at: z.string().optional(),
        inMinutes: z.number().optional(),
        recurrence: z.enum(RECURRENCES).optional(),
      })
      .passthrough(),
    handler: async (input, ctx) => {
      const i = input as Record<string, unknown>;
      const text = (i.text || i.message || i.note || i.what) as string | undefined;
      if (!text) return { error: "what should I remind you about?" };
      const { dueAt, error } = resolveDueAt(i);
      if (error || dueAt === undefined) return { error };

      const recRaw = (i.recurrence || i.repeat || i.every) as string | undefined;
      const recurrence = (RECURRENCES as readonly string[]).includes(String(recRaw))
        ? (recRaw as Recurrence)
        : null;

      const r = ctx.services.reminders.add({ text, dueAt, recurrence, agent: ctx.agentId });
      return {
        set: true,
        id: r.id,
        due: new Date(r.dueAt).toISOString(),
        dueLocal: new Date(r.dueAt).toLocaleString(),
        recurrence: r.recurrence,
      };
    },
  };

  const reminderList: ToolDefinition = {
    id: "reminder_list",
    description:
      "List reminders. Optional { status: pending|fired|cancelled|all } (default pending). Returns text, due time, and recurrence.",
    sensitivity: "read",
    internal: true,
    scopes: ["personal"],
    input: z.object({}).passthrough(),
    handler: async (input, ctx) => {
      const status = (input as { status?: string }).status?.toLowerCase();
      const valid = ["pending", "fired", "cancelled", "all"];
      const reminders = ctx.services.reminders.list({
        status: (valid.includes(status ?? "") ? status : "pending") as "pending" | "fired" | "cancelled" | "all",
      });
      return {
        reminders: reminders.map((r) => ({
          id: r.id,
          text: r.text,
          due: new Date(r.dueAt).toISOString(),
          dueLocal: new Date(r.dueAt).toLocaleString(),
          recurrence: r.recurrence,
          status: r.status,
        })),
        count: reminders.length,
      };
    },
  };

  const reminderCancel: ToolDefinition = {
    id: "reminder_cancel",
    description: "Cancel a pending reminder by its id (from reminder_list). Input: { id }.",
    sensitivity: "write",
    internal: true,
    scopes: ["personal"],
    input: z.object({ id: z.string().min(1, "provide the reminder id from reminder_list") }).passthrough(),
    handler: async (input, ctx) => {
      const id = (input as { id: string }).id;
      const cancelled = ctx.services.reminders.cancel(id);
      return cancelled ? { cancelled: true, id } : { cancelled: false, error: "no pending reminder with that id" };
    },
  };

  return [reminderSet, reminderList, reminderCancel];
}
