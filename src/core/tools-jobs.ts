/**
 * Job-application tools for the Job Application Agent.
 *
 *  - profile_save / profile_get: the CEO's reusable application profile (CV data),
 *    stored AES-256-GCM ENCRYPTED in the vault. "Fill my details by itself" = the agent
 *    keeps this once and auto-fills every application from it, never re-asking.
 *  - job_track / job_list: a local application pipeline (Saved → Applied → Interviewing
 *    → Offer/Reject), also encrypted at rest.
 *
 * Tailoring a résumé / cover letter is the agent's own reasoning over profile_get — no
 * tool needed. SUBMITTING an application is an outward action and is left to the CEO
 * (the agent prepares and pre-fills; the human submits/approves).
 */

import { z } from "zod";
import type { ToolContext, ToolDefinition } from "../types";

interface JobApp {
  company: string;
  role: string;
  status: string;
  url?: string;
  notes?: string;
  updated: string;
}

const PROFILE_KEY = "job_profile";
const APPS_KEY = "job_applications";
const STATUSES = ["saved", "applied", "interviewing", "offer", "rejected"];

function readProfile(ctx: ToolContext): Record<string, unknown> {
  try {
    const raw = ctx.services.vault.get(PROFILE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
function readApps(ctx: ToolContext): JobApp[] {
  try {
    const raw = ctx.services.vault.get(APPS_KEY);
    const a = raw ? JSON.parse(raw) : [];
    return Array.isArray(a) ? (a as JobApp[]) : [];
  } catch {
    return [];
  }
}

export function jobTools(): ToolDefinition[] {
  const profileSave: ToolDefinition = {
    id: "profile_save",
    description:
      "Save/update the CEO's job-application profile (stored ENCRYPTED). Provide any of: name, email, phone, location, headline, summary, skills, experience, education, links, workAuth, noticePeriod, expectedSalary, preferences. Only the fields you pass are updated; the rest are kept.",
    sensitivity: "write",
    internal: true,
    scopes: ["jobs"],
    input: z.object({}).passthrough(),
    handler: async (input, ctx) => {
      const cur = readProfile(ctx);
      const next: Record<string, unknown> = { ...cur };
      for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
        if (v !== undefined && v !== null && v !== "") next[k] = v;
      }
      ctx.services.vault.set(PROFILE_KEY, JSON.stringify(next));
      return { saved: true, fields: Object.keys(next) };
    },
  };

  const profileGet: ToolDefinition = {
    id: "profile_get",
    description:
      "Read back the CEO's saved job-application profile (CV details) to tailor a résumé/cover letter or fill an application. Call this BEFORE asking the CEO for details.",
    sensitivity: "read",
    internal: true,
    scopes: ["jobs"],
    input: z.object({}).passthrough(),
    handler: async (_input, ctx) => {
      const p = readProfile(ctx);
      if (!Object.keys(p).length) {
        return { profile: null, note: "No profile saved yet — ask the CEO for their details, then call profile_save." };
      }
      return { profile: p };
    },
  };

  const jobTrack: ToolDefinition = {
    id: "job_track",
    description:
      "Add or update a job application in the tracker. Input: { company, role, status?, url?, notes? }. status ∈ saved|applied|interviewing|offer|rejected (default keeps existing or 'saved'). Matches an existing entry by company+role.",
    sensitivity: "write",
    internal: true,
    scopes: ["jobs"],
    input: z
      .object({
        company: z.string().min(1, "company is required"),
        role: z.string().min(1, "role is required"),
      })
      .passthrough(),
    handler: async (input, ctx) => {
      const i = input as { company: string; role: string; status?: string; url?: string; notes?: string };
      const apps = readApps(ctx);
      const key = (c: string, r: string) => `${c}|${r}`.toLowerCase();
      const idx = apps.findIndex((a) => key(a.company, a.role) === key(i.company, i.role));
      const prev = idx >= 0 ? apps[idx]! : undefined;
      const req = i.status?.toLowerCase();
      const status = req && STATUSES.includes(req) ? req : (prev?.status ?? "saved");
      const entry: JobApp = {
        company: i.company,
        role: i.role,
        status,
        url: i.url ?? prev?.url,
        notes: i.notes ?? prev?.notes,
        updated: new Date().toISOString(),
      };
      if (idx >= 0) apps[idx] = entry;
      else apps.push(entry);
      ctx.services.vault.set(APPS_KEY, JSON.stringify(apps));
      return { tracked: true, total: apps.length, entry };
    },
  };

  const jobList: ToolDefinition = {
    id: "job_list",
    description: "List tracked job applications. Optional { status } filter (saved|applied|interviewing|offer|rejected).",
    sensitivity: "read",
    internal: true,
    scopes: ["jobs"],
    input: z.object({}).passthrough(),
    handler: async (input, ctx) => {
      const status = (input as { status?: string }).status?.toLowerCase();
      let apps = readApps(ctx);
      if (status) apps = apps.filter((a) => String(a.status).toLowerCase() === status);
      const counts: Record<string, number> = {};
      for (const a of apps) counts[a.status] = (counts[a.status] ?? 0) + 1;
      return { applications: apps, total: apps.length, counts };
    },
  };

  return [profileSave, profileGet, jobTrack, jobList];
}
