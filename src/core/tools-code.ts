/**
 * Codebase-awareness tools for the Developer agent — Nexus's eyes on the CEO's own
 * projects (e.g. their SaaS app). Fully local and read-only: it walks folders on THIS
 * machine, maps the architecture (routes, models, jobs, scripts), and reads/searches
 * source on demand. Nothing is uploaded anywhere; no paid services.
 *
 *   project_scan   — register + scan a local folder: file map, deps, routes, workflows
 *   project_list   — the folders the CEO has registered
 *   code_search    — grep-style text search across a registered project
 *   code_read      — read one source file from a registered project
 *
 * Guardrails: code_read/code_search only work INSIDE roots the CEO registered via
 * project_scan (path-containment enforced), secret-bearing files (.env, keys, certs)
 * are never read or returned, and sizes/result counts are bounded.
 */

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { resolve, join, relative, extname, basename, sep } from "node:path";
import { z } from "zod";
import type { ToolContext, ToolDefinition } from "../types";

const PROJECTS_KEY = "code:projects"; // kv (per-user scoped): JSON string[] of registered roots

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".hg", ".svn", "dist", "build", "out", ".next", ".nuxt", ".output",
  "coverage", "__pycache__", ".venv", "venv", "env", ".idea", ".vscode", "target", "vendor",
  ".cache", ".turbo", ".parcel-cache", "tmp", ".DS_Store",
]);
// Never read or list these — they hold secrets.
const SECRET_FILE = /^\.env(\..*)?$|\.(pem|key|p12|pfx|crt|keystore)$|^id_(rsa|ed25519|ecdsa)/i;
const MAX_FILES = 4000;
const MAX_READ = 48_000; // chars per file handed to the model
const MAX_MATCHES = 60;

const CODE_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rb", ".go", ".rs", ".java", ".kt",
  ".cs", ".php", ".vue", ".svelte", ".sql", ".prisma", ".graphql", ".proto", ".html", ".css",
  ".scss", ".json", ".yaml", ".yml", ".toml", ".md", ".txt", ".sh", ".ps1", ".dockerfile",
]);

interface FileEntry {
  rel: string;
  size: number;
  ext: string;
}

function listProjects(ctx: ToolContext): string[] {
  try {
    const raw = ctx.services.kv.get(PROJECTS_KEY);
    const a = raw ? JSON.parse(raw) : [];
    return Array.isArray(a) ? (a as string[]) : [];
  } catch {
    return [];
  }
}

/** Resolve which registered root a request targets; default to the only/most recent one. */
function rootFor(ctx: ToolContext, project?: string): string | null {
  const roots = listProjects(ctx);
  if (!roots.length) return null;
  if (!project) return roots[roots.length - 1]!;
  const q = project.trim().toLowerCase();
  return (
    roots.find((r) => r.toLowerCase() === q) ||
    roots.find((r) => basename(r).toLowerCase() === q) ||
    roots.find((r) => r.toLowerCase().includes(q)) ||
    null
  );
}

/** True when `p` (resolved) is inside `root` — blocks ../ escapes. */
function inside(root: string, p: string): boolean {
  const rel = relative(root, p);
  return rel !== "" && !rel.startsWith("..") && !rel.includes(`..${sep}`);
}

function walk(root: string): FileEntry[] {
  const files: FileEntry[] = [];
  const stack = [root];
  while (stack.length && files.length < MAX_FILES) {
    const dir = stack.pop()!;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (files.length >= MAX_FILES) break;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(name) && !name.startsWith(".")) stack.push(full);
      } else if (st.isFile() && !SECRET_FILE.test(name)) {
        files.push({ rel: relative(root, full), size: st.size, ext: extname(name).toLowerCase() });
      }
    }
  }
  return files;
}

/** Route/workflow detection: cheap, transparent regexes over the code files. */
const ROUTE_PATTERNS: [RegExp, string][] = [
  [/\b(?:app|router|server|api)\.(get|post|put|patch|delete|all)\s*\(\s*["'`]([^"'`]+)/g, "express/fastify"],
  [/@(?:Get|Post|Put|Patch|Delete)\s*\(\s*["'`]?([^"'`)]*)/g, "nest/decorator"],
  [/\b(?:route|path)\s*:\s*["'`]([/][^"'`]*)/g, "route-config"],
  [/@app\.(?:get|post|put|patch|delete|route)\s*\(\s*["']([^"']+)/g, "flask/fastapi"],
  [/path\s*===?\s*["'`](\/[a-z][^"'`]*)/g, "raw-http"],
];

function detectSignals(root: string, files: FileEntry[]) {
  const routes: { file: string; method: string; path: string }[] = [];
  const jobs: string[] = [];
  const models: string[] = [];
  const codeFiles = files.filter((f) => CODE_EXT.has(f.ext) && f.size < 300_000);
  for (const f of codeFiles.slice(0, 600)) {
    // API route files by name are always interesting (Next.js/Remix conventions)
    if (/(^|[\\/])(api|routes?|controllers?)([\\/]|\.)/i.test(f.rel) && routes.length < 80) {
      // fall through to content scan below
    }
    let text: string;
    try {
      text = readFileSync(join(root, f.rel), "utf8");
    } catch {
      continue;
    }
    for (const [re] of ROUTE_PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) && routes.length < 120) {
        // Two-group patterns capture (method, path); one-group patterns capture just (path).
        const p = m[2] ?? m[1] ?? "";
        const method = m[2] !== undefined ? (m[1] || "route").toUpperCase() : "ROUTE";
        if (p && p.length < 120 && p.startsWith("/")) routes.push({ file: f.rel, method, path: p });
      }
    }
    if (/\b(cron|schedule|setInterval|BullMQ|celery|sidekiq|worker|queue)\b/i.test(text) && jobs.length < 40) {
      if (!jobs.includes(f.rel)) jobs.push(f.rel);
    }
    if (/(^|[\\/])(models?|schema|entities|prisma)([\\/]|\.)/i.test(f.rel) && models.length < 40) {
      if (!models.includes(f.rel)) models.push(f.rel);
    }
  }
  return { routes, jobs, models };
}

export function codeTools(): ToolDefinition[] {
  const projectScan: ToolDefinition = {
    id: "project_scan",
    description:
      "Register and scan a LOCAL project folder (the CEO's own app/codebase) to map it: file inventory, " +
      "package/deps, detected API routes, background jobs, and data models. Input: { path } — an absolute " +
      "folder path on this machine (e.g. D:\\my-saas). Read-only; nothing leaves the machine. " +
      "After scanning, use code_search and code_read to answer questions about the code.",
    sensitivity: "read",
    internal: true,
    scopes: ["code"],
    input: z.object({ path: z.string().min(2, "provide the absolute folder path of the project") }).passthrough(),
    handler: async (input, ctx) => {
      const root = resolve(String((input as { path: string }).path).trim());
      if (!existsSync(root) || !statSync(root).isDirectory()) {
        return { error: `"${root}" is not a folder on this machine. Ask the CEO for the correct absolute path.` };
      }
      const files = walk(root);
      if (!files.length) return { error: "that folder has no readable files" };

      // Register (per-user, deduped) so code_read/code_search are allowed inside it.
      const roots = listProjects(ctx).filter((r) => r !== root);
      roots.push(root);
      ctx.services.kv.set(PROJECTS_KEY, JSON.stringify(roots.slice(-10)));

      // Language mix
      const byExt: Record<string, number> = {};
      for (const f of files) byExt[f.ext || "(none)"] = (byExt[f.ext || "(none)"] ?? 0) + 1;
      const langs = Object.entries(byExt).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([ext, n]) => `${ext}×${n}`);

      // package.json (node projects)
      let pkg: { name?: string; scripts?: Record<string, string>; deps?: string[] } | null = null;
      try {
        const p = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
        pkg = { name: p.name, scripts: p.scripts, deps: Object.keys({ ...p.dependencies, ...p.devDependencies }).slice(0, 40) };
      } catch { /* not a node project */ }

      const { routes, jobs, models } = detectSignals(root, files);
      const tree = files
        .slice(0, 400)
        .map((f) => f.rel)
        .sort();
      return {
        registered: root,
        totalFiles: files.length,
        truncated: files.length >= MAX_FILES,
        languages: langs,
        package: pkg,
        detectedRoutes: routes.slice(0, 80),
        backgroundJobFiles: jobs,
        modelOrSchemaFiles: models,
        fileTree: tree,
        note: "Project registered. Use code_search {query} and code_read {file} to dig into specifics.",
      };
    },
  };

  const projectList: ToolDefinition = {
    id: "project_list",
    description: "List the local project folders the CEO has registered for code analysis.",
    sensitivity: "read",
    internal: true,
    scopes: ["code"],
    input: z.object({}).passthrough(),
    handler: async (_input, ctx) => {
      const roots = listProjects(ctx);
      return roots.length
        ? { projects: roots }
        : { projects: [], note: "No projects registered — ask the CEO for their project's folder path, then call project_scan." };
    },
  };

  const codeSearch: ToolDefinition = {
    id: "code_search",
    description:
      "Search text/code across a registered project (like grep). Input: { query, project? } — query is a " +
      "plain string or regex; project picks a registered root by name (defaults to the most recent). " +
      "Returns matching lines with file:line references.",
    sensitivity: "read",
    internal: true,
    scopes: ["code"],
    input: z.object({ query: z.string().min(1, "what should I search for?"), project: z.string().optional() }).passthrough(),
    handler: async (input, ctx) => {
      const i = input as { query: string; project?: string };
      const root = rootFor(ctx, i.project);
      if (!root) return { error: "No project registered yet — call project_scan with the folder path first." };
      let re: RegExp;
      try {
        re = new RegExp(i.query, "i");
      } catch {
        re = new RegExp(i.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      }
      const files = walk(root).filter((f) => CODE_EXT.has(f.ext) && f.size < 400_000);
      const matches: { file: string; line: number; text: string }[] = [];
      for (const f of files) {
        if (matches.length >= MAX_MATCHES) break;
        let text: string;
        try {
          text = readFileSync(join(root, f.rel), "utf8");
        } catch {
          continue;
        }
        const lines = text.split(/\r?\n/);
        for (let n = 0; n < lines.length && matches.length < MAX_MATCHES; n++) {
          if (re.test(lines[n]!)) matches.push({ file: f.rel, line: n + 1, text: lines[n]!.trim().slice(0, 200) });
        }
      }
      return { project: root, query: i.query, matches, count: matches.length, capped: matches.length >= MAX_MATCHES };
    },
  };

  const codeRead: ToolDefinition = {
    id: "code_read",
    description:
      "Read ONE source file from a registered project. Input: { file, project? } — file is the relative path " +
      "(from project_scan's fileTree or code_search results). Returns the file text (large files truncated).",
    sensitivity: "read",
    internal: true,
    scopes: ["code"],
    input: z.object({ file: z.string().min(1, "which file? use a relative path from the scan"), project: z.string().optional() }).passthrough(),
    handler: async (input, ctx) => {
      const i = input as { file: string; project?: string };
      const root = rootFor(ctx, i.project);
      if (!root) return { error: "No project registered yet — call project_scan with the folder path first." };
      const full = resolve(join(root, i.file));
      if (!inside(root, full)) return { error: "that path is outside the registered project — refused" };
      if (SECRET_FILE.test(basename(full))) return { error: "that file may hold secrets (.env/keys) — refused by policy" };
      if (!existsSync(full) || !statSync(full).isFile()) {
        return { error: `no file "${i.file}" in ${basename(root)} — check the path against the fileTree` };
      }
      let text: string;
      try {
        text = readFileSync(full, "utf8");
      } catch (e) {
        return { error: `couldn't read: ${(e as Error).message}` };
      }
      const truncated = text.length > MAX_READ;
      return { file: i.file, project: root, truncated, text: truncated ? text.slice(0, MAX_READ) : text };
    },
  };

  return [projectScan, projectList, codeSearch, codeRead];
}
