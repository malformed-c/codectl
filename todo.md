## Done
- Model -> CodePlan JSON -> Python bridge -> Ansible run playbook -> Codeq codemods -> Result back to model
- Graph memory: human-readable IDs, remove action, Ebbinghaus decay, RRF search (`memory/`)
- `pipe` tool (`tools/pipe.ts`)
- Subagent + `ask`/`message` tools (`tools/subagent.ts`, `tools/ask.ts`)
- `transform`/`extract` with `save_to` + memory key source (`tools/transform.ts`)
- `validate_plan` + codeplan schema tools
- Task engine (`tools/task.ts`)
- Gemini `MALFORMED_FUNCTION_CALL` recovery with corrective retry
- Generic `withRetry` shared across adapters (`utils/retry.ts`)
- Telegram door (`door/telegram.ts`)
- Checkpoint store
- Tool library compact signatures + optional prefix filter
- `$var` / `${var}` memory variable interpolation in tool args
- Step-based turn model (`ParsedTurn` with discriminated union steps)
- FSM redesign: `idle` / `chat` / `agent` with trigger ownership
- Agent ejection on consecutive tool failures

## Open

### Infrastructure
1. `frontend/config.ts` — typed config loader (currently inline in `index.ts`)
4. `frontend/door/cli.ts` — CLI door (Telegram is primary; CLI useful for local dev/testing)
6. Move adapter files to `frontend/api/` (kobold, openai, gemini)
9. Rewrite backend
10. Write more tests
12. Add proper logging levels
16. Different sampler settings per mode (temperature/topP for chat vs agent)
20. Store mode in checkpoint and restore on load
21. Store all model state and restore it

### Agent / FSM
28. Entropy-based agent ejection — detect model spinning / low-information loops and eject
29. FSM history and message crawler

### Parsing / tool format
15. Normalize tool call whitespace before rerendering
17. Combine repeated identical tool calls (parsing artifact)
18. Combine tool results
23. Punish model when closing token found without opening token
27. Normalize Ansible playbook when field is missing (fill defaults)

### Misc
14. Tools reactive prerequisites
19. Refactor wrapper handler to lambdas
22. Check tool handler result, count it as failure
25. Interrupt model at turn boundary on incoming user message
