# codectl

`codectl` is a code-editing agentic system split into two workspaces:
- a **Bun + TypeScript frontend** for orchestration, prompting, and model adapters
- a **Python backend** for CLI tooling and AST/code-edit operations

## Example: local model via KoboldCpp

codectl runs fully offline with a local model via [KoboldCpp](https://github.com/LostRuins/koboldcpp). The example below uses Ministral 3B over Telegram.

**Create and execute an Ansible plan in agent mode, then return to chat:**

```
User:   Make a plan to create a test directory and a file inside it, then run it

malf:   ⏳ mode({"mode":"agent"})
        ✅ mode  {"switched":"agent","gitRoot":"/home/engi/git/codectl"}

        ⏳ run_plan({"plan":"{ \"codePlan\": [{ \"kind\": \"Ansible\", ... }] }"})
        ✅ run_plan
        {
          "ok": true,
          "results": [
            { "name": "Create test directory",         "status": "changed" },
            { "name": "Create test file inside dir",   "status": "changed" },
            { "name": "Verify directory contents",     "status": "changed" }
          ]
        }

        ⏳ mode({"mode":"chat"})
        ✅ mode  {"switched":"chat"}

        Done. Created /tmp/ansible_test/ and /tmp/ansible_test/test.txt.
```

**Query and mutate a JSON plan using multiple tools in one turn:**

```
User:   Pretty print the plan, get the destination path, and add author metadata

malf:   ⏳ json({"action":"pretty","key":"plan"})
        ⏳ json({"action":"get","key":"plan","path":"codePlan.0.spec.tasks.0.args.dest"})
        ⏳ json({"action":"set","key":"plan","path":"codePlan.0.metadata.author","value":"\"malf\""})

        ✅ json  { "codePlan": [ ... ] }
        ✅ json  /tmp/hello.txt
        ✅ json  (updated)

        Destination is /tmp/hello.txt. Author field added to metadata.
```


## Repository layout

### Top-level workspaces
- `frontend/` - Bun/TypeScript workspace
- `backend/` - Python/uv workspace

### Key frontend modules
- `frontend/index.ts` - frontend entrypoint
- `frontend/template.ts` - message templating/formatting and built-in model profiles
- `frontend/codeq/codeq.ts` - Codeq AST retrieval/edit utilities
- `frontend/kobold.ts` - Kobold API adapter and sampler config

### Key backend modules
- `backend/main.py` - Typer CLI entrypoint (`codectl`), Ansible bridge

### Tests
- `frontend/tests/` - frontend tests
```bash
bun test
```

- `backend/tests/` - backend tests

For deeper frontend-specific details, see [`frontend/README.md`](frontend/README.md).

## Prerequisites

- **Bun 1.3.9+** (current project tooling uses Bun; verify with `bun --version`)
- **Python 3.14+** (required by `backend/pyproject.toml`)
- **uv** for backend environment/dependency management (`uv --version`)

## Run the project

### Frontend

```bash
cd frontend
bun install
bun run index.ts
```

### Backend

```bash
cd backend
uv sync
uv run codectl --help
```

## Run tests

### Frontend tests

```bash
cd frontend
bun test
```

### Backend tests

```bash
cd backend
uv run run-tests -q
```

## Current status / known limitations

The Codeq interface is currently being aligned across stacks. You may see temporary breakage while frontend and backend APIs converge (for example, API version naming differences between TypeScript and Python implementations).
