# Jarvis

> A local-first AI **Chief of Staff**. An organization of 21 specialist agents that
> you run as CEO. You state outcomes; the org does the work. Your data stays on your
> machine, secrets are encrypted, and nothing acts in your name without your sign-off.

This is **v1** — the foundation. It runs entirely on your PC, for ₹0:

- **Local SQLite** for memory, audit, and the encrypted vault — no cloud database.
- **Local LLM via Ollama** (nothing leaves your machine), or **Gemini free tier** if you prefer.
- **All 21 agents** registered and routable on day one (plus Guardian + Librarian).
- **Encrypted secret vault** (AES-256-GCM), an **immutable audit log**, **autonomy/approval
  gating** (draft-only by default), and a **kill switch**.

---

## Quick start

```bash
# 1. Install dependencies (one time)
npm install

# 2. Configure
cp .env.example .env
#    → set JARVIS_MASTER_KEY to a long, unique passphrase (this encrypts your vault)

# 3. Choose a brain (pick ONE):

#    Option A — fully local & private (recommended). Install Ollama from ollama.com, then:
ollama pull llama3.2            # the chat brain
ollama pull nomic-embed-text   # embeddings, so memory recall is semantic
#    (leave JARVIS_LLM_PROVIDER=auto with no GEMINI_API_KEY → uses Ollama)

#    Option B — Gemini free tier (higher quality, prompts go to Google):
#    get a free key at https://aistudio.google.com/apikey and set GEMINI_API_KEY in .env

# 4. Talk to your organization
npm start
```

Verify the core without a model anytime:

```bash
npm run smoke      # exercises crypto, vault, memory, audit, policy — all offline
npm run typecheck  # static type check
```

---

## Using it

At the `you ▸` prompt, state an outcome:

```
you ▸ Remember that I prefer aisle seats and never red-eye flights.
you ▸ Research the top 3 project-management tools for a 5-person team and summarize.
you ▸ Draft a polite reply declining a meeting next Tuesday.
```

The Chief of Staff routes each to the right specialist(s), runs them, and reports back.
Outward actions pause for your approval.

Slash commands:

| Command | What it does |
|---|---|
| `/agents` | List the whole organization by department |
| `/memory` | Show what Jarvis remembers (and where it learned it) |
| `/audit` | Recent actions — the trust log |
| `/autonomy [id] [0-5]` | View or set an agent's autonomy dial (capped at its ceiling) |
| `/kill` | Engage/release the kill switch (pause all outward actions) |
| `/brief` | Quick status brief |
| `/help` `/quit` | — |

---

## Architecture (v1)

```
  CLI surface ──▶ Chief of Staff (orchestrator) ──▶ specialist agents (× 21)
                         │                                  │
                         ▼                                  ▼
                 plan → delegate → synthesize        runAgent() loop
                                                     (reason → tool → observe)
                                                            │
        ┌───────────────────┬───────────────────┬──────────┴───────────┐
        ▼                   ▼                   ▼                      ▼
   Memory (SQLite      Tool registry      Policy / autonomy        Audit log
   + embeddings)       (MCP-ready)        gate + kill switch       (append-only)
                                                │
                                          Encrypted Vault (AES-256-GCM)
```

Key idea: **an agent is a declarative spec, not a codebase.** All 21 share one
runtime (`src/core/agent.ts`). Giving an agent more power = granting it more tools
in `src/agents/specs.ts`. That's why "all 21 in v1" adds no infrastructure.

| Path | Role |
|---|---|
| `src/agents/specs.ts` | The org chart — all agents as specs |
| `src/core/orchestrator.ts` | Chief of Staff: plan → delegate → synthesize |
| `src/core/agent.ts` | The universal agent runtime (reason/act loop) |
| `src/core/tools.ts` | Tool registry + built-in v1 tools |
| `src/core/memory.ts` | Layered long-term memory + recall |
| `src/core/policy.ts` | Autonomy levels, approval gating, kill switch |
| `src/core/audit.ts` | Immutable action log |
| `src/core/security/` | AES-256-GCM crypto + encrypted vault |
| `src/core/llm/providers.ts` | Ollama (local) + Gemini, behind one interface |

See **SECURITY.md** for the trust model and **ROADMAP.md** for how each agent deepens.
