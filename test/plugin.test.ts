import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { option, planFile, readState } from "../src/index.ts";
import { stopWorkers } from "../src/workers.ts";
import type { Plugin } from "@opencode-ai/plugin";
import type { State } from "../src/engine.ts";

test("plan paths reject traversal and symlink escapes; missing/corrupt state is explicit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "goal-test-"));
  const outside = `${dir}-outside.md`;
  try {
    await writeFile(join(dir, "plan.md"), "Small plan"); await writeFile(outside, "Outside");
    await symlink(outside, join(dir, "escape.md"));
    assert.equal(await planFile(dir, "plan.md"), "Small plan");
    await assert.rejects(planFile(dir, outside), /inside/);
    await assert.rejects(planFile(dir, "escape.md"), /inside/);
    assert.equal(await readState(join(dir, "state.json")), undefined);
    await writeFile(join(dir, "state.json"), '{"version":1}');
    await assert.rejects(readState(join(dir, "state.json")), /Invalid goal state/);
  } finally { await rm(dir, { recursive: true, force: true }); await rm(outside, { force: true }); }
});
test("cleanup retains unresolved workers so resume cannot start another writer", async () => {
  const state = { active: ["stopped", "uncertain"] } as State;
  const ctx = { session: { interrupt: async () => {}, wait: async ({ sessionID }: { sessionID: string }) => { if (sessionID === "uncertain") throw new Error("Offline"); } } } as unknown as Plugin.Context;
  await assert.rejects(stopWorkers(ctx, state, async () => {}), /confirm/);
  assert.deepEqual(state.active, ["uncertain"]);
});
test("concurrency options reject unbounded or invalid values", () => {
  assert.equal(option(undefined, 1, 3), 1);
  for (const n of [0, 4, 1.5, "2", NaN]) assert.throws(() => option(n, 1, 3));
});
