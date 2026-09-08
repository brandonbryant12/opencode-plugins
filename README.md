# Goal for OpenCode 2

A small `/goal` plugin. Give it a goal or a plan file; it implements the plan one slice at a time, reviews each slice, fixes findings, then runs **ten focused review rounds**.

This is the simpler successor to Churn, in the same repository. It uses OpenCode's native TypeScript plugin API. There is no Go service, automatic commit workflow, or separate orchestration framework.

## Install OpenCode 2 and the plugin

You need Git and [Bun](https://bun.sh/docs/installation), plus a model provider connected in OpenCode. Development tests additionally require Node.js 22.18+ (CI uses Node 24).

**1. Install the exact OpenCode 2 beta tested by this plugin:**

```sh
bun add --global --trust --minimum-release-age 86400 @opencode-ai/cli@0.0.0-beta-19157
export PATH="$HOME/.bun/bin:$PATH"
opencode2 --version
```

The command is `opencode2`, separate from OpenCode 1's `opencode`. The native binary installation needs `--trust`; the npm age gate rejects releases younger than 24 hours. Merge `"update": "disable"` into global `~/.config/opencode/opencode.jsonc` to keep automatic updates from changing the tested version. If you use `XDG_CONFIG_HOME`, use that directory instead of `~/.config`.

**2. Install this plugin release outside your project:**

```sh
git clone --branch v0.2.0 --depth 1 https://github.com/brandonbryant12/opencode-churn.git "$HOME/opencode-goal"
cd "$HOME/opencode-goal"
bun install --frozen-lockfile --minimum-release-age 86400
```

**3. In the project you want to work on**, add this to `opencode.jsonc` (merge the `plugins` entry if the file already exists):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/absolute/path/to/opencode-goal"]
}
```

Replace the path with the actual clone location; `~` and `$HOME` are not expanded inside JSON. Add `.opencode/goal/` to your project's `.gitignore` or local Git exclusions so private goals and worker reports stay out of commits. Start OpenCode in that project:

```sh
opencode2
```

Use `/connect` to connect a provider, and `/models` to select a model. Then:

```text
/goal Add pagination to orders. Preserve filters and cover empty and last pages.
```

Or pass a project-relative plan file (spaces in paths are supported without quotes):

```text
/goal @docs/plans/orders.md
```

OpenCode commands use a **forward slash**: `/goal`, not `\goal`.

## The loop

1. One fresh planner reads the goal and relevant code and saves an ordered plan with acceptance criteria.
2. For each slice, one fresh implementer edits and validates it, then one fresh reviewer examines it. Findings go to a fresh evaluator to fix or reject with evidence, followed by another review. Three unsuccessful fixes pause the run.
3. After all slices, run ten rounds. **Each round has three independent reviewers, each walking through every slice, followed by a fourth agent that evaluates all findings and implements justified improvements.**
4. Completion requires every slice review and all ten evaluations to finish successfully with reported passing checks and no blockers.

The ten rounds focus on requirements, correctness, integration, recovery, security, concurrency, performance, tests, simplicity, and final acceptance. Reviewers may find nothing. The evaluator still checks the goal, but does not invent changes to fill a quota.

Fresh sessions receive the original goal, the relevant slice or complete plan, and only the reports needed for that task. Earlier conversations are not copied into every agent. The full model conversations remain in OpenCode; compact successful outputs are saved as checkpoints.

OpenCode's tested V2 API creates independent worker sessions. These act as sub-agents for the coordinator, but the API does not provide a parent-ID creation parameter, so they are not promised to appear as a native child-session tree. Workers use the launching session's selected model; changing it affects subsequent workers.

## Controls

| Command | Action |
| --- | --- |
| `/goal <text>` | Start a goal. |
| `/goal @path/to/plan.md` | Start from a file inside this project. |
| `/goal-status` | Show current phase and saved progress. |
| `/goal-stop` | Interrupt workers and preserve partial work. Wait for paused status. |
| `/goal-resume` | Settle old workers, reuse completed checkpoints, and retry unfinished work. |

The progress file is `.opencode/goal/state.json`. Successful tasks are not repeated on resume. An interrupted writer may have left edits; its replacement is told to inspect those first. Invalid reports, timeouts, denied permissions, failed checks, or unresolved findings pause the run. Address the stated blocker before resuming. Do not blindly resume an uncertain external action.

Use one OpenCode service and one active goal per checkout. Let the goal own editing while it runs. Resume assumes completed slices have not been changed outside the workflow. To abandon a goal or restart after manual changes, stop it and confirm all workers have stopped, then move `.opencode/goal/` aside before starting again. The plugin never resets your source files or Git history. Old Churn v0.1 state is separate and is not migrated.

## Only three options

Defaults keep memory and context use bounded:

```jsonc
{
  "plugins": [{
    "package": "/absolute/path/to/opencode-goal",
    "options": {
      "reviewConcurrency": 1,
      "steps": 40,
      "workerTimeoutMinutes": 20
    }
  }]
}
```

- `reviewConcurrency`: 1–3 active reviewers, default **1**. You still get three independent reviews per round. There is always just one writer.
- `steps`: 1–100 model steps per worker, default **40**.
- `workerTimeoutMinutes`: 1–120 minutes per worker, default **20**.

There are at most 30 planned slices and three fixes per slice. Ten final rounds always run; this is deliberately thorough and can consume significant inference. These limits are not a token or billing cap. Model permissions remain under your OpenCode configuration; the plugin does not auto-approve prompts. Planner/reviewer agents deny editing and shell access. Writers can use normal tools to implement and run checks. Instructions prohibit commits, publishing, nested agents, and configuration changes; this is not OS-level containment.

Tests and checks are run by the writing agent following your repository instructions, rather than by a second configurable command runner. The coordinator validates the report format and rejects reported failures; it does not independently prove the model's validation claims. Real-model quality depends on the selected model. The service must remain running; the plugin does not manage machine sleep.

## Upgrading from Churn

Stop any v0.1 run first. Update the clone to `v0.2.0`, reinstall from the lockfile, replace all old Churn options with the configuration above, and restart OpenCode. Use `/goal` instead of `/churn`. The old `v0.1.0` release remains available.

## Development

```sh
bun install --frozen-lockfile --minimum-release-age 86400
npm run check
OPENCODE2_BIN="$(command -v opencode2)" npm run test:native
```

`src/engine.ts` contains the loop and report contracts, `src/workers.ts` handles OpenCode sessions, and `src/index.ts` registers commands and saves progress. Tests cover ordering, convergence, cancellation, resume, concurrency, failed reports, file boundaries, and worker cleanup. The native smoke test runs all ten rounds against a local deterministic model provider, checks denied reviewer writes, and confirms no commits are created. It makes no paid model calls and does not measure real-model reasoning quality.

On a constrained shared machine, run installs and checks through your shared resource gate, such as `~/.local/bin/codex-heavy -- npm run check`. The test runner uses at most two workers.

Compatibility is pinned to `@opencode-ai/plugin` and `@opencode-ai/cli` **`0.0.0-beta-19157`**. Current upstream docs can describe newer beta package names or APIs; upgrade only after running the native smoke test.

References: [OpenCode V2 plugins](https://opencode.ai/v2/docs/build/plugins/), [plugin installation](https://opencode.ai/v2/docs/plugins), [permissions](https://opencode.ai/v2/docs/permissions).
