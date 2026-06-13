/**
 * The Chief of Staff orchestrator. It receives an outcome from the CEO and decides:
 *   - CHAT   → answer directly in one fast call (greetings, advice, knowledge, drafts).
 *   - DELEGATE → staff it to 1–3 specialists who run the tool loop, then synthesize.
 *
 * Routing is HYBRID: cheap heuristics catch common, high-value intents reliably
 * (so we don't depend on a small model's planning), and an LLM router handles the
 * rest. This is what stops trivial input ("hi") from spinning the full tool loop.
 */

import { runAgent, type AgentDeps } from "./agent";
import { AGENTS_BY_ID, ROUTABLE_AGENTS } from "../agents/specs";
import type { AgentSpec, LLMMessage, ToolServices } from "../types";

/** Per-call tenant scoping: which user this request acts for, and their scoped services. */
interface Scope {
  userId?: string;
  services?: ToolServices;
}

interface PlanStep {
  agent: string;
  task: string;
}

type Route = { mode: "chat" } | { mode: "delegate"; plan: PlanStep[]; batch?: boolean };

export class Orchestrator {
  constructor(private deps: AgentDeps) {}

  /** Resolve the per-call AgentDeps: the base deps, overlaid with this request's tenant. */
  private depsFor(scope: Scope): AgentDeps {
    if (!scope.services && !scope.userId) return this.deps;
    return {
      ...this.deps,
      services: scope.services ?? this.deps.services,
      userId: scope.userId ?? this.deps.userId,
    };
  }

  async handle(
    outcome: string,
    opts: {
      history?: LLMMessage[];
      onProgress?: (msg: string) => void;
      /** Fired as agents start/stop working — drives the HUD's per-agent pulse. */
      onAgent?: (agentId: string, active: boolean) => void;
      /** Fired when one agent communicates with another — drives the A2A viz. */
      onA2A?: (from: string, to: string, msg: string) => void;
      /** Tenant this request acts for (web user); defaults to the owner tenant. */
      userId?: string;
      services?: ToolServices;
    } = {},
  ): Promise<string> {
    const deps = this.depsFor(opts);
    const history = opts.history ?? [];
    const progress = opts.onProgress ?? (() => {});
    const onAgent = opts.onAgent ?? (() => {});
    const onA2A = opts.onA2A ?? (() => {});
    const lastAssistant = [...history].reverse().find((m) => m.role === "assistant")?.content ?? "";

    // The Chief of Staff is engaged for the whole request (routing + synthesis).
    onAgent("chief-of-staff", true);
    try {
      const route = this.quickRoute(outcome, lastAssistant) ?? (await this.llmRoute(outcome, history));

      if (route.mode === "chat") {
        progress("Chief of Staff is answering directly…");
        return await this.chatAnswer(outcome, history, deps);
      }

      progress(
        `Chief of Staff staffed this to: ${route.plan.map((s) => AGENTS_BY_ID[s.agent]?.name ?? s.agent).join(", ")}`,
      );

      const results: { agent: AgentSpec; output: string }[] = [];
      let sharedContext = `The CEO's outcome: ${outcome}`;
      let prevAgent: string | null = null;

      for (const step of route.plan) {
        const spec = AGENTS_BY_ID[step.agent];
        if (!spec) continue;
        progress(`→ ${spec.name}: ${step.task}`);
        // A2A: the Chief of Staff hands the task to this specialist (and a prior
        // specialist's output flows to the next when agents are chained).
        onA2A(prevAgent ?? "chief-of-staff", spec.id, step.task);
        onAgent(spec.id, true);
        try {
          const res = await runAgent(spec, step.task, deps, sharedContext, history);
          results.push({ agent: spec, output: res.message });
          sharedContext += `\n\n[${spec.name}] reported:\n${res.message}`;
          onA2A(spec.id, "chief-of-staff", res.message); // reports back
        } finally {
          onAgent(spec.id, false);
        }
        prevAgent = spec.id;
      }

      if (results.length === 0) return await this.chatAnswer(outcome, history, deps);
      if (results.length === 1) return `**${results[0]!.agent.name}:** ${results[0]!.output}`;

      // A try-all batch → show each agent's own reply. A real collaboration → synthesize.
      if (route.batch) {
        return results.map((r) => `**${r.agent.name}:**\n${r.output}`).join("\n\n———\n\n");
      }
      progress("Chief of Staff is synthesizing the results…");
      return await this.synthesize(outcome, results);
    } finally {
      onAgent("chief-of-staff", false);
    }
  }

  /**
   * DIRECT LINE — the CEO talks to ONE specialist, bypassing all routing. The message
   * goes straight to that agent's tool loop; no other agent is involved.
   */
  async runDirect(
    agentId: string,
    message: string,
    opts: {
      history?: LLMMessage[];
      onProgress?: (msg: string) => void;
      onAgent?: (agentId: string, active: boolean) => void;
      userId?: string;
      services?: ToolServices;
    } = {},
  ): Promise<string> {
    const deps = this.depsFor(opts);
    const spec = AGENTS_BY_ID[agentId];
    const onAgent = opts.onAgent ?? (() => {});
    const progress = opts.onProgress ?? (() => {});
    if (!spec || agentId === "chief-of-staff") {
      onAgent("chief-of-staff", true);
      try {
        return await this.chatAnswer(message, opts.history ?? [], deps);
      } finally {
        onAgent("chief-of-staff", false);
      }
    }
    onAgent(spec.id, true);
    try {
      progress(`Direct line to ${spec.name}…`);
      const res = await runAgent(spec, message, deps, "", opts.history ?? []);
      return res.message;
    } finally {
      onAgent(spec.id, false);
    }
  }

  /**
   * WIRED CIRCUIT — 2–3 specialists collaborate on ONE task. Each takes a turn in
   * order, sees what came before, and adds their part; every turn is surfaced live
   * (onTurn) and every hand-off animates (onA2A) so the CEO can watch them work together.
   */
  async runWired(
    agentIds: string[],
    task: string,
    opts: {
      onProgress?: (msg: string) => void;
      onAgent?: (agentId: string, active: boolean) => void;
      onA2A?: (from: string, to: string, msg: string) => void;
      onTurn?: (agentId: string, message: string) => void;
      userId?: string;
      services?: ToolServices;
    } = {},
  ): Promise<string> {
    const deps = this.depsFor(opts);
    const specs = agentIds
      .map((id) => AGENTS_BY_ID[id])
      .filter((s): s is AgentSpec => !!s && s.id !== "chief-of-staff")
      .slice(0, 3);
    const onAgent = opts.onAgent ?? (() => {});
    const onA2A = opts.onA2A ?? (() => {});
    const onTurn = opts.onTurn ?? (() => {});
    const progress = opts.onProgress ?? (() => {});

    if (specs.length < 2) {
      return specs[0]
        ? await this.runDirect(specs[0].id, task, { onProgress: progress, onAgent, userId: opts.userId, services: opts.services })
        : "Wire at least two agents together to collaborate.";
    }

    const names = specs.map((s) => s.name).join(" + ");
    progress(`Wiring ${names} together on this task…`);
    const turns: { agent: AgentSpec; output: string }[] = [];
    let context =
      `COLLABORATION between teammates: ${names}.\nJoint task from the CEO: ${task}\n` +
      `Each teammate adds their part in their own specialty and builds on what came before — never repeat work already done.`;
    let prev: AgentSpec | null = null;

    for (const spec of specs) {
      if (prev) await new Promise((r) => setTimeout(r, 1000)); // space calls — gentler on free-tier rate limits
      onA2A(prev ? prev.id : "chief-of-staff", spec.id, prev ? `over to ${spec.name}` : task);
      onAgent(spec.id, true);
      try {
        const turnTask = prev
          ? `${task}\n\nYour teammate ${prev.name} just contributed:\n"""${turns[turns.length - 1]!.output}"""\n\n` +
            `Now add YOUR part as the ${spec.name}: build on theirs, cover your specialty, fill the gaps — do NOT repeat what's already done. Be concrete.`
          : `${task}\n\nYou're opening a collaboration with ${specs.filter((s) => s !== spec).map((s) => s.name).join(" and ")}. ` +
            `Do YOUR part as the ${spec.name} first; your teammate(s) will build on it. Be concrete.`;
        const res = await runAgent(spec, turnTask, deps, context, []);
        turns.push({ agent: spec, output: res.message });
        onTurn(spec.id, res.message);
        context += `\n\n[${spec.name}]:\n${res.message}`;
        if (prev) onA2A(spec.id, prev.id, "built on your part");
      } finally {
        onAgent(spec.id, false);
      }
      prev = spec;
    }
    return `✅ ${names} finished collaborating — ${turns.length} contributions above.`;
  }

  /**
   * Cheap, reliable heuristics for the most common intents. Returns null to defer
   * to the LLM router. These don't need the model to plan correctly.
   */
  private quickRoute(outcome: string, lastAssistant = ""): Route | null {
    const raw = outcome.trim();

    // EXPLICIT addressing: "@calendar what's on my week" sends the task straight to that
    // agent. MULTIPLE @mentions in one message run as a batch (try-all-agents), each
    // getting only its own text (up to the next @).
    if (raw.startsWith("@")) {
      const mentions = [...raw.matchAll(/@([a-z][a-z-]*)\s+([^@]+)/gi)]
        .map((m) => ({ agent: m[1]!.toLowerCase(), task: m[2]!.trim() }))
        .filter((s) => AGENTS_BY_ID[s.agent] && s.agent !== "chief-of-staff");
      if (mentions.length) {
        return { mode: "delegate", plan: mentions.slice(0, 8), batch: mentions.length > 1 };
      }
    }

    // FOLLOW-UP: if my last reply asked for a city/location and the CEO answered with a
    // short place name, continue the weather task instead of treating it as a new topic.
    if (
      /which city|specify the city|tell me the city|what city|provide.*(city|location)|location.*weather|weather.*location/i.test(lastAssistant) &&
      /^[a-z][a-z .,'-]{1,38}$/i.test(raw) &&
      raw.split(/\s+/).length <= 4
    ) {
      return { mode: "delegate", plan: [{ agent: "secretary", task: `What's the weather in ${raw}?` }] };
    }

    // Strip a leading greeting so a greeting PREFIX doesn't swallow a real request —
    // "hi what's the weather" must still route to weather, not small talk.
    const body = raw
      .replace(/^(hi+|hello+|hey+|yo|sup|gm|hiya|namaste|good (morning|afternoon|evening)|thanks|thank you)[\s,!.:;-]*/i, "")
      .trim();
    if (body === "") return { mode: "chat" }; // the message was ONLY a greeting
    const t = body.toLowerCase();

    // Memory writes → secretary (has the remember tool).
    if (/^(remember|note that|keep in mind|don'?t forget|save this)\b/.test(t))
      return { mode: "delegate", plan: [{ agent: "secretary", task: outcome }] };

    // Weather → secretary (has the weather tool).
    if (/\b(weather|forecast|temperature|how hot|how cold|will it rain|humidity)\b/.test(t))
      return { mode: "delegate", plan: [{ agent: "secretary", task: outcome }] };

    // Reminders / nudges → secretary (has the reminder tools).
    if (/\b(remind me|reminder|nudge me|ping me|don'?t let me forget|wake me|alert me|set a reminder|my reminders)\b/.test(t))
      return { mode: "delegate", plan: [{ agent: "secretary", task: outcome }] };

    // Money / spend tracking → finance agent (bank CSV tools).
    if (/\b(spend(ing)?|expenses?|my budget|transactions?|bank statement|my finances?|subscriptions?|import.{0,12}(csv|statement|transactions?)|how much did i (spend|pay|save)|where('?s| is) my money going|categor(y|ies|ize).{0,12}(spend|expense)?)\b/.test(t))
      return { mode: "delegate", plan: [{ agent: "finance", task: outcome }] };

    // A pasted URL → research agent fetches & summarizes it.
    if (/\bhttps?:\/\/\S+/.test(outcome))
      return { mode: "delegate", plan: [{ agent: "research", task: outcome }] };

    // Live-data lookups → research agent (web tools).
    if (/\b(research|look up|search for|latest|news|headlines|stories|competitors?|find out|what'?s happening|price of|how much (is|does))\b/.test(t))
      return { mode: "delegate", plan: [{ agent: "research", task: outcome }] };

    // Jobs / applications → job application agent.
    if (/\b(apply|applying|application|cover letter|tailor.{0,14}(resume|résumé|cv)|job (posting|listing|opening|hunt|application|search)|find.{0,15}jobs?|my (resume|résumé|cv))\b/.test(t))
      return { mode: "delegate", plan: [{ agent: "jobs", task: outcome }] };

    // Email → email agent (Gmail tools).
    if (/\b(inbox|unread|e-?mails?|gmail)\b/.test(t) || /\b(reply|respond|draft|send)\b[\s\S]*\b(email|mail|message)\b/.test(t))
      return { mode: "delegate", plan: [{ agent: "email", task: outcome }] };

    // Calendar / scheduling → calendar agent (Calendar tools).
    if (
      /\b(calendar|agenda|appointments?)\b/.test(t) ||
      /\b(what'?s on|am i free|free|busy)\b[\s\S]*\b(today|tomorrow|week|schedule)\b/.test(t) ||
      /\b(schedule|set up|book|add|move|reschedule|cancel)\b[\s\S]*\b(meeting|event|appointment|call|invite)\b/.test(t)
    )
      return { mode: "delegate", plan: [{ agent: "calendar", task: outcome }] };

    // Advice / explanation / drafting / planning → clean single chat answer (no tool loop,
    // which a small model handles far better than a tool-using loop).
    if (/^(how (should|do|can|might|to)|what'?s the best|what should|why|explain|tell me about|advice|should i|draft|write|compose|outline|summari[sz]e|plan |give me|create a|make a|help me)\b/.test(t))
      return { mode: "chat" };

    return null;
  }

  /** LLM router: decide chat vs delegate, with few-shot examples and conversation context. */
  private async llmRoute(outcome: string, history: LLMMessage[] = []): Promise<Route> {
    const roster = ROUTABLE_AGENTS.map((a) => `- ${a.id}: ${a.purpose}`).join("\n");
    const messages: LLMMessage[] = [
      {
        role: "system",
        content:
          "You are the Chief of Staff. Decide how to handle the CEO's latest message. DEFAULT to \"chat\".\n" +
          "- Use \"chat\" for anything you can answer in prose: small talk, questions, advice, explanations, planning, and DRAFTS (emails, posts, JDs). This is the common case.\n" +
          "- Use \"delegate\" ONLY when the task needs a live tool: web research/news, weather, the CEO's Gmail, the CEO's Calendar, or storing/recalling memory. Then pick 1 agent.\n" +
          "- The message may be a SHORT REPLY to your previous question (use the conversation). E.g. if you asked which city and they reply 'Goa', delegate the weather task for Goa.\n\n" +
          "Delegate targets: research (web/news), secretary (weather, reminders/nudges, remember/recall), email (Gmail: triage/read/draft/send), calendar (Google Calendar: list/create/reschedule), finance (spend tracking from imported bank CSVs: summary/transactions).\n\n" +
          "Respond with ONE JSON object only. Examples:\n" +
          '{"mode":"chat"}   (for: "draft an email", "how do I...", "explain X", "plan my trip")\n' +
          '{"mode":"delegate","plan":[{"agent":"research","task":"find the 3 biggest fintech stories this week and summarize"}]}\n' +
          '{"mode":"delegate","plan":[{"agent":"secretary","task":"what is the weather in Goa today"}]}',
      },
      ...history.slice(-6),
      { role: "user", content: outcome },
    ];
    const text = await this.deps.llm.chat(messages);
    const json = extractJson(text);
    if (!json) return { mode: "chat" };
    try {
      const obj = JSON.parse(json) as { mode?: string; plan?: PlanStep[] };
      if (obj.mode === "delegate" && Array.isArray(obj.plan)) {
        const plan = obj.plan
          .filter((s) => s && typeof s.agent === "string" && typeof s.task === "string")
          .filter((s) => AGENTS_BY_ID[s.agent] && s.agent !== "chief-of-staff")
          .slice(0, 3);
        if (plan.length > 0) return { mode: "delegate", plan };
      }
      return { mode: "chat" };
    } catch {
      return { mode: "chat" };
    }
  }

  /** Fast single-call conversational answer — no tool loop. Honest about v1 limits. */
  private async chatAnswer(outcome: string, history: LLMMessage[] = [], deps: AgentDeps = this.deps): Promise<string> {
    const memories = await deps.services.memory.recall(outcome, 6).catch(() => []);
    const memBlock = memories.length
      ? "What you know about the CEO:\n" + memories.map((m) => `- ${m.key}: ${m.content}`).join("\n")
      : "";
    const text = await this.deps.llm.chat([
      {
        role: "system",
        content:
          "You are the CEO's Chief of Staff — warm, concise, and genuinely helpful. Answer directly, using the conversation so far. " +
          "Your team CAN handle email, calendar, research, travel, drafting and more; outward actions (sending, booking, buying) happen with the CEO's approval. " +
          "Give advice, knowledge, and drafts directly. Do NOT claim you're unable to do things — just help, or note you'll route it to the right specialist. " +
          "Never mention JSON, tools, or internal limitations.\n\n" +
          memBlock,
      },
      ...history.slice(-6),
      { role: "user", content: outcome },
    ]);
    return text.trim() || "I'm here — what would you like to get done?";
  }

  private async synthesize(
    outcome: string,
    results: { agent: AgentSpec; output: string }[],
  ): Promise<string> {
    const body = results.map((r) => `### ${r.agent.name}\n${r.output}`).join("\n\n");
    const text = await this.deps.llm.chat([
      {
        role: "system",
        content:
          "You are the Chief of Staff. Synthesize your specialists' work into ONE concise brief for the CEO: " +
          "what was accomplished, what (if anything) needs a decision, and clear next steps. Do not pad.",
      },
      { role: "user", content: `Outcome: ${outcome}\n\nSpecialist results:\n${body}` },
    ]);
    return text.trim() || body;
  }
}

/** Minimal balanced-JSON extractor (tolerant of surrounding prose / code fences). */
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
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}
