models.py
Pydantic models that mirror the TypeScript codeplan.schema.ts types
for the Ansible subset of a CodePlan.

Only the Ansible-relevant slice is modelled here; CodeEdit items are
handled entirely by the Bun frontend and never reach the backend.

---

main.py
Two entry points:

1. stdin/stdout runner (no subcommand)
   Bun spawns this as a subprocess and pipes JSON in/out.

   stdin:  { "items": [ <AnsibleItem>, ... ] }
   stdout: { "ok": bool, "results": [...], "error": "..." | null }

2. Typer CLI subcommands
   codectl run-plan <file.json>   - run Ansible items from a plan file
   codectl validate  <file.json>  - validate a plan file

---

ansible_bridge.py
Runs Ansible plays in-process using the Ansible Python API.
No temp files, no subprocess, no YAML on disk.

Flow:
  AnsibleItem[] ? play dicts ? Play.load() ? TaskQueueManager.run()
                ? ResultCallback captures per-task results
                ? AnsibleReport

---

Tests for ansible_bridge.py and models.py
TaskQueueManager is mocked so ansible-core doesn't need to be installed
in CI. build_play_dicts and _parse_* helpers are tested directly.
