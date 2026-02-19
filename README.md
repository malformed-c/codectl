# codectl

`codectl` is a code-editing agentic system split into two workspaces:
- a **Bun + TypeScript frontend** for orchestration, prompting, and model adapters
- a **Python backend** for CLI tooling and AST/code-edit operations

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
