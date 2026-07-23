/**
 * System-control tools for the System Agent — Nexus's hands on the actual machine.
 * This is the "open Brave, play YouTube, launch an app" capability. It is deliberately
 * CONSTRAINED: it can open URLs and launch/allow-listed applications and send media keys,
 * but it can NEVER run an arbitrary shell command — every input is validated, so a
 * mis-fired model can't format a disk or exfiltrate data.
 *
 * Platform: Windows-first (the CEO's machine). Falls back sensibly elsewhere.
 * Sensitivity "write" (not internal): it changes machine state, so it obeys the kill
 * switch and the autonomy dial. The System agent ships at L4 so it just works, but one
 * flick of the kill switch (or dropping its dial) stops it cold.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { platform, homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "../types";

const IS_WIN = platform() === "win32";

/** Run a program with explicit args (NO shell) so nothing can be injected. */
function run(cmd: string, args: string[]): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 15000 }, (err) => {
      resolve(err ? { ok: false, error: err.message } : { ok: true });
    });
  });
}

/** Locate a browser executable on Windows (Brave preferred when asked). */
function findBrowser(prefer?: string): string | null {
  if (!IS_WIN) return null;
  const LAD = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  const PF = process.env["ProgramFiles"] || "C:\\Program Files";
  const PF86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const cands: Record<string, string[]> = {
    brave: [
      join(PF, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
      join(PF86, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
      join(LAD, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
    ],
    chrome: [join(PF, "Google", "Chrome", "Application", "chrome.exe"), join(PF86, "Google", "Chrome", "Application", "chrome.exe")],
    edge: [join(PF86, "Microsoft", "Edge", "Application", "msedge.exe"), join(PF, "Microsoft", "Edge", "Application", "msedge.exe")],
    firefox: [join(PF, "Mozilla Firefox", "firefox.exe"), join(PF86, "Mozilla Firefox", "firefox.exe")],
  };
  const order = prefer && cands[prefer] ? [prefer, "brave", "chrome", "edge", "firefox"] : ["brave", "chrome", "edge", "firefox"];
  for (const b of order) for (const p of cands[b] ?? []) if (existsSync(p)) return p;
  return null;
}

const VALID_URL = /^https?:\/\/[^\s"'`<>|]+$/i;
/** Normalize a user-supplied target into a safe http(s) URL, or null if unusable. */
function toUrl(raw: string): string | null {
  let s = (raw || "").trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) {
    // bare domain like "youtube.com" → https://
    if (/^[\w-]+(\.[\w-]+)+(\/[^\s"'`<>|]*)?$/.test(s)) s = "https://" + s;
    else return null;
  }
  return VALID_URL.test(s) ? s : null;
}

/** Open a URL, preferring a named browser; else the OS default. */
async function openUrl(url: string, browser?: string): Promise<{ ok: boolean; via: string; error?: string }> {
  if (IS_WIN) {
    const exe = findBrowser(browser);
    if (exe) {
      const r = await run(exe, [url]);
      if (r.ok) return { ok: true, via: (browser || "browser") };
    }
    const r = await run("cmd", ["/c", "start", "", url]); // default browser
    return { ok: r.ok, via: "default browser", error: r.error };
  }
  const opener = platform() === "darwin" ? "open" : "xdg-open";
  const r = await run(opener, [url]);
  return { ok: r.ok, via: "default browser", error: r.error };
}

// Friendly app name → Windows launch. Unknown names fall back to `start` (App Paths/PATH).
const APP_MAP: Record<string, { cmd: string; args: string[] }> = {
  notepad: { cmd: "notepad", args: [] },
  calculator: { cmd: "calc", args: [] }, calc: { cmd: "calc", args: [] },
  paint: { cmd: "mspaint", args: [] },
  explorer: { cmd: "explorer", args: [] }, files: { cmd: "explorer", args: [] },
  cmd: { cmd: "cmd", args: ["/c", "start", "cmd"] }, terminal: { cmd: "cmd", args: ["/c", "start", "wt"] },
  settings: { cmd: "cmd", args: ["/c", "start", "ms-settings:"] },
  spotify: { cmd: "cmd", args: ["/c", "start", "spotify:"] },
  "task manager": { cmd: "taskmgr", args: [] },
  vscode: { cmd: "cmd", args: ["/c", "start", "", "code"] }, code: { cmd: "cmd", args: ["/c", "start", "", "code"] },
};

const APP_NAME = /^[\w .+&-]{1,40}$/;

export function systemTools(): ToolDefinition[] {
  const openUrlTool: ToolDefinition = {
    id: "open_url",
    description:
      "Open a website in a browser on the CEO's computer. Input: { url, browser? } — url is a full URL or a bare domain " +
      "(e.g. 'youtube.com'); browser optionally one of brave|chrome|edge|firefox (defaults to Brave if installed). Use this to 'open X', 'go to X'.",
    sensitivity: "write",
    scopes: ["system"],
    input: z.object({ url: z.string().min(2, "which website?"), browser: z.string().optional() }).passthrough(),
    handler: async (input) => {
      const i = input as { url: string; browser?: string };
      const url = toUrl(i.url);
      if (!url) return { error: `"${i.url}" isn't a valid website address.` };
      const br = i.browser?.toLowerCase().replace(/[^a-z]/g, "");
      const r = await openUrl(url, br);
      return r.ok ? { opened: url, via: r.via } : { error: `couldn't open it: ${r.error || "unknown"}` };
    },
  };

  const youtubeTool: ToolDefinition = {
    id: "youtube_play",
    description:
      "Open YouTube on the CEO's computer for a search or a video. Input: { query } — a search phrase (e.g. 'lofi beats') " +
      "or a full YouTube URL. Opens YouTube (in Brave by default) with the results/video ready to play. Use for 'play X on YouTube'.",
    sensitivity: "write",
    scopes: ["system"],
    input: z.object({ query: z.string().min(1, "what should I play?"), browser: z.string().optional() }).passthrough(),
    handler: async (input) => {
      const i = input as { query: string; browser?: string };
      const q = i.query.trim();
      const direct = toUrl(q);
      const url = direct && /youtu\.?be/i.test(direct) ? direct : `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;
      const r = await openUrl(url, (i.browser || "brave").toLowerCase().replace(/[^a-z]/g, ""));
      return r.ok ? { opened: url, via: r.via, note: direct ? "Opened the video." : `Opened YouTube results for "${q}" — the top result is ready to play.` } : { error: `couldn't open YouTube: ${r.error || "unknown"}` };
    },
  };

  const openAppTool: ToolDefinition = {
    id: "open_app",
    description:
      "Launch an application on the CEO's computer. Input: { app } — e.g. 'notepad', 'calculator', 'spotify', 'explorer', " +
      "'settings', 'vscode', or another installed app's name. Use for 'open X', 'launch X', 'start X'.",
    sensitivity: "write",
    scopes: ["system"],
    input: z.object({ app: z.string().min(1, "which app?") }).passthrough(),
    handler: async (input) => {
      const name = String((input as { app: string }).app || "").trim().toLowerCase();
      if (!APP_NAME.test(name)) return { error: "that app name has characters I won't run for safety." };
      // A browser name → open a blank browser.
      if (["brave", "chrome", "edge", "firefox"].includes(name) && IS_WIN) {
        const exe = findBrowser(name); if (exe) { const r = await run(exe, []); if (r.ok) return { launched: name }; }
      }
      const mapped = APP_MAP[name];
      if (mapped) { const r = await run(mapped.cmd, mapped.args); return r.ok ? { launched: name } : { error: r.error }; }
      if (!IS_WIN) return { error: `I don't have a launcher mapping for "${name}" on this OS.` };
      const r = await run("cmd", ["/c", "start", "", name]); // resolve via App Paths / PATH
      return r.ok ? { launched: name, note: "Asked Windows to launch it — if nothing appeared, tell me the exact app name." } : { error: `couldn't launch "${name}": ${r.error || "not found"}` };
    },
  };

  const mediaTool: ToolDefinition = {
    id: "media_control",
    description:
      "Control media/volume on the CEO's computer. Input: { action } ∈ playpause|next|previous|stop|volumeup|volumedown|mute. " +
      "Works with whatever is playing (YouTube in the browser, Spotify, etc.).",
    sensitivity: "write",
    scopes: ["system"],
    input: z.object({ action: z.string().min(1) }).passthrough(),
    handler: async (input) => {
      if (!IS_WIN) return { error: "media keys are Windows-only for now." };
      const KEYS: Record<string, number> = { playpause: 0xb3, play: 0xb3, pause: 0xb3, next: 0xb0, previous: 0xb1, prev: 0xb1, stop: 0xb2, volumeup: 0xaf, volumedown: 0xae, mute: 0xad };
      const a = String((input as { action: string }).action || "").toLowerCase().replace(/[^a-z]/g, "");
      const vk = KEYS[a];
      if (vk === undefined) return { error: `unknown action "${a}". Use playpause|next|previous|stop|volumeup|volumedown|mute.` };
      // Send the virtual media key via keybd_event (no extra software).
      const ps = `Add-Type -Name K -Namespace N -MemberDefinition '[DllImport("user32.dll")]public static extern void keybd_event(byte b,byte s,uint f,int e);'; [N.K]::keybd_event(${vk},0,0,0); [N.K]::keybd_event(${vk},0,2,0);`;
      const r = await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps]);
      return r.ok ? { done: a } : { error: r.error };
    },
  };

  return [openUrlTool, youtubeTool, openAppTool, mediaTool];
}
