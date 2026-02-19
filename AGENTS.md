# AGENTS.md

## Repository-wide instructions

This repository has two main stacks:

- **Frontend (`frontend/`)** is written in **Bun + TypeScript**.
- **Backend (`backend/`)** is written in **Python**.

When making edits, keep changes scoped to the relevant stack and use each workspace's native tooling.

### Backend written with Python
### Frontend (Bun + TypeScript)

Key files/modules:

- `frontend/codeq/codeq.ts`
  Codeq AST retrieval/edit utilities.
- `frontend/template.ts`
  Message templating/formatting and built-in model profiles.
- `frontend/kobold.ts`
  Kobold API adapter and sampler configuration.

Typical commands:

```bash
cd frontend
bun install
bun run index.ts
bun test
```

### Backend (Python)

Key files/modules:

- `backend/main.py`
  Typer CLI entrypoint.
- `backend/codeq/main.py`
  Python Codeq implementation.

Typical commands:

```bash
cd backend
uv sync
uv run codectl --help
uv run run-tests -q
```

## Notes for contributors/agents

- Prefer small, focused changes.
- Keep docs in sync when behavior or commands change.
- If APIs between frontend/backend are in flux, document expected limitations clearly.
