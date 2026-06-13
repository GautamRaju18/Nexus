/**
 * Gmail + Google Calendar tools. These act on the user's OWN account via their
 * OAuth grant, so there is no third-party cost — Jarvis is automating the user.
 *
 * Sensitivity drives the approval gate (see policy.ts):
 *   read  — gmail_list, gmail_read, gcal_list           → run freely (audited)
 *   write — gmail_draft, gcal_create, gcal_update        → gated until autonomy L4
 *   comms — gmail_send                                   → always gated until L4
 */

import { z } from "zod";
import type { ToolContext, ToolDefinition } from "../types";

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const CAL = "https://www.googleapis.com/calendar/v3/calendars/primary";

async function authed(
  ctx: ToolContext,
  url: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Response> {
  const token = await ctx.services.google.getAccessToken();
  return fetch(url, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
}

function base64url(s: string): string {
  return Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromBase64url(s: string): string {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

/** Build an RFC-822 message and base64url-encode it for the Gmail API. */
function buildRaw(p: { to: string; subject: string; body: string; cc?: string }): string {
  const headers = [`To: ${p.to}`];
  if (p.cc) headers.push(`Cc: ${p.cc}`);
  headers.push(`Subject: ${p.subject}`, "MIME-Version: 1.0", 'Content-Type: text/plain; charset="UTF-8"');
  return base64url(headers.join("\r\n") + "\r\n\r\n" + p.body);
}

/** Recursively pull the first text/plain body out of a Gmail payload. */
function extractText(payload: any): string {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) return fromBase64url(payload.body.data);
  for (const part of payload.parts ?? []) {
    const t = extractText(part);
    if (t) return t;
  }
  if (payload.body?.data) return fromBase64url(payload.body.data);
  return "";
}

const header = (msg: any, name: string): string =>
  msg.payload?.headers?.find((h: any) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";

export function googleTools(): ToolDefinition[] {
  const gmailList: ToolDefinition = {
    id: "gmail_list",
    description:
      "List recent emails. Optional Gmail search query (e.g. 'is:unread', 'from:boss', 'newer_than:2d'). Returns id, from, subject, date, snippet.",
    sensitivity: "read",
    scopes: ["email"],
    input: z.object({}).passthrough(),
    handler: async (input, ctx) => {
      const i = input as Record<string, unknown>;
      const q = (i.query || i.q || "") as string;
      const limit = Math.min(typeof i.limit === "number" ? i.limit : 10, 25);
      const listRes = await authed(ctx, `${GMAIL}/messages?maxResults=${limit}&q=${encodeURIComponent(q)}`);
      if (!listRes.ok) return { error: `gmail list failed: ${listRes.status} ${await listRes.text()}` };
      const { messages } = (await listRes.json()) as { messages?: { id: string }[] };
      if (!messages?.length) return { emails: [] };
      const emails = [];
      for (const m of messages) {
        const r = await authed(
          ctx,
          `${GMAIL}/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
        );
        if (!r.ok) continue;
        const data = await r.json();
        emails.push({
          id: m.id,
          from: header(data, "From"),
          subject: header(data, "Subject"),
          date: header(data, "Date"),
          snippet: (data as any).snippet,
        });
      }
      return { emails };
    },
  };

  const gmailRead: ToolDefinition = {
    id: "gmail_read",
    description: "Read the full body of one email by its id (from gmail_list).",
    sensitivity: "read",
    scopes: ["email"],
    input: z.object({ id: z.string().min(1, "provide the email id from gmail_list") }).passthrough(),
    handler: async (input, ctx) => {
      const id = (input as Record<string, unknown>).id as string;
      if (!id) return { error: "provide the email id" };
      const r = await authed(ctx, `${GMAIL}/messages/${id}?format=full`);
      if (!r.ok) return { error: `gmail read failed: ${r.status}` };
      const data = await r.json();
      return {
        id,
        from: header(data, "From"),
        to: header(data, "To"),
        subject: header(data, "Subject"),
        date: header(data, "Date"),
        body: extractText((data as any).payload).slice(0, 6000),
      };
    },
  };

  const gmailDraft: ToolDefinition = {
    id: "gmail_draft",
    description:
      "Create a DRAFT reply in the user's Gmail (does not send). Use ONLY when the CEO asked you to write/reply to a specific message — never for triage or summaries. Input: { to, subject, body, cc? } — all of to/subject/body are required and must be real (no placeholders).",
    sensitivity: "write",
    scopes: ["email"],
    input: z
      .object({
        to: z.string().min(3, "recipient email (to) is required"),
        subject: z.string().min(1, "subject is required"),
        body: z.string().min(1, "body is required"),
        cc: z.string().optional(),
      })
      .passthrough(),
    handler: async (input, ctx) => {
      const i = input as Record<string, string>;
      if (!i.to || !i.subject || !i.body) return { error: "need to, subject, and body" };
      const raw = buildRaw({ to: i.to, subject: i.subject, body: i.body, cc: i.cc });
      const r = await authed(ctx, `${GMAIL}/drafts`, { method: "POST", body: { message: { raw } } });
      if (!r.ok) return { error: `draft failed: ${r.status} ${await r.text()}` };
      const data = await r.json();
      return { drafted: true, draftId: (data as any).id, note: "Draft saved in Gmail for your review." };
    },
  };

  const gmailSend: ToolDefinition = {
    id: "gmail_send",
    description:
      "SEND an email from the user's account. Use ONLY when the CEO explicitly asked to send a message. Input: { to, subject, body, cc? } — all of to/subject/body are required and must be real. This is an outward action and requires approval.",
    sensitivity: "comms",
    scopes: ["email"],
    input: z
      .object({
        to: z.string().min(3, "recipient email (to) is required"),
        subject: z.string().min(1, "subject is required"),
        body: z.string().min(1, "body is required"),
        cc: z.string().optional(),
      })
      .passthrough(),
    handler: async (input, ctx) => {
      const i = input as Record<string, string>;
      if (!i.to || !i.subject || !i.body) return { error: "need to, subject, and body" };
      const raw = buildRaw({ to: i.to, subject: i.subject, body: i.body, cc: i.cc });
      const r = await authed(ctx, `${GMAIL}/messages/send`, { method: "POST", body: { raw } });
      if (!r.ok) return { error: `send failed: ${r.status} ${await r.text()}` };
      const data = await r.json();
      return { sent: true, id: (data as any).id };
    },
  };

  const gcalList: ToolDefinition = {
    id: "gcal_list",
    description:
      "List upcoming calendar events. Optional { days } window (default 7) and { limit }. Returns id, summary, start, end, location.",
    sensitivity: "read",
    scopes: ["calendar"],
    input: z.object({}).passthrough(),
    handler: async (input, ctx) => {
      const i = input as Record<string, unknown>;
      const days = typeof i.days === "number" ? i.days : 7;
      const limit = Math.min(typeof i.limit === "number" ? i.limit : 15, 50);
      const timeMin = new Date().toISOString();
      const timeMax = new Date(Date.now() + days * 86400000).toISOString();
      const url = `${CAL}/events?timeMin=${timeMin}&timeMax=${timeMax}&singleEvents=true&orderBy=startTime&maxResults=${limit}`;
      const r = await authed(ctx, url);
      if (!r.ok) return { error: `calendar list failed: ${r.status} ${await r.text()}` };
      const data = await r.json();
      const events = ((data as any).items ?? []).map((e: any) => ({
        id: e.id,
        summary: e.summary,
        start: e.start?.dateTime ?? e.start?.date,
        end: e.end?.dateTime ?? e.end?.date,
        location: e.location,
      }));
      return { events };
    },
  };

  const gcalCreate: ToolDefinition = {
    id: "gcal_create",
    description:
      "Create a calendar event. Input: { summary, start (ISO datetime), end (ISO datetime), location?, description? } — summary/start/end are required. Requires approval.",
    sensitivity: "write",
    scopes: ["calendar"],
    input: z
      .object({
        summary: z.string().min(1, "summary is required"),
        start: z.string().min(1, "start (ISO datetime) is required"),
        end: z.string().min(1, "end (ISO datetime) is required"),
        location: z.string().optional(),
        description: z.string().optional(),
      })
      .passthrough(),
    handler: async (input, ctx) => {
      const i = input as Record<string, string>;
      if (!i.summary || !i.start || !i.end) return { error: "need summary, start, and end (ISO datetimes)" };
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      const body = {
        summary: i.summary,
        location: i.location,
        description: i.description,
        start: { dateTime: i.start, timeZone: tz },
        end: { dateTime: i.end, timeZone: tz },
      };
      const r = await authed(ctx, `${CAL}/events`, { method: "POST", body });
      if (!r.ok) return { error: `create event failed: ${r.status} ${await r.text()}` };
      const data = await r.json();
      return { created: true, id: (data as any).id, link: (data as any).htmlLink };
    },
  };

  const gcalUpdate: ToolDefinition = {
    id: "gcal_update",
    description:
      "Reschedule/update an event by id. Input: { id, start?, end?, summary?, location? } — id is required (from gcal_list). Requires approval.",
    sensitivity: "write",
    scopes: ["calendar"],
    input: z.object({ id: z.string().min(1, "provide the event id from gcal_list") }).passthrough(),
    handler: async (input, ctx) => {
      const i = input as Record<string, string>;
      if (!i.id) return { error: "provide the event id" };
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      const body: Record<string, unknown> = {};
      if (i.summary) body.summary = i.summary;
      if (i.location) body.location = i.location;
      if (i.start) body.start = { dateTime: i.start, timeZone: tz };
      if (i.end) body.end = { dateTime: i.end, timeZone: tz };
      const r = await authed(ctx, `${CAL}/events/${i.id}`, { method: "PATCH", body });
      if (!r.ok) return { error: `update event failed: ${r.status} ${await r.text()}` };
      return { updated: true };
    },
  };

  return [gmailList, gmailRead, gmailDraft, gmailSend, gcalList, gcalCreate, gcalUpdate];
}
