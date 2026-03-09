# AGENTS.md

## Repository overview

Two stacks, keep changes scoped to the relevant one:

- **Frontend (`frontend/`)** — Bun + TypeScript. Orchestrator, FSM, adapters, tools, doors.
- **Backend (`backend/`)** — Python + uv. Codeq AST bridge, Ansible runner.

---

## Frontend (Bun + TypeScript)

### Key files

| File | Purpose |
|---|---|
| `index.ts` | Entrypoint — loads config, starts Telegram door + inline CLI |
| `orchestrator.ts` | Core turn loop, tool dispatch, mode management, ejection |
| `agent-entropy.ts` | Entropy-based ejection tracker (score rises on failure/repeat, falls on unique success) |
| `fsm.ts` | Conversation FSM: `idle → chat ↔ agent` |
| `template.ts` | Prompt templating, model profiles (`Profiles.*`), turn parsing (`parse`, `makeTurn`) |
| `renderer.ts` | History → prompt string with budget-aware age compression |
| `round.ts` | Round factories: `chatRound`, `toolRound`, `agentRound`, `systemRound`, `errorRound` |
| `checkpoint.ts` | `CheckpointStore` — save/restore conversation state to JSON |
| `room.ts` | `Room` — orchestrator + metadata bundle |
| `kobold.ts` | KoboldCpp adapter |
| `openai.ts` | OpenAI-compatible adapter (chat + text completions) |
| `gemini.ts` | Gemini native + interactions adapters; `messagesToSDKContents` |
| `native_messages.ts` | `roundsToMessages` — convert Round history to Message[] for native APIs |
| `tool.ts` | `ToolDefinition`, `ToolResult`, `ok`/`err` helpers, `loadTool`, `renderTools` |
| `llm/router.ts` | `ModelRouter` — config-driven adapter factory |
| `llm/protocol.ts` | `ModelConfig`, `ProviderConfig`, capability protocol |
| `memory/graph.ts` | `GraphMemory` — SQLite + FTS5, Ebbinghaus decay, RRF search, `remove()` |
| `memory/tool.ts` | `GraphMemoryTool` + `createGraphMemoryHandler` |
| `door/telegram.ts` | `TelegramDoor` — grammY bot, per-chat orchestrators, streaming notifications |

### Tools (`tools/`)

| Tool | File | What it does |
|---|---|---|
| `bash` | `exec.ts` | Persistent shell; stateful cwd |
| `memory` | `memory.ts` | Session key/value store; `$var` interpolation source |
| `memory_graph` | `memory/tool.ts` | Graph memory: add/upsert/link/search/get/list/remove |
| `extract` | `transform.ts` | Pull JSON path or code block from conversation history |
| `json` | `transform.ts` | JSON get/set/append/delete/keys/pretty |
| `instantiate` | `transform.ts` | Template rendering with `{{var}}` substitution |
| `pipe` | `pipe.ts` | Chain tool outputs |
| `codeq_*` | `codeq.ts` | AST-based code read/edit (functions, classes, imports) |
| `validate_plan` | `validate_plan.ts` | Zod-validate a CodePlan JSON blob |
| `run_plan` | `run_plan.ts` | Execute CodePlan via Python backend (Ansible + Codeq) |
| `subagent` | `subagent.ts` | Spawn a child orchestrator |
| `ask` | `ask.ts` | Ask parent / user a blocking question from agent mode |
| `message` | `ask.ts` | Send non-blocking message to parent |
| `task` | `task.ts` | Task tracking |
| `callid_cache` | `callid-cache.ts` | Cross-call result caching by ID |
| `mode` | (orchestrator built-in) | Switch `chat ↔ agent` |
| `done` | (orchestrator built-in) | End agent run with optional result |
| `tool_library` | (orchestrator built-in) | List available tools (optional prefix filter) |

### Typical commands

```bash
cd frontend
bun install
bun run index.ts          # start bot
bun test                  # run all tests (224)
bun tsc --noEmit          # type check
```

### Architecture notes

**Turn model** — `ParsedTurn` uses `steps: Step[]` with discriminated union kinds (`thought | text | tool_call`). Use `turnContent()`, `turnThink()`, `turnToolCalls()` to read steps. Use `makeTurn()` to construct.

**FSM** — Three states. Agent mode carries the triggering user message as `trigger` through the run until committed. Entered only via the `mode` tool. `Orchestrator.injectSystem()` can push system messages into the agent context.

**Entropy ejection** — `AgentEntropyTracker` maintains a score (floor 0, eject ≥ 10). Unique successful calls: −1.5. Repeated successful calls: +0.5. Failures: +2.0. Score resets each `runLoop()` call. Parse failures count as `__parse__` failures.

**Turn budget** — `maxTurns` is evaluated per-iteration, so a `mode` tool switch mid-loop gets the full `autonomousTurns` budget (default 16) rather than the `chatToolTurns` cap (default 5).

**Graph memory node IDs** — `kind:PascalCaseWords` (e.g. `semantic:CleanTaxisCough`) via `human-id`. Edge IDs use `edge:` prefix.

**Native tool calling** — `GeminiNativeAdapter` and `GeminiInteractionsAdapter` use `supportsNativeTools = true`. The orchestrator passes `Message[]` + `ToolDefinition[]` directly; `MALFORMED_FUNCTION_CALL` triggers a single corrective retry.

**ModelRouter** — `ModelRouter.fromConfig(config, secretsGetter)` builds adapters from `config.yaml`. Instances are cached; call `invalidate()` after hot-reload.

---

## Backend (Python + uv)

### Key files

| File | Purpose |
|---|---|
| `backend/main.py` | Typer CLI entrypoint |
| `backend/codeq/main.py` | Python Codeq AST implementation |

### Typical commands

```bash
cd backend
uv sync
uv run codectl --help
uv run run-tests -q
```

---

## Cross-stack notes

- Frontend calls the backend via subprocess (`run_plan` → `uv run codectl run-plan`). Keep the CLI interface stable.
- If frontend/backend APIs are in flux, document the expected shape clearly in the relevant tool or bridge file.
- Prefer small focused changes. Update this file when modules are added or renamed.
