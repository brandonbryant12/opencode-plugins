# Goal / Swarm UX verification — 2026-09-10

Verified against OpenCode 2 `0.0.0-beta-19157` on macOS. The reported invisible run was reproduced in an actual TUI with the free `opencode/big-pickle` model before fixing it.

## Findings and corrections

| Finding | Correction and regression coverage |
| --- | --- |
| Progress returned `undefined` metadata before the first meta report. Native RPC rejected it, leaving active work invisible. | JSON-safe progress from planning onward. Native tests request progress throughout execution, including before any worker finishes. |
| The UI hid a failed first progress request. | Visible connection warnings without requiring an earlier successful snapshot; paused runs show their reason and recovery controls. |
| Status notices could prompt the parent assistant to perform extra work. | Passive native notices with `resume: false`; tests assert no parent assistant messages. |
| Start returned before validation and persistence, and another Start produced an error. | Validate and save before acknowledging. Repeated starts open the existing run. |
| Stop could wait for a model response; Resume could race the final stop notice. | Interrupt native sessions immediately, settle workers before pausing, and await the finishing task before resuming. A native test deliberately leaves a provider request unanswered. |
| Manual progress was not discoverable through native command completion. | Register `/goal-panel` as a native command. Saved runs remain discoverable after restart and from other chats in the project. |
| Narrow panels crowded out controls and counters. | Fixed controls above scrolling detail, shorter milestone bars, current activity first, and focus-scoped fullscreen/close keys. |
| A real model wrapped valid JSON in prose, while a meta agent attempted early completion. | Accept one fenced JSON report and save canonical JSON receipts. Preserve strict validation, require all ten rounds, and supply the failure reason on retry. Reviewers receive paths to implementation check receipts. |

## Automated verification

The unit suite covers orchestration, bounded concurrency, large plans, proposal restrictions, coverage, final verification, report validation, persistence, and progress. OpenTUI checks exercise initial connection failure, automatic active/paused opening, repeat-start recovery, home discovery, Stop/Resume clicks, evidence clicks, remote locations, and narrow/wide layouts.

The native suite runs Goal, Swarm, and Proposal to completion through all ten rounds using a deterministic local provider. Each run checks stalled-provider interruption, one-action resume, stale controls, duplicate starts, native command discovery, live RPC, canonical receipts, and no parent inference. Reviewers attempt forbidden writes; Proposal writers also attempt an edit outside the source document.

Run the commands in the README to repeat these checks. The deterministic provider tests the real OpenCode runtime; it is not a model-quality benchmark.

## Real-model and TUI verification

The disposable real-model task changed `answer.txt` from `before` to exactly `after` followed by a newline. The model catalog reported zero input, output, and cache prices for `opencode/big-pickle`.

The actual TUI was exercised from its home screen: automatic progress opening, visible worker activity, clicking Stop and Resume, closing with Escape, repeating Start, native `/goal-panel` completion, saved-run discovery after restart, and visible report failures. Computer Use denied access to Terminal, so these checks used the actual CLI through a PTY and recorded its terminal output.

The real model completed two implementation slices and one full swarm round: three adversarial reviewers, evaluator, independent verifier, and meta assessment. The meta assessment cited five receipts and supplied three next-round assignments. The test then deliberately stopped the run. Verification confirmed the exact file bytes, zero active workers, zero parent assistant messages, and $0 reported cost.

This was a bounded real-model smoke test. All ten rounds in all three modes were exercised with the deterministic provider. Large real feature plans, GLM reasoning quality, and every native compaction scenario were not benchmarked in this run.
