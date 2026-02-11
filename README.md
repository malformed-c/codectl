# codectl

A small code-editing toolkit built around `Codeq` and a starter agent.

## CLI (Typer)

Run the CLI:

```bash
uv run codectl patch-logic path/to/file.py function_name "print('updated')"
```

## Tests

A test script is exposed in `pyproject.toml`:

```bash
uv run run-tests -q
```
