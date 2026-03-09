# codectl

A TypeScript LLM orchestration framework. Run an AI agent on your own machine using any model supported by [KoboldCpp](https://github.com/LostRuins/koboldcpp), or route to OpenAI/Gemini when you need more power. Chat and issue commands over Telegram from anywhere.

## What it does

- **Chat and agent modes** — conversational chat or fully autonomous multi-step agent runs with a configurable turn budget
- **FSM-based conversation state** — strict call/result pairing prevents orphaned tool calls and malformed history
- **Entropy-based ejection** — agent auto-ejects when spinning or failing; unique successes lower entropy, failures and repeated calls raise it
- **Tool system** — composable primitives: `bash`, `memory`, `memory_graph`, `extract`, `json`, `codeq_*`, `run_plan`, `validate_plan`, `subagent`, `pipe`, and more
- **Memory variable interpolation** — store a value with `memory(set, key, value)`, reference it in any tool arg as `$key` or `${key}`
- **Graph memory** — persistent cross-session memory with FTS5 + graph BFS hybrid search and Ebbinghaus decay
- **Subagents** — spawn child orchestrators for parallel or isolated subtasks with `ask`/`message` communication
- **Telegram door** — Telegram bot as the primary interface; streaming tool call notifications in real time
- **CLI door** — built-in REPL for local testing (no Telegram required)
- **ModelRouter** — config-driven adapter factory; switch models per-agent in `config.yaml`
- **Checkpoint/restore** — full conversation state persists across restarts

## Example: agent mode with Ansible

```
User:   Make a plan to create a test directory with a file inside, then run it

malf:   ⏳ mode({"mode":"agent"})
        ✅ mode  {"switched":"agent","gitRoot":"/home/engi/git/codectl"}

        ⏳ run_plan({"plan":"{ \"codePlan\": [{ \"kind\": \"Ansible\", ... }] }"})
        ✅ run_plan
        {
          "ok": true,
          "results": [
            { "name": "Create test directory",       "status": "changed" },
            { "name": "Create test file inside dir", "status": "changed" },
            { "name": "Verify directory contents",   "status": "changed" }
          ]
        }

        ⏳ mode({"mode":"chat"})
        ✅ mode  {"switched":"chat"}

        Done. Created /tmp/ansible_test/ and /tmp/ansible_test/test.txt.
```

## Example: Gemini native tool calling

```
User:   Can you write your own Ansible plan then and run it

malf:   ⏳ validate_plan({...})
        ✅ validate_plan  {"valid": true, "message": "CodePlan is valid and ready for execution."}

        ⏳ run_plan({...})
        ✅ run_plan  {"ok": true, "results": [{"name":"Create directory","status":"changed"}, ...]}

        ⏳ bash({"command":"cat /tmp/codectl_test/status.txt"})
        ✅ bash  Codectl test successful!

        I have successfully created and executed my own Ansible plan.
```

Set `API_TYPE=gemini-native` with a `GEMINI_API_KEY`. Tools are passed as function declarations — no prompt engineering required. `gemini-interactions` is also supported for stateful server-side sessions.

## Example: memory variable interpolation

```
User:   Pretty print the plan, get the destination path, and add author metadata

malf:   ⏳ json({"action":"pretty","key":"plan"})
        ⏳ json({"action":"get","key":"plan","path":"codePlan[0].spec.tasks[0].args.dest"})
        ⏳ json({"action":"set","key":"plan","path":"codePlan[0].metadata.author","value":"\"malf\""})

        ✅ json  { "codePlan": [ ... ] }
        ✅ json  /tmp/hello.txt
        ✅ json  (updated)

        Destination is /tmp/hello.txt. Author field added to metadata.
```

## Stack

- **Frontend** — Bun + TypeScript: orchestrator, FSM, adapters, tools, Telegram/CLI doors
- **Backend** — Python + uv: Codeq AST/code-edit bridge, Ansible runner
- **Model adapters** — KoboldCpp (local), OpenAI-compatible, Gemini (native + interactions)

## Repository layout

```
frontend/
  index.ts             entrypoint — Telegram door + inline CLI door
  orchestrator.ts      core turn loop, tool dispatch, mode management
  agent-entropy.ts     entropy-based ejection tracker
  fsm.ts               conversation FSM (idle / chat / agent)
  template.ts          prompt templating, model profiles, turn parsing
  renderer.ts          history rendering with budget-aware age compression
  round.ts             Round types (chat / tool / agent / system / error)
  checkpoint.ts        checkpoint save/restore
  room.ts              Room abstraction (orchestrator + metadata)
  kobold.ts            KoboldCpp adapter
  openai.ts            OpenAI-compatible adapter (chat + text)
  gemini.ts            Gemini native + interactions adapters
  native_messages.ts   Message conversion for native tool-calling APIs
  llm/                 ModelRouter, provider protocol, builtin providers
  memory/              Graph memory (SQLite FTS5, Ebbinghaus decay, RRF search)
  tools/               Built-in tool definitions and handlers
  door/telegram.ts     Telegram bot interface
  events/              EventBus, journal, topic subscriptions
  utils/               withRetry and shared utilities

backend/
  main.py              Typer CLI entrypoint
  codeq/               Python Codeq AST/code-edit implementation
```

## Prerequisites

- **Bun 1.3.9+**
- **Python 3.11+** with **uv**
- A running [KoboldCpp](https://github.com/LostRuins/koboldcpp) instance, **or** OpenAI / Gemini API keys

## Setup

```bash
# Frontend
cd frontend
bun install
cp env.sample .env      # fill in tokens and API keys
bun run index.ts        # starts Telegram bot + CLI

# Backend (Ansible bridge — only needed for run_plan)
cd backend
uv sync
uv run codectl --help
```

## Configuration

`frontend/config.yaml`:

```yaml
api_type: koboldcpp          # koboldcpp | openai-chat | openai-text | gemini-native | gemini-interactions
api_server: http://127.0.0.1:5001
default_model: my-model
available_models:
  - models/my-model.yaml

tool_format: typescript      # json | typescript | python
checkpoint_path: ./checkpoints
checkpoint_keep: 20
graph_memory_path: ./memory.db
```

`frontend/models/<name>.yaml` — per-model prompt format:

```yaml
name: my-model
markers:
  systemOpen: "[SYSTEM_PROMPT]"
  systemClose: "[/SYSTEM_PROMPT]\n"
  userOpen: "[INST]"
  userClose: "[/INST]\n"
  modelOpen: ""
  modelClose: "</s>\n"
  reasoningOpen: "[THINK]"
  reasoningClose: "[/THINK]"
  stopSequence: "</s>"
parameters:
  temperature: 0.7
  top_p: 0.95
  max_length: 4096
```

`.env`:

```
TELEGRAM_BOT_TOKEN=...
TELEGRAM_ALLOWED_USERS=123456789,987654321
BASE_URL=http://127.0.0.1:5001
OPENAI_API_KEY=...
GEMINI_API_KEY=...
API_TYPE=koboldcpp           # overrides config.yaml
```

## Tests

```bash
# Frontend (224 tests)
cd frontend && bun test

# Backend
cd backend && uv run run-tests -q
```

## Status

Active development. Core orchestration, tool system, and Telegram door are stable. Backend Codeq alignment is ongoing.
