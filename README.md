# codectl

A TypeScript LLM orchestration framework for local and cloud models, controlled over Telegram.

Run an AI agent on your own machine — no cloud dependency, no API costs — using any model supported by [KoboldCpp](https://github.com/LostRuins/koboldcpp). Or route to OpenAI/Gemini when you need more power. Chat and issue commands from Telegram from anywhere.

## What it does

- **Chat and agent modes** — conversational chat or fully autonomous multi-step agent runs with a configurable turn budget
- **FSM-based conversation state** — strict call/result pairing prevents orphaned tool calls and malformed history
- **Tool system** — composable primitives the model can chain: `memory`, `extract`, `json`, `bash`, `codeq_*`, `run_plan`, `validate_plan`, `subagent`, and more
- **Memory variable interpolation** — store a value with `memory`, reference it in any subsequent tool call as `$key`
- **Graph memory** — persistent cross-session memory with FTS5+graph hybrid search and Ebbinghaus decay
- **Subagents** — spawn child orchestrators for parallel or isolated subtasks
- **Telegram door** — Telegram bot as the primary interface; streaming tool call notifications in real time

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

Running on `gemini-3.1-flash-lite-preview` via the native function-calling API:

```
User:   Can you write your own Ansible plan then and run it

malf:   ⏳ validate_plan({...})
        ✅ validate_plan  {"valid": true, "message": "CodePlan is valid and ready for execution."}

        ⏳ run_plan({...})
        ✅ run_plan
        {
          "ok": true,
          "results": [
            { "name": "Create directory",  "status": "changed" },
            { "name": "Create status file","status": "changed" }
          ]
        }

        ⏳ bash({"command":"cat /tmp/codectl_test/status.txt"})
        ✅ bash  Codectl test successful!

        I have successfully created and executed my own Ansible plan.
```

Set `API_TYPE=gemini-native` (or `gemini-interactions`) with a `GEMINI_API_KEY` to use Gemini models. Tools are passed as function declarations — no prompt engineering required.



Memory variable substitution and multiple tool calls in a single turn:

```
User:   Pretty print the plan, get the destination path, and add author metadata

malf:   ⏳ json({"action":"pretty","key":"plan"})
        ⏳ json({"action":"get","key":"plan","path":"codePlan[0].spec.tasks[0].args.dest"})
        ⏳ json({"action":"set","key":"plan","path":"codePlan[0].metadata.author","value":"\"malf\""})

        ✅ json
        { "codePlan": [ ... ] }

        ✅ json
        /tmp/hello.txt

        ✅ json
        (updated)

        Destination is /tmp/hello.txt. Author field added to metadata.
```

## Stack

- **Frontend** — Bun + TypeScript: orchestrator, FSM, adapters, tools, Telegram door
- **Backend** — Python + uv: CLI tooling, AST/code-edit operations, Ansible bridge
- **Model adapters** — KoboldCpp (local), OpenAI, Gemini

## Repository layout

```
frontend/
  index.ts          entrypoint
  orchestrator.ts   core loop, tool dispatch, mode management
  fsm.ts            conversation state machine
  template.ts       prompt templating, model profiles, turn parsing
  kobold.ts         KoboldCpp adapter
  openai.ts         OpenAI adapter
  renderer.ts       history rendering with budget-aware compression
  memory/           graph memory (SQLite, FTS5, Ebbinghaus decay)
  tools/            built-in tool definitions and handlers
  door/telegram.ts  Telegram bot interface

backend/
  main.py           Typer CLI entrypoint, Ansible bridge
```

## Prerequisites

- **Bun 1.3.9+**
- **Python 3.14+**
- **uv**
- A running [KoboldCpp](https://github.com/LostRuins/koboldcpp) instance, or OpenAI/Gemini API keys

## Setup

```bash
# Frontend
cd frontend
bun install
cp .env.example .env   # add TELEGRAM_TOKEN, KOBOLD_URL or API keys
bun run index.ts

# Backend
cd backend
uv sync
uv run codectl --help
```

## Tests

```bash
# Frontend (192 tests)
cd frontend && bun test

# Backend
cd backend && uv run run-tests -q
```

## Status

Active development. The Codeq interface is being aligned across stacks — you may see temporary breakage while frontend and backend APIs converge.
