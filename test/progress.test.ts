import test from "node:test";
import assert from "node:assert/strict";
import { progress, bar, elapsed } from "../src/progress.ts";
import type { State } from "../src/engine.ts";
import type { SessionInfo } from "@opencode-ai/client";

function state(): State {
  return { version: 2, goal: "Add orders pagination", status: "running", phase: "slice/1/implement", reason: "Working", active: [], outputs: { plan: JSON.stringify({ slices: [{ title: "Pagination", task: "Implement", acceptance: ["Next page works"] }] }) } };
}
test("a slice counts only after clean review; a round counts only after evaluation", () => {
  const s = state(); s.outputs["slice/1/implement"] = '{"summary":"implemented","decisions":[]}' ;
  s.outputs["slice/1/review/0"] = '{"findings":[{"location":"a:1","problem":"Missing next page"}]}';
  s.outputs["round/1/review/1"] = '{"findings":[]}';
  assert.equal(progress(s, [], true)?.slices[0].done, false);
  assert.equal(progress(s, [], true)?.rounds[0].done, false);
  s.outputs["slice/1/review/1"] = '{"findings":[]}'; s.outputs["round/1/meta"] = '{"decisions":[]}' ;
  assert.equal(progress(s, [], true)?.slices[0].done, true);
  assert.equal(progress(s, [], true)?.rounds[0].done, true);
});
test("live cumulative usage replaces a session snapshot instead of double counting", () => {
  const s = state();
  s.telemetry = { parentID: "parent", startedAt: 1, updatedAt: 2, workers: { a: { role: "implementer", phase: s.phase, startedAt: 1, input: 10, output: 5, cost: 0.1 } } };
  const live = { id: "a", tokens: { input: 20, output: 10 }, cost: 0.2 } as SessionInfo;
  assert.equal(progress(s, [live], true)?.cost, 0.2);
  assert.equal(progress(s, [live], true)?.input, 20);
  assert.equal(s.telemetry.workers.a.input, 10);
});
test("legacy state has unknown usage and a stopped service never appears running", () => {
  const p = progress(state())!;
  assert.equal(p.status, "paused"); assert.equal(p.usageAvailable, false);
  assert.equal(p.startedAt, null); assert.match(p.message, /goal-resume/);
});
test("progress bars are bounded milestones and elapsed time never goes negative", () => {
  assert.equal(bar(1, 2, 4), "██░░"); assert.equal(bar(0, 0, 4), "░░░░");
  assert.equal(bar(9, 2, 4), "████"); assert.equal(elapsed(2000, 1000), "0s");
  assert.equal(elapsed(null, 1000), "—");
});
test("every intermediate progress field is JSON-safe before the first meta report", () => {
  const s = state();
  s.telemetry = { parentID: "parent", startedAt: 1, updatedAt: 2, workers: {} };
  s.outputs = {}; s.phase = "plan";
  const p = progress(s, [], true)!;
  // JSON.stringify alone silently drops undefined; the native RPC rejects it.
  function check(value: unknown): void {
    assert.notEqual(value, undefined);
    if (Array.isArray(value)) value.forEach(check);
    else if (value && typeof value === "object") Object.values(value).forEach(check);
  }
  check(p); assert.equal(p.meta, null); assert.equal(p.usageAvailable, false);
  assert.equal(progress(s, [], true, true)?.status, "stopping");
  assert.equal(progress(s, [], false, true)?.status, "paused");
});
