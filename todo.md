0. Model -> CodePlan JSON -> Python bridge -> Ansible run playbook -> Codeq codemods -> Result back to model
1. frontend/config.ts
4. frontend/door/cli.ts
6. frontend/api/kobold.ts (move)
7. frontend/api/text_api.ts
8. frontend/api/chat_api.ts
9. Rewrite backend
10. frontend/ Write more tests
11. Move smoke tests to frontend/tests
12. Add proper logging levels
13. (Sub)Agent tool, like grok 4.20
14. Tools reactive prerequisites?
15. When rerendering tools, add/unify spaces, eg model: [TOOL_CALLS]mode[ARGS]{"mode": "agent", "reason": "Automate running Bash commands and interacting with files"}

rerender: [TOOL_CALLS]mode[ARGS]{"mode":"agent","reason":"Automate running Bash commands and interacting with files"}
16. Different sampler settings for different modes
