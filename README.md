# OpenCode Churn

Give OpenCode 2 a task or a plan. Churn repeatedly plans a small slice, implements it, runs your checks, requests independent reviews, fixes the findings, and commits the reviewed result. It stops when the original goal passes the final audits, a budget expires, or it needs help.

Fresh worker sessions keep each planning, implementation, and review task focused. One builder writes at a time. Reviewers cover correctness, security, recovery, validation, performance, and simplicity; the default runs two reviewers concurrently. You can add more perspectives without running them all at once.

This is an **OpenCode 2 beta plugin**, targeting `@opencode-ai/plugin` and `@opencode-ai/cli` **`0.0.0-beta-19157`**. It does not implement the V1 plugin API. Beta compatibility must be checked when upgrading.

## Install

Requirements: Git, Bun, Node.js 22.18+ for development checks, an OpenCode model connection, and a repository with an initial commit. Node.js 24 is used in CI.

Install the pinned CLI while rejecting npm releases younger than 24 hours:

```sh
bun add --global --trust --minimum-release-age 86400 @opencode-ai/cli@0.0.0-beta-19157
```

That CLI version was published on 2026-09-05 at 16:25 UTC. `--trust` enables the CLI's required native-binary postinstall; the explicit age gate still applies. Check `opencode2 --version` after installation. OpenCode 1's `opencode` command remains separate.

To keep future updates behind the same gate, merge `"update": "disable"` into your **global** `~/.config/opencode/opencode.jsonc` (or the equivalent under `XDG_CONFIG_HOME`). OpenCode's built-in auto-updater does not pass the package-age flag. Project settings alone do not control that updater. Upgrade manually with the age-gated command after testing a newer eligible version.

Clone the plugin release into a stable directory outside the repository you want to work on:

```sh
git clone --branch v0.1.0 --depth 1 https://github.com/brandonbryant12/opencode-churn.git "$HOME/opencode-churn"
cd "$HOME/opencode-churn"
bun install --frozen-lockfile --minimum-release-age 86400
```

The repository also sets `minimumReleaseAge = 86400` in `bunfig.toml`. Keep the lockfile, audit release timestamps when updating it, and retain the explicit age flag for installs outside this directory. A minimum age filters npm dependency resolution; it does not establish the age of a Git tag. Avoid `opencode2 plugin add github:...` when you require the same npm age policy: that installation path does not establish that this gate was applied.

## Start a task

Use a **dedicated clean worktree**, leaving your other checkout and its uncommitted work alone:

```sh
cd /path/to/your-repository
git worktree add --detach ../your-repository-churn HEAD
cd ../your-repository-churn
```

Copy [examples/opencode.jsonc](examples/opencode.jsonc) into this worktree as `opencode.jsonc`. Set `package` to the absolute path of the installed plugin, such as `/home/you/opencode-churn`, and replace the validation command with your project's checks. Add the config to your local Git exclusions if it is not already tracked:

```sh
printf '\nopencode.jsonc\n' >> "$(git rev-parse --git-path info/exclude)"
opencode2
```

Connect your provider with `/connect` and select a model with `/models`. Then run:

```text
/churn Implement pagination for the orders list. Preserve current filters, cover empty and last pages, and keep the public API unchanged.
```

Or use a committed plan file inside the repository:

```text
/churn-file docs/plans/orders-pagination.md
```

Churn creates a `churn/<run-id>` branch in that worktree. Keep that checkout dedicated to the run. It commits locally; review the resulting branch before publishing or merging it.

| Command | Effect |
| --- | --- |
| `/churn <task>` | Start a new task. At least one configured check is required. |
| `/churn-file <path>` | Read a plan from a repository-relative file. |
| `/churn-status` | Show phase, branch, commits, request count, and stop reason. |
| `/churn-stop` | Interrupt workers and checks, preserving commits and partial edits. |
| `/churn-resume` | Continue the unfinished run with fresh activation budgets. |

## What each slice proves

V2's public plugin API creates independent sessions, without a parent-ID creation parameter. Churn uses those sessions as workers and records their IDs, roles, model selections, and reports in the run journal. It does not claim they appear as native parent/child subagent sessions in the UI.

1. A planner selects one bounded slice and observable acceptance criteria.
2. A builder implements it, including appropriate tests.
3. Your configured commands run serially and must pass.
4. Each reviewer examines the same candidate tree and validation evidence. Any actionable finding returns the slice to the builder.
5. Churn verifies that the reviewed files and Git history still match, then commits that exact tree.

After the planner considers the goal satisfied, the panel audits the entire task. The default requires **two consecutive clean final audits**, with validation checks, before completion. Simplicity is always included, even in a custom panel. Reviewers must justify concrete, in-scope findings; the loop does not deliberately invent more work.

## Configure models and budgets

The current session model is the default. `model` sets a run default; `models.planner`, `models.builder`, and `models.reviewer` override roles; an individual reviewer's `model` overrides its role. Model strings use `provider/model` or `provider/model#variant`. Choices are pinned for each activation and checked against the OpenCode catalog. Churn uses your existing provider connections and does not assume a model is free.

See [examples/local-inference.jsonc](examples/local-inference.jsonc) for a local OpenAI-compatible endpoint. Replace its model ID with the exact ID your server exposes. Use `concurrency: 1` when a local server cannot handle two requests efficiently. Tool calling and reliable structured reports are required; a small model that cannot meet the report contract will pause the run.

| Option | Default | Meaning |
| --- | --- | --- |
| `concurrency` | `2` | Concurrent reviewers, from 1 to 8. There is still only one builder. |
| `maxCalls` | `256` | Owned-session model-request hook admissions per activation. Upstream auxiliary work or retries can add provider requests. |
| `steps` | `40` | Maximum agent steps per worker. |
| `maxSlices` | `30` | Committed slices per activation. |
| `maxFixRounds` | `5` | Build/check/review attempts per slice before pausing. |
| `cleanAudits` | `2` | Consecutive clean final panels required. |
| `maxHours` | `8` | Time budget per activation. Cleanup can take additional time. |
| `workerTimeoutMinutes` | `20` | Timeout per worker. |
| `checkTimeoutMinutes` | `20` | Timeout per validation command. |
| `maxDiffBytes` | `300000` | Maximum candidate diff size; larger work pauses for inspection. |
| `keepAwake` | `true` | Keep macOS awake while the run is active. |
| `checks` | `[]` | Required list of `{name, command}` validation checks. |
| `heavyCommand` | automatic | Optional command prefix, for example `["/path/to/gate", "--"]`. |

Checks are argument arrays, for example `["npm", "test", "--", "--run"]`, not shell strings. Use commands that finish; do not configure dev servers or watch modes. Set worker limits in your test runner's supported options. Churn automatically uses `~/.local/bin/codex-heavy --` when available, and otherwise still runs checks serially. Set `heavyCommand` for another shared resource gate.

Custom reviewers accept `name`, `focus`, and optional `model`. Built-in lens names can omit `focus`. Keep reports focused on the user's acceptance criteria rather than aesthetic preferences.

## Stop and recover

Stopping preserves partial files. Resume first confirms the saved branch and commit, settles recorded workers, and continues the slice. It does not reset your checkout. If another process changes HEAD or changes files during review, Churn pauses instead of committing an unreviewed tree.

State and worker/review receipts live in the worktree's Git administrative directory, outside normal commits:

```sh
git rev-parse --git-path churn/state.json
git rev-parse --git-common-dir
```

The lock is `churn.lock` inside the reported common Git directory. One Churn run owns the repository across its worktrees. A lock left after a crash is never stolen automatically. **Restart the OpenCode service first**, inspect the checkout and saved state, and confirm the old workers, validation commands, and Git hooks are stopped. Detached commands can survive a hard service crash. Then remove only that exact stale lock and use `/churn-resume`. Do not delete state or reset files as a recovery shortcut. An uncertain worker shutdown retains the lock deliberately.

On macOS, Churn starts `/usr/bin/caffeinate -is -w <service-pid>` for the run and releases it during cleanup. This prevents idle sleep while supported by macOS; it does not defeat shutdown, a closed laptop lid, power loss, or forced sleep. Other platforms need their own power settings. The OpenCode service and model provider must remain available.

## Execution boundaries

Planner and reviewer workers can read, glob, and grep. Builders can additionally edit project files. OpenCode's confined Code Mode `execute` dispatcher remains available, but every nested tool call is checked against the same role policy. Workers cannot run shells, launch nested agents, use network tools, or create commits. Existing permission decisions are never upgraded from ask/deny to allow. Edits to Git and OpenCode configuration are blocked.

These controls are **not an operating-system security sandbox**. Validation commands and Git hooks execute repository code with your account's authority; generated edits can change that code. Use trusted repositories and an isolated machine/container when you need hostile-code containment. Reviews and tests provide evidence, not proof that every defect is absent. Submodules are currently rejected.

## Development

```sh
bun install --frozen-lockfile --minimum-release-age 86400
npm run check
```

With the pinned CLI installed, run the native integration test:

```sh
OPENCODE2_BIN="$(command -v opencode2)" npm run test:native
```

This launches an isolated OpenCode server and deterministic local HTTP model provider. It verifies native tool use, permission denial, review, and Git commits without paid inference. It does not measure a real model's reasoning quality.

Tests use Node's test runner with two workers. On constrained shared machines, run installs and the check command through your resource gate. See [AGENTS.md](AGENTS.md) for the module map and changes that need special care. Keep local tests, CI, native OpenCode loading, and real provider execution as separate verification claims.

API references: [OpenCode V2 plugins](https://opencode.ai/v2/docs/build/plugins), [permissions](https://opencode.ai/v2/docs/permissions), and [providers](https://opencode.ai/v2/docs/providers).
