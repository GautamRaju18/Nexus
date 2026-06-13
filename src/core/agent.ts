/**
 * The generic agent runtime. Every one of the 21 specialists IS this loop —
 * the only thing that differs is the spec (system prompt + licensed tools +
 * autonomy ceiling). That uniformity is why "all 21 agents in v1" costs no extra
 * infrastructure: an agent is a config, not a codebase.
 *
 * Control flow per step:
 *   1. Ask the model for ONE JSON action (tool call or final answer).
 *   2. If a tool: validate input → policy gate (allow / approve / block) →
 *      maybe ask you → execute → audit → feed the observation back.
 *   3. If final: audit and return.
 *
 * The JSON protocol is model-agnostic, so the same loop works on a local Ollama
 * model or on Gemini with no per-provider tool-calling quirks.
 */

import { z } from "zod";
import type {
  AgentSpec,
  Approver,
  LLMMessage,
  LLMProvider,
  ToolDefinition,
  ToolServices,
} from "../types";
import type { ToolRegistry } from "./tools";
import type { PolicyEngine } from "./policy";
import type { AuditLog } from "./audit";

export interface AgentDeps {
  llm: LLMProvider;
  tools: ToolRegistry;
  policy: PolicyEngine;
  audit: AuditLog;
  approver: Approver;
  services: ToolServices;
  /** The tenant this run acts for. Defaults to "owner" for single-user surfaces. */
  userId: string;
}

export interface AgentResult {
  agentId: string;
  message: string;
  steps: number;
}

const MAX_STEPS = 8;

export async function runAgent(
  spec: AgentSpec,
  task: string,
  deps: AgentDeps,
  sharedContext = "",
  history: LLMMessage[] = [],
): Promise<AgentResult> {
  const licensed = deps.tools.resolve(spec.tools);

  // Inject relevant long-term memory so the agent acts like it knows the user.
  // Higher threshold for auto-injection so only clearly-relevant memories appear.
  const memories = await deps.services.memory.recall(task, 5, 0.55).catch(() => []);
  const memoryBlock =
    memories.length > 0
      ? "Possibly-relevant notes from long-term memory — IGNORE any that aren't directly about THIS task:\n" +
        memories.map((m) => `- [${m.layer}] ${m.key}: ${m.content}`).join("\n")
      : "(no long-term memory matched this task)";

  const system: LLMMessage = {
    role: "system",
    content: buildSystemPrompt(spec, licensed, memoryBlock, sharedContext),
  };
  // Prior turns give the agent context (e.g. the city the CEO just named).
  const priorTurns = history.slice(-6).filter((m) => m.role !== "system");
  const messages: LLMMessage[] = [system, ...priorTurns, { role: "user", content: task }];
  const validIds = new Set(licensed.map((t) => t.id));

  // Loop guards: stop a weak model from spamming the same failing/approval call.
  const toolErrors = new Map<string, number>(); // tool id → times it errored
  const approvalSigs = new Set<string>(); // (tool+input) we've already shown an approval card for

  for (let step = 1; step <= MAX_STEPS; step++) {
    const raw = await deps.llm.chat(messages);
    const action = parseAction(raw, validIds);
    messages.push({ role: "assistant", content: raw });

    if (!action) {
      // If it LOOKS like a malformed/invalid tool attempt, coach the model and retry
      // rather than leaking the raw JSON as the answer.
      const looksLikeToolAttempt = /"action"\s*:\s*"\w+"|"tool"\s*:\s*"\w+"/.test(raw);
      if (looksLikeToolAttempt && step < MAX_STEPS) {
        messages.push(
          observation(
            `That was not a valid action. Either call a licensed tool exactly as {"action":"tool","tool":"<one of: ${spec.tools.join(", ") || "none"}>","input":{...}}, or finish with {"action":"final","message":"<your answer in plain prose>"}.`,
          ),
        );
        continue;
      }
      // Otherwise treat its text as the final answer (scrubbed of any JSON noise).
      return { agentId: spec.id, message: cleanFinal(raw) || "I wasn't able to complete that cleanly — could you rephrase?", steps: step };
    }

    if (action.action === "final") {
      let message = cleanFinal(action.message);
      // Weak models sometimes "finish" by echoing a tool error or asking the CEO to supply
      // tool parameters ("please provide a key and value…"). Never surface that — coach once
      // and make them answer the actual request from their own knowledge.
      if (looksLikeLeakedError(message)) {
        if (step < MAX_STEPS) {
          messages.push(
            observation(
              "That reply is an internal tool error or a request for tool inputs — the CEO must never see that. Do NOT ask the CEO for tool parameters and never repeat tool errors. Answer the ORIGINAL request now, directly, in plain prose, as {\"action\":\"final\",\"message\":\"…\"}.",
            ),
          );
          continue;
        }
        // Out of retries — never surface the raw error.
        message = "I hit a snag completing that. Could you rephrase or give me a bit more detail, and I'll take it from there?";
      }
      deps.audit.record({
        actor: spec.id,
        action: "final",
        detail: truncate(message, 200),
        sensitivity: "system",
        reversible: true,
        status: "ok",
        userId: deps.userId,
      });
      return { agentId: spec.id, message, steps: step };
    }

    // ── Tool call ──────────────────────────────────────────────────────────────
    const tool = licensed.find((t) => t.id === action.tool);
    if (!tool) {
      messages.push(observation(`Error: you are not licensed for tool "${action.tool}". Licensed: ${spec.tools.join(", ")}.`));
      continue;
    }

    const parsed = tool.input.safeParse(action.input ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
      messages.push(observation(`Error: invalid input for ${tool.id}: ${issues}. Fix the input or use a different tool — do not repeat this exact call.`));
      continue;
    }

    // Hard stop: a tool that has already failed twice won't suddenly work — stop looping on it.
    if ((toolErrors.get(tool.id) ?? 0) >= 2) {
      messages.push(observation(`You've already failed with "${tool.id}" twice. Stop calling it and give your best 'final' answer from what you have.`));
      continue;
    }

    const sig = `${tool.id}:${JSON.stringify(parsed.data)}`;
    const { decision, reason } = deps.policy.decide(spec, tool);

    if (decision === "block") {
      deps.audit.record({
        actor: spec.id,
        action: `tool:${tool.id}`,
        detail: `blocked: ${reason}`,
        sensitivity: tool.sensitivity,
        reversible: false,
        status: "blocked",
        userId: deps.userId,
      });
      messages.push(observation(`Blocked: ${reason}. Report this to the user instead of acting.`));
      continue;
    }

    if (decision === "approve") {
      // Never show the SAME approval card twice — that's what produced the flood.
      if (approvalSigs.has(sig)) {
        messages.push(observation(`You already requested approval for this exact ${tool.id} call. Don't repeat it — wait for the result or finish with a 'final' answer.`));
        continue;
      }
      approvalSigs.add(sig);
      const ok = await deps.approver.approve({
        agentId: spec.id,
        userId: deps.userId,
        toolId: tool.id,
        sensitivity: tool.sensitivity,
        preview: previewOf(tool, parsed.data),
        reversible: tool.sensitivity === "comms" || tool.sensitivity === "write",
      });
      if (!ok) {
        deps.audit.record({
          actor: spec.id,
          action: `tool:${tool.id}`,
          detail: `denied by user: ${previewOf(tool, parsed.data)}`,
          sensitivity: tool.sensitivity,
          reversible: false,
          status: "denied",
          userId: deps.userId,
        });
        messages.push(observation("The user DENIED this action. Do not retry it; find another path or stop and explain."));
        continue;
      }
    }

    // Execute.
    try {
      const result = await tool.handler(parsed.data, { agentId: spec.id, userId: deps.userId, services: deps.services });
      // A handler that RETURNS {error} (e.g. gmail_draft with missing fields) is a failure too —
      // count it so the loop guard can stop a repeating bad call, not just thrown errors.
      const errored = result && typeof result === "object" && "error" in (result as Record<string, unknown>);
      if (errored) toolErrors.set(tool.id, (toolErrors.get(tool.id) ?? 0) + 1);
      deps.audit.record({
        actor: spec.id,
        action: `tool:${tool.id}`,
        detail: previewOf(tool, parsed.data),
        sensitivity: tool.sensitivity,
        reversible: tool.sensitivity !== "money" && tool.sensitivity !== "legal",
        status: errored ? "error" : "ok",
        userId: deps.userId,
      });
      messages.push(observation(JSON.stringify(result).slice(0, 3000)));
    } catch (e) {
      toolErrors.set(tool.id, (toolErrors.get(tool.id) ?? 0) + 1);
      deps.audit.record({
        actor: spec.id,
        action: `tool:${tool.id}`,
        detail: `error: ${e}`,
        sensitivity: tool.sensitivity,
        reversible: true,
        status: "error",
        userId: deps.userId,
      });
      messages.push(observation(`Tool error: ${e}. Decide whether to retry differently or stop.`));
    }
  }

  // Out of tool budget — force a plain-text final answer from what we have,
  // rather than returning a useless "I hit the step limit" message.
  const finalText = await deps.llm.chat([
    ...messages,
    {
      role: "user",
      content:
        "You have used your tool budget. Reply to the CEO now in plain prose (NO JSON, no tool calls) with the best answer you can give from what you've gathered so far.",
    },
  ]);
  return { agentId: spec.id, message: cleanFinal(finalText) || "Here's what I have so far — tell me how you'd like to proceed.", steps: MAX_STEPS };
}

/**
 * Detect a "final" answer that is really a leaked tool error or a request for tool
 * parameters — a weak-model failure mode we must never show the CEO. Kept narrow so it
 * doesn't swallow legitimate answers that merely contain a question.
 */
function looksLikeLeakedError(msg: string): boolean {
  const m = (msg ?? "").trim();
  if (!m) return true;
  return (
    /^(error|observation)\b/i.test(m) ||
    /invalid input for|tool error|not licensed for/i.test(m) ||
    /please provide (a|an|the|your|valid)/i.test(m) ||
    /provide a (valid|value|key|query|url|location|note)/i.test(m) ||
    /\bkey\b[^.?!]{0,24}\bvalue\b/i.test(m) ||
    /\b(is|are) required\b/i.test(m) ||
    /provide (the|a|an) .{0,24}\b(id|key|value|query)\b/i.test(m)
  );
}

/**
 * Scrub a final message so leaked/half-formed JSON never reaches the user:
 * pull out a "message"/"answer" field if present, or drop a leading JSON-ish blob.
 */
function cleanFinal(text: string): string {
  const t = (text ?? "").trim();
  if (!t) return t;

  // Clean parse → pull the user-facing text. We also salvage the CONTENT of a leaked
  // tool call (value/content/body) — e.g. a draft the model wrongly stuffed into a `note`
  // call — so the deliverable surfaces instead of raw JSON.
  const json = extractJson(t);
  const obj = json ? tolerantParse(json) : null;
  if (obj) {
    const msg = obj.message ?? obj.answer ?? obj.text ?? obj.value ?? obj.content ?? obj.body;
    if (typeof msg === "string" && msg.trim()) return msg.trim();
  }
  // Malformed JSON but a content field is still extractable by regex.
  const m = t.match(/"(?:message|answer|text|value|content|body)"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (m && m[1] !== undefined) {
    try {
      return JSON.parse(`"${m[1]}"`);
    } catch {
      return m[1].replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\t/g, " ").trim();
    }
  }
  // Leaked tool-call JSON with prose after it: drop the leading JSON-ish blob.
  if (/^[{[]/.test(t) || /^"?(thought|action)"?\s*:/.test(t)) {
    const stripped = t.replace(/^[\s\S]*?\}\s*/, "").replace(/^[\s,"}\]]+/, "").trim();
    if (stripped.length > 20) return stripped;
    // A bare tool-call JSON (no salvageable content) is never a user answer — let the caller fall back.
    if (obj && ("tool" in obj || ("action" in obj && obj.action !== "final"))) return "";
  }
  return t;
}

// ── Prompt construction ───────────────────────────────────────────────────────
function buildSystemPrompt(
  spec: AgentSpec,
  tools: ToolDefinition[],
  memoryBlock: string,
  sharedContext: string,
): string {
  const toolList =
    tools.length > 0
      ? tools.map((t) => `- ${t.id} (${t.sensitivity}): ${t.description} Input keys: ${describeInput(t)}`).join("\n")
      : "(no tools licensed — answer from reasoning and memory)";

  return [
    `You are the ${spec.name} at Jarvis, the user's personal AI organization. The user is your CEO.`,
    `Your job: ${spec.purpose}`,
    "",
    spec.systemPrompt,
    "",
    memoryBlock,
    sharedContext ? `\nContext from the Chief of Staff / other agents:\n${sharedContext}` : "",
    "",
    "TOOLS you may use:",
    toolList,
    "",
    "PROTOCOL — respond with EXACTLY ONE JSON object and nothing else (no prose, no markdown):",
    `  To use a tool:   {"thought":"why","action":"tool","tool":"<id>","input":{...}}`,
    `  When finished:   {"thought":"why","action":"final","message":"your answer to the user"}`,
    `  The "tool" value MUST be one of: ${tools.map((t) => t.id).join(", ") || "(none)"}.`,
    "",
    "EXAMPLES:",
    `  {"thought":"store this preference","action":"tool","tool":"remember","input":{"layer":"preference","key":"seat","content":"prefers aisle seats; no red-eye flights"}}`,
    `  {"thought":"I have what I need","action":"final","message":"Saved — you prefer aisle seats and avoid red-eyes."}`,
    "",
    "RULES:",
    "- Only use web_search/web_fetch when the task needs CURRENT or EXTERNAL facts you don't already know. For writing/drafting (emails, replies, job descriptions, posts, plans, scripts, checklists, itineraries, advice) answer DIRECTLY from your own knowledge — do not search.",
    "- Use at most 1–2 tools, then give your 'final' answer. Once you can answer, STOP calling tools.",
    "- NEVER return a tool's error message, a raw search result, or an intermediate note as your final answer. If a tool fails or returns junk, answer from your own knowledge instead.",
    "- IGNORE long-term memory items that aren't relevant to THIS task.",
    "- NEVER ask the CEO to supply tool parameters (a note value, a URL, a location). Infer them from the request, or skip that tool and answer.",
    "- If a tool returns an error twice, stop using it and give your best 'final' answer with what you have.",
    "- Outward actions (sending email/messages, spending money, signing) may be paused for the CEO's approval. If an action is blocked or denied, do NOT retry it — explain and offer alternatives.",
    "- Prefer recalling memory before asking the user something you might already know.",
    "- DELIVER THE ACTUAL WORK PRODUCT. If asked to write, plan, or draft something (an email, job description, pitch, posts, itinerary, checklist, study plan, budget, script), produce the COMPLETE, ready-to-use thing yourself, written out in full. NEVER just point to templates, websites, courses, or tools ('use SlideTeam', 'check LearnSQL', 'try Practo', 'here are some resources') — naming resources instead of doing the work is a failure.",
    "- WRITE A CONCRETE SPECIMEN, NOT A FILL-IN-THE-BLANK TEMPLATE. Don't hand back text full of [bracketed blanks]. If a detail is unknown, pick a realistic, clearly-hypothetical example value (a plausible name, number, or company) and use it — note it's a sample the CEO can swap. Don't punt the real work back by asking the CEO for inputs you could reasonably invent.",
    "- BE SUBSTANTIVE, BUT HONOR EXPLICIT LENGTH CUES. If the CEO says 'briefly', 'short', 'concise', or 'punchy', keep it tight — lead with the answer and cut preamble and extra sections. Otherwise give a deliverable real depth (concrete details, named steps, real examples). Never pad or restate the request.",
    "- FORMAT FOR READABILITY using Markdown: short **bold** sub-headers, `-` bullet points, and numbered steps where useful. Use plain symbols (→, x, ✓), NEVER LaTeX like $\\rightarrow$. Break up walls of text. Don't repeat the question back to the CEO.",
    "- Don't claim you DID something you only prepared (scheduled a post, booked, sent, created an event) — say it's drafted/proposed unless a tool actually performed it.",
    "- Never invent tool results. Only trust observations returned to you.",
  ]
    .filter(Boolean)
    .join("\n");
}

function describeInput(tool: ToolDefinition): string {
  const def = tool.input as unknown as { _def?: { typeName?: string }; shape?: Record<string, unknown> };
  if (def?._def?.typeName === "ZodObject") {
    const shape = (tool.input as unknown as z.ZodObject<z.ZodRawShape>).shape;
    const keys = Object.keys(shape);
    return keys.length ? keys.join(", ") : "(none)";
  }
  return "(see description)";
}

// ── Parsing & helpers ─────────────────────────────────────────────────────────
type Action =
  | { action: "tool"; tool: string; input?: unknown; thought?: string }
  | { action: "final"; message: string; thought?: string };

/**
 * Tolerant parser. Small local models rarely emit the exact `{"action":"tool",
 * "tool":...}` shape — they put the tool name directly in `action`, scatter input
 * fields at the top level, etc. We disambiguate against the set of LICENSED tool
 * ids so the loop works with weak models instead of silently no-op'ing.
 */
function parseAction(raw: string, validIds: Set<string>): Action | null {
  const json = extractJson(raw);
  if (!json) return null;
  const obj = tolerantParse(json);
  if (!obj) return null;

  const actionField = typeof obj.action === "string" ? obj.action : undefined;
  const message =
    typeof obj.message === "string"
      ? obj.message
      : typeof obj.answer === "string"
        ? (obj.answer as string)
        : undefined;

  // Explicit final.
  if (actionField === "final" && message) {
    return { action: "final", message, thought: obj.thought as string };
  }

  // Find the intended tool: prefer `action` (models often put the tool name there),
  // then `tool`/`name`. Pick the FIRST candidate that is an actually-licensed tool.
  const candidates = [
    actionField && actionField !== "tool" && actionField !== "final" ? actionField : undefined,
    typeof obj.tool === "string" ? (obj.tool as string) : undefined,
    typeof obj.name === "string" ? (obj.name as string) : undefined,
    typeof obj.tool_name === "string" ? (obj.tool_name as string) : undefined,
  ].filter((x): x is string => Boolean(x));
  const toolId = candidates.find((c) => validIds.has(c));
  if (toolId) {
    return { action: "tool", tool: toolId, input: collectInput(obj), thought: obj.thought as string };
  }

  // No valid tool → if there's any message, treat as final answer.
  if (message) return { action: "final", message, thought: obj.thought as string };
  return null;
}

/** Gather tool input, merging an explicit `input` object with any stray top-level keys. */
function collectInput(obj: Record<string, unknown>): Record<string, unknown> {
  const omit = new Set([
    "action",
    "tool",
    "name",
    "tool_name",
    "thought",
    "message",
    "answer",
    "input",
    "reason",
  ]);
  const stray: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (!omit.has(k)) stray[k] = v;
  const explicit = obj.input && typeof obj.input === "object" ? (obj.input as Record<string, unknown>) : {};
  return { ...stray, ...explicit };
}

/**
 * Parse JSON, tolerating a common weak-model defect: literal newlines/tabs inside string
 * values (e.g. a multi-line draft put in a "value" field), which strict JSON.parse rejects.
 * We retry after escaping raw control chars that appear inside strings.
 */
function tolerantParse(json: string): Record<string, unknown> | null {
  try {
    const o = JSON.parse(json);
    return o && typeof o === "object" ? (o as Record<string, unknown>) : null;
  } catch {
    /* try sanitized */
  }
  try {
    const o = JSON.parse(sanitizeJsonControls(json));
    return o && typeof o === "object" ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Escape raw newlines/CR/tabs that appear INSIDE JSON string literals (illegal per spec). */
function sanitizeJsonControls(s: string): string {
  let out = "";
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inStr) {
      if (esc) {
        out += c;
        esc = false;
      } else if (c === "\\") {
        out += c;
        esc = true;
      } else if (c === '"') {
        out += c;
        inStr = false;
      } else if (c === "\n") out += "\\n";
      else if (c === "\r") out += "\\r";
      else if (c === "\t") out += "\\t";
      else out += c;
    } else {
      if (c === '"') inStr = true;
      out += c;
    }
  }
  return out;
}

/** Extract the first balanced JSON object from a possibly-noisy model response. */
function extractJson(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else {
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

function observation(text: string): LLMMessage {
  return { role: "user", content: `Observation: ${text}` };
}

function previewOf(tool: ToolDefinition, input: unknown): string {
  return `${tool.id} ${truncate(JSON.stringify(input), 240)}`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
