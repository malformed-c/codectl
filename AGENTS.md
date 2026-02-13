# AGENTS.md

## Repository-wide instructions

- Frontend prompt debugging should preserve an ST-style JSON preview shape when logging the final provider-bound prompt.
- If modifying `frontend/index.ts`, keep a function that outputs a structured debug object with sections similar to:
  - `instruct`
  - `context`
  - `sysprompt`
  - `preset`
  - `reasoning`
- Include explicit `chat_turns` and a single `rendered_prompt` string that represents the final prompt composition.
- ST marker tokens must be configurable (do not hardcode one fixed marker set).
- Keep the preview emitted immediately before provider send (`transformRequestBody`) to reflect the actual outgoing request.
