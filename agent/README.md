# Agent (starter)

This directory contains a minimal starter for a deterministic code-editing agent.

## Current entrypoint

- `CodeEditAgent` in `agent/runner.py`

## Example

```python
from pathlib import Path
from agent import CodeEditAgent

agent = CodeEditAgent(target_file=Path("app.py"))
updated = agent.apply_logic_patch("main", "print('updated')")
print(updated)
```

## Next steps

- Add plan/execute abstractions.
- Add retries and validation hooks.
- Add integration tests that patch fixture files end-to-end.
