# Goal plugin

Keep this plugin small. The user explicitly rejected Churn's orchestration complexity.

- `src/engine.ts`: the slice loop, ten review rounds, structured reports.
- `src/workers.ts`: native OpenCode sessions and interruption.
- `src/index.ts`: four slash commands and one progress file.

Use the pinned OpenCode V2 beta API. One writer at a time. Every review round has three independent reviewers followed by one evaluator. Preserve unrelated edits, report blockers honestly, and never auto-commit or publish user work. Do not add frameworks, custom Git workflows, or a configurable validation runner.

Use fresh worker sessions and small relevant handoffs. Settle interrupted workers before admitting another writer. Never checkpoint a failed or canceled worker as successful. Keep progress files private and outside published artifacts.

Keep dependencies pinned and at least 24 hours old. Run `npm run check` and the native smoke test when changing plugin behavior. Use a shared heavy-command gate where available; at most two test workers. Distinguish deterministic integration evidence from real-model execution.
