# Contributor handoff

Build a small, understandable OpenCode 2 plugin. Prefer direct code and deletion
to additional orchestration frameworks. Preserve the user's goal and unrelated
checkout changes.

## Module map

- `src/index.ts`: plugin lifecycle, slash commands, run admission, recovery.
- `src/engine.ts`: plan/build/check/review/commit loop and bounded review pool.
- `src/workers.ts`: V2 sessions, model accounting, role restrictions, cancellation.
- `src/git.ts`: clean-start checks, candidate trees, exact reviewed commits.
- `src/state.ts`: durable journal, exclusive repository lock, status text.
- `src/process.ts`: finite subprocesses, cancellation, macOS caffeinate.
- `src/config.ts`: options, model selection, review lenses, resource budgets.
- `src/protocol.ts`: strict planner/reviewer report parsing.

## Keep these contracts

- Use the exact pinned `@opencode-ai/plugin` beta types. Do not introduce V1 APIs.
- Record ownership before prompting a worker. Settle old workers before a new
  builder runs; retain the lock when shutdown cannot be confirmed.
- Keep one builder, bounded concurrent reviewers, and serial validation commands.
- Keep Code Mode `execute` available and enforce role rules on every nested call.
  Never upgrade an existing permission ask/deny into allow.
- Review and commit the same tree and parent. Preserve partial work on failure.
- Keep simplicity in every review panel and final audits within the original goal.
- Store operational state outside tracked source. Do not publish run receipts,
  model credentials, local configuration, or temporary test repositories.

## Dependencies and validation

Only install npm releases at least 24 hours old. Keep exact versions and the
committed lockfile; use `bun install --frozen-lockfile --minimum-release-age 86400`.
The matching setting is in `bunfig.toml`. Check registry publish timestamps before
updating pinned dependencies or the lockfile. Do not bypass the gate to make an
upgrade pass.

Run `npm run check`; it typechecks and runs meaningful tests with two workers.
Use `~/.local/bin/codex-heavy -- <command>` for installs or broad
checks when that local gate exists. Check free disk before large installs and
retain 20 GB where possible. Do not leave temporary services or watchers running.

Test recovery, cancellation, permission denial, review convergence, exact-tree
commits, and package loading when those paths change. Keep claims separate for
local tests, CI, native OpenCode loading, and real model/provider execution.
Update examples when options or the pinned V2 API change.
