# OpenCode Plugins

Two native OpenCode 2 workflows: **Goal** implements a plan slice by slice; **Swarm** challenges and improves existing work. Both finish with ten adversarial review rounds, independent verification, and a meta-agent assessment. Progress opens automatically in the TUI.

## When to use what

| Situation | Command | Outcome |
| --- | --- | --- |
| A large feature plan you want implemented | `/goal @docs/feature-plan.md` | Ordered implementation, slice reviews, then a full swarm |
| Work you have already implemented | `/swarm Check the orders feature against @docs/requirements.md` | Review and justified corrections without an implementation loop |
| A design you want challenged before coding | `/swarm --proposal @docs/design.md` | Design findings and document improvements; software is not implemented |

With no argument, `/swarm` reuses the last saved objective (preserving proposal mode when applicable). Without a saved objective it asks for a scope.

For an existing implementation with a long specification, use `/swarm @docs/requirements.md`. File paths are project-relative; spaces need no quotes. An inline `@path` within a sentence is plain task text that workers can read, while a leading `@path` loads the file as the objective.

## Install

Requires Git, Bun, and a provider configured in OpenCode. Compatibility is pinned to **OpenCode 2 beta-19157**; current upstream beta APIs may differ.

```sh
bun add --global --trust --minimum-release-age 86400 @opencode-ai/cli@0.0.0-beta-19157
export PATH="$HOME/.bun/bin:$PATH"
opencode2 --version
git clone --branch v0.3.0 --depth 1 https://github.com/brandonbryant12/opencode-plugins.git "$HOME/opencode-plugins"
cd "$HOME/opencode-plugins"
bun install --frozen-lockfile --minimum-release-age 86400
```

Add the clone's absolute path to your project's `opencode.jsonc`, merging existing configuration:

```jsonc
{
  "plugins": ["/absolute/path/to/opencode-plugins"]
}
```

Paths inside JSON do not expand `~` or `$HOME`. Add `.opencode/goal/` to your project's Git exclusions: it contains private objectives and reports. Start `opencode2` in the project, connect with `/connect`, select your model with `/models`, then run a command above. The root `tui.tsx` entry enables local-directory TUI discovery in this beta. Keep this clone accessible to the local CLI when using a remote server.

To retain the tested OpenCode version, merge `"update": "disable"` into global `~/.config/opencode/opencode.jsonc` (or the corresponding `XDG_CONFIG_HOME` directory).

## How it works

Goal starts with a planner and up to 120 ordered slices. Each slice gets one implementer, a fresh reviewer, and up to three repairs with fresh reviews. After all slices pass, it enters Swarm. Swarm alone catalogs the existing scope and starts reviewing immediately.

Every one of ten rounds covers every slice in bounded batches of at most five, reduced further for long slice descriptions:

1. Three fresh reviewers use different methods: trace contracts, challenge assumptions with counterexamples, and search for omissions or simpler solutions. Each reports explicit coverage and evidence for every assigned slice.
2. One evaluator considers all findings, accounts for duplicates, fixes justified defects, and rejects unsupported suggestions with reasons. There is only one writer.
3. A fresh read-only verifier challenges both fixes and rejections against current files. Unresolved findings get at most three repair attempts before pausing.
4. A fresh read-only meta-agent assesses the round's saved receipts, convergence, weak evidence, and remaining risks. It cites existing receipts, assigns the next three investigations, and updates the report. New concrete findings trigger repair and a full verification sweep before a fresh assessment. It cannot change counters, skip rounds, or grant completion.

After the last round edits, a final independent sweep checks every batch again. Any repair restarts that entire sweep, so a later edit cannot leave an earlier verdict as the final proof. Three unsuccessful repair sweeps pause the run. The final meta assessment follows this gate.

Round themes cover requirements, correctness, integration, recovery, security, concurrency, performance, validation, simplicity, and final acceptance. Meta guidance supplements the next theme. Empty findings are valid: there is no issue quota or forced code churn. Ten rounds always run.

Proposal mode follows the same loop against design sections and decision criteria. Writers can use only `edit` and `write` against the existing source proposal; shell, patch, and other editing tools are denied. Reviews must distinguish design reasoning from implemented or tested behavior.

## Live progress and reports

The native panel opens once when an active run appears in its launching session. It shows slice and round milestones, per-slice verified rounds, active agents, elapsed time, tokens, reported cost, repair decisions, and the latest meta assessment. Click an active agent to inspect its session. Click a completed coverage mark to inspect its receipt. Press `f` for fullscreen or `esc` to close; a dismissed panel stays closed. `/goal-panel` reopens it.

These are completed-work counters, not estimates of time remaining or a quality score. Fix/rejection counts are finding decisions and can include duplicate findings. Cost is OpenCode-reported and may not reflect actual provider billing.

`.opencode/goal/state.json` stores successful checkpoints. `objective.md` holds the original scope, and `receipts/` contains individually readable reports so agents do not need to load a growing state file. `.opencode/goal/report.md` includes review coverage, findings, evaluator decisions, validation evidence, independent verdicts, and meta outcomes. `findings.json` and `coverage.json` provide derived indexes with stable receipt IDs and exact-repeat links. Full conversations remain in OpenCode's worker sessions.

## Controls and recovery

| Command | Action |
| --- | --- |
| `/goal-status` | Show saved status and checkpoint path |
| `/goal-stop` | Interrupt workers; wait for paused status before editing |
| `/goal-resume` | Settle old workers, reuse completed receipts, retry unfinished work |
| `/goal-panel` | Open native progress panel |

The controls work for both Goal and Swarm. There is one active run per checkout. Use one OpenCode service per checkout and let the workflow own editing. Invalid reports, denied tools, failed checks, timeouts, missing coverage, and persistent findings pause the run. No failed or canceled result becomes a successful checkpoint.

Resume assumes previously completed work has not changed. After broad manual edits, stop and settle all workers, move `.opencode/goal/` aside, and start a fresh swarm so stale receipts cannot stand in for new reviews. A terminal failed verifier is re-run after a targeted manual correction. The plugin never resets source files or commits user work. Existing v0.2 goals can resume, but their final review stage runs with the stronger new verification gates.

## Models, compaction and limits

Workers inherit the launching session's selected model and variant. Changing that selection affects later workers. GLM-5.3-Flash and local inference need no plugin-specific provider settings; use your working OpenCode provider configuration. The plugin does not override reasoning effort, temperature, or compaction settings.

Each worker starts fresh with a bounded assignment and relevant receipts. A context hook retains its assignment across native compaction while preserving the host's checkpoint format. Workers can read the saved objective when needed. Native autocompaction remains responsible for managing that worker's ongoing context.

Only three options are supported:

```jsonc
{
  "plugins": [{
    "package": "/absolute/path/to/opencode-plugins",
    "options": { "reviewConcurrency": 1, "steps": 40, "workerTimeoutMinutes": 20 }
  }]
}
```

`reviewConcurrency` accepts 1–3; `steps` accepts 1–100; timeout accepts 1–120 minutes. Default concurrency is one for constrained machines; all three independent reviews still run. Plans are limited to 64 KB of source and 120 concise slices; larger programs should use separate feature plans. Reports are bounded and malformed/oversized output pauses for correction. These limits are not billing caps.

Writers perform checks under repository instructions; the coordinator validates their structured evidence. Read-only reviewers and verifiers inspect files and recorded evidence and cannot run shell checks themselves. Completion means all required review gates passed; it does not independently prove every model claim or guarantee defect-free software. Same-model reviewers can share blind spots. Meta reports preserve validation limits, including unavailable integration environments and device checks.

Workers are prohibited from spawning agents, committing, pushing, deploying, or changing OpenCode state/configuration. Tool guards deny unsupported tools and enforce read-only roles. Ordinary code writers still have shell access for implementation checks; instructions are not OS containment. The service must remain running.

## Development

```sh
bun install --frozen-lockfile --minimum-release-age 86400
npm run check
npm run test:tui
OPENCODE2_BIN="$(command -v opencode2)" npm run test:native
GOAL_SMOKE_MODE=swarm OPENCODE2_BIN="$(command -v opencode2)" npm run test:native
GOAL_SMOKE_MODE=proposal OPENCODE2_BIN="$(command -v opencode2)" npm run test:native
```

On shared constrained machines, run installs and checks through `~/.local/bin/codex-heavy --`. Tests use at most two workers. Native smoke tests use a local deterministic provider: they exercise real OpenCode loading, tools, permissions, sessions, reports and RPC, without paid inference. They do not benchmark GLM reasoning or simulate every compaction scenario.

This repository succeeds `opencode-churn`; old release tags remain available. Stop old runs, update the clone, reinstall pinned dependencies, remove old Churn options, and restart OpenCode.

References: [OpenCode plugins](https://opencode.ai/v2/docs/build/plugins/), [compaction](https://opencode.ai/v2/docs/compaction), [OpenAI subagent guidance](https://developers.openai.com/codex/multi-agent), [long-running agent harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents).
