# Goal and Swarm architecture

Implemented in v0.3.0. The [README](../README.md) contains installation and workflow guidance.

## One coordinator, two entry points

`/goal` creates and implements an ordered plan before invoking the swarm. `/swarm` catalogs existing work and enters the same review loop. `/swarm --proposal @file` applies that loop to a design document and enforces a single-document edit boundary.

The planner establishes acceptance criteria and initial coverage scope. It replaces a redundant pre-work meta session. Each round ends in a fresh meta assessment; round ten's assessment also synthesizes the final outcome, after final acceptance. There is no permanent supervisor conversation, separate database, Git/worktree framework, or validation runner.

## Bounded adversarial work

Up to 120 concise slices are divided into groups of at most five, with a 12,000-character group target and a 6,000-character per-slice limit. Three independent reviewers inspect every group using different methods. They receive relevant acceptance criteria, a round theme, and the preceding meta-agent's targeted assignments. The original scope and individual receipts are available on disk.

One evaluator accounts for every reported finding and performs justified corrections. A fresh verifier then challenges fixes and rejections. Invalid reports, missing coverage, contradictory blockers, failed checks, and exhausted repair attempts pause the run.

After the final round edits, an independent sweep rechecks all groups and their integration. A repair restarts that entire sweep so later mutations cannot invalidate the final proof for an earlier group.

## Meta assessment is accountable

The meta-agent reads saved receipts, assesses convergence and evidence gaps, and returns:

- A progress summary, next focus, and three distinct review assignments.
- References to existing receipt keys; invented references are rejected.
- Concrete findings, including missing required proof.
- Non-blocking risks and limitations.

Concrete meta findings go through an evaluator, a full independent acceptance sweep, and a fresh meta assessment. Three unsuccessful meta repair cycles pause the run. A narrative cannot override missing coverage or bypass the completion gates.

All ten themes remain fixed: requirements, correctness, integration, recovery, security, concurrency, performance, validation, simplicity, and final acceptance. Meta guidance adds targeted depth. Empty findings are valid; the system does not need an issue quota or gratuitous changes.

## Evidence and UI

The native TUI automatically opens a session-specific panel. It provides separate slice and round milestone bars, active worker sessions, a ten-column coverage strip for each slice, reported usage, finding-decision counts, and the latest meta assessment. Clicking a completed coverage mark loads its individual receipt. Closing the panel leaves the compact banner without repeatedly reopening it.

Progress uses read-only RPC instead of per-worker synthetic messages, which could trigger parent-model inference. The coordinator derives all counters. The display does not invent confidence scores, time estimates, or model consensus.

Private artifacts under `.opencode/goal/` are:

- `state.json`: atomic coordinator checkpoints, the source of truth.
- `objective.md`: the original scope, readable without loading state history.
- `receipts/`: individual reports keyed by run and worker phase.
- `report.md`: human-readable outcomes and links to receipts, updated after round assessments and on pause/completion.
- `findings.json`: stable receipt-level finding IDs, evaluator decisions, verification references, and exact-repeat links.
- `coverage.json`: slice-to-receipt observations.

The derived report and indexes are rebuilt from state. Exact-repeat matching normalizes identical location/problem text; paraphrased duplicates can require evaluator judgment. Counts describe reports and decisions, not a guaranteed count of distinct underlying defects. Historical unsuccessful repair decisions remain visible.

## Compaction and recovery

Workers inherit the launching session's selected model and variant. A native context hook retains the immutable assignment across compaction while explicitly preserving the host's checkpoint format. The plugin does not change GLM reasoning effort, temperature, provider history, or compaction settings.

Successful reports are checkpoints. Interrupted or failed work is not checkpointed as successful. Before resuming, the coordinator interrupts and settles owned workers. A terminal failed verdict is rechecked after a targeted manual correction. Broad outside edits require a fresh run because checkpoint reuse assumes previously reviewed source has not changed.

There is one writer and one run per checkout, with bounded reader concurrency. Tool guards restrict reader roles and proposal writers. Ordinary implementation writers retain shell access to run repository checks; prompt instructions are not OS-level containment.

## Verification limits

Writers run checks; read-only verifiers inspect source and reported evidence. That is independent inspection, not independent execution of the checks. Required evidence gaps block completion; non-required limits remain explicit in the final report. Same-model reviewers can share blind spots.

Tests cover ordering, large-plan batching, coverage omissions, cancellation, recovery, meta findings, invalid evidence references, final verification, and tool boundaries. Native integration uses the pinned OpenCode 2 runtime and a deterministic local provider. TUI tests render wide/narrow panels and verify automatic opening; an actual attached TUI was also checked. These checks establish plumbing, not GLM reasoning quality. Representative real-model defect-recovery and forced-compaction evaluations remain separate work and must not be implied by a passing smoke test.

## Sources and design judgment

[OpenAI subagent guidance](https://developers.openai.com/codex/multi-agent), [OpenCode compaction](https://opencode.ai/v2/docs/compaction), and [Anthropic's long-running agent harness guidance](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) inform bounded sessions, durable evidence, incremental implementation, and explicit verification. The [official GLM-5.3-Flash model card](https://huggingface.co/zai-org/GLM-5.3-Flash) informs preserving provider settings rather than guessing model-specific overrides.

Ten rounds, three review methods, and the meta-agent are deliberate choices for inexpensive local inference. The sources do not establish a universally optimal agent count or prove that more rounds produce better software.
