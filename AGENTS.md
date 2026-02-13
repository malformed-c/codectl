# AGENTS.md

## Repository-wide instructions

- Frontend prompt debugging should preserve preview shape when logging.
- ST marker tokens must be configurable (do not hardcode one fixed marker set).
- Keep the preview emitted immediately before provider send (`transformRequestBody`) to reflect the actual outgoing request.
