# v0.3.0 implementation review

The review focused on completion correctness, isolation, large-plan context, recovery, and native UI integration.

Fixed during review:

- A later batch could invalidate an earlier verdict. Final acceptance now sweeps every batch after the last mutation and restarts the full sweep after repairs.
- A meta summary could bury a concrete defect in limitations. Meta reports now cite existing receipts; actionable findings trigger repair, full verification, and a fresh assessment before completion.
- A terminal failed verdict could make resume reuse the same failure forever. Terminal failures are rechecked after correction.
- Missing coverage and contradictory blockers could pass as a clean review. Every assigned slice now requires explicit coverage, and reported blockers fail closed.
- Local-directory TUI loading ignored package subpath exports in the pinned beta. A root TUI entry is included and was verified in an attached OpenCode 2 session.
- Per-worker synthetic updates triggered parent-model activity. Phase progress now travels over RPC.
- Large runs required reading a growing state blob. Original scope and worker receipts are independently readable, and progress reuses parsed receipt data.
- An unrelated batch's final verdict could be associated with a repair in the report index. Evidence links now require the matching batch.
- A coverage request could cross into a newly started run. Receipt RPC requests are scoped to the run timestamp and own checkpoint keys.

Validation uses focused engine/report tests, wide and narrow OpenTUI rendering and coverage interaction tests, and the installed OpenCode 2 beta-19157 runtime with deterministic Goal, Swarm, and proposal flows. Native tests exercise tool denials, allowed edits, checkpoints, derived reports, progress and receipt RPC, and absence of automatic commits.

Remaining limits: real GLM reasoning quality and forced native compaction were not benchmarked; independent verifiers inspect evidence rather than execute shell checks; resume assumes previously reviewed source was not broadly edited outside the workflow. These limits are documented in the README and architecture guide.
