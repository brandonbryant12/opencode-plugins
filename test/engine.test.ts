import test from "node:test";
import assert from "node:assert/strict";
import { run, plan, review, work, type State, type Role } from "../src/engine.ts";

const validPlan = JSON.stringify({ slices: [{ title: "First", task: "Do first", acceptance: ["First works"] }, { title: "Second", task: "Do second", acceptance: ["Second works"] }] });
const pass = JSON.stringify({ summary: "Checked", checks: [{ command: "npm test", result: "pass", evidence: "Tests passed" }], blocked: [], decisions: [] });
const clean = '{"findings":[]}';
const defect = '{"findings":[{"location":"a.ts:3","problem":"Off by one; fix the bound"}]}';
function harness(concurrency = 1) {
  const state: State = { version: 2, goal: "A small goal", status: "running", phase: "", reason: "", outputs: {}, active: [] };
  const calls: { role: Role; prompt: string; phase: string }[] = [];
  const controller = new AbortController();
  let respond = async (role: Role, _prompt: string) => role === "planner" ? validPlan : role === "reviewer" ? clean : pass;
  const r = { state, concurrency, signal: controller.signal, save: async () => {}, report: async () => {}, worker: async (role: Role, prompt: string) => { calls.push({ role, prompt, phase: state.phase }); return respond(role, prompt); } };
  return { r, state, calls, controller, response: (fn: typeof respond) => { respond = fn; } };
}
test("two slices each get an implementer and reviewer, then exactly ten three-plus-one rounds", async () => {
  const h = harness(); await run(h.r);
  assert.equal(h.state.status, "complete");
  assert.deepEqual(h.calls.slice(0, 5).map(c => c.role), ["planner", "implementer", "reviewer", "implementer", "reviewer"]);
  assert.equal(h.calls.length, 45);
  for (let i = 5; i < h.calls.length; i += 4) assert.deepEqual(h.calls.slice(i, i + 4).map(c => c.role), ["reviewer", "reviewer", "reviewer", "evaluator"]);
  assert.ok(h.calls.slice(5).every(c => c.prompt.includes('"First"') && c.prompt.includes('"Second"')));
});
test("slice findings trigger a fix and fresh review before the next implementation", async () => {
  const h = harness(); let reviewed = false;
  h.response(async role => {
    if (role === "planner") return validPlan;
    if (role === "reviewer" && !reviewed) { reviewed = true; return defect; }
    if (role === "reviewer") return clean;
    if (h.state.phase.includes("/fix/")) return JSON.stringify({ ...JSON.parse(pass), decisions: [{ id: "0", action: "fixed", reason: "Boundary corrected" }] });
    return pass;
  });
  await run(h.r);
  assert.deepEqual(h.calls.slice(0, 6).map(c => c.role), ["planner", "implementer", "reviewer", "evaluator", "reviewer", "implementer"]);
});
test("persistent slice findings pause after three fixes", async () => {
  const h = harness(); h.response(async role => role === "planner" ? validPlan : role === "reviewer" ? defect : JSON.stringify({ ...JSON.parse(pass), decisions: [{ id: "0", action: "fixed", reason: "Attempted" }] }));
  await assert.rejects(run(h.r), /three fixes/);
  assert.equal(h.calls.filter(c => c.role === "evaluator").length, 3);
  assert.ok(!h.calls.some(c => c.phase.startsWith("round/")));
});
test("review panel respects concurrency and settles readers before evaluator", async () => {
  const h = harness(2); let active = 0; let peak = 0;
  h.response(async role => {
    if (role === "planner") return validPlan;
    if (role === "reviewer") {
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 2)); active--; return clean;
    }
    assert.equal(active, 0); return pass;
  });
  await run(h.r); assert.equal(peak, 2);
});
test("a failed reader settles its sibling and never admits the evaluator", async () => {
  const h = harness(2); let settled = false; let n = 0;
  h.response(async role => {
    if (role === "planner") return validPlan;
    if (role === "reviewer" && h.state.phase.startsWith("round/")) {
      if (++n === 1) throw new Error("Reader failed");
      await new Promise(resolve => setTimeout(resolve, 5)); settled = true;
    }
    return role === "reviewer" ? clean : pass;
  });
  await assert.rejects(run(h.r), /Reader failed/);
  assert.equal(settled, true); assert.equal(h.calls.filter(c => c.role === "evaluator").length, 0);
});
test("resume reuses completed tasks and retries only the interrupted worker", async () => {
  const h = harness(); let fail = true;
  h.response(async role => { if (h.state.phase === "round/4/evaluate" && fail) throw new Error("Interrupted"); return role === "planner" ? validPlan : role === "reviewer" ? clean : pass; });
  await assert.rejects(run(h.r), /Interrupted/); const count = h.calls.length;
  fail = false; await run(h.r);
  assert.equal(h.calls[count].phase, "round/4/evaluate");
  assert.equal(h.calls.filter(c => c.role === "implementer").length, 2);
  assert.equal(h.state.status, "complete");
});
test("cancellation cannot checkpoint a worker result or complete the run", async () => {
  const h = harness(); h.response(async () => { h.controller.abort(); return validPlan; });
  await assert.rejects(run(h.r)); assert.deepEqual(h.state.outputs, {}); assert.notEqual(h.state.status, "complete");
});
test("malformed plans, contradictory validation, and unaccounted findings fail closed", () => {
  assert.throws(() => plan('{"slices":[]}'));
  assert.throws(() => review('{"findings":[{}]}'));
  assert.throws(() => work(pass.replace('"pass"', '"fail"')));
  assert.throws(() => work(pass.replace('"blocked":[]', '"blocked":["Missing credentials"]')));
  assert.throws(() => work(pass, [{ id: "1", location: "a", problem: "broken" }]));
});
test("round evaluator must account for all three reviewers even when defects duplicate", async () => {
  const h = harness(); h.response(async role => role === "planner" ? validPlan : role === "reviewer" ? (h.state.phase.startsWith("round/") ? defect : clean) : pass);
  await assert.rejects(run(h.r), /every finding/);
  assert.equal(h.state.outputs["round/1/evaluate"], undefined);
  assert.notEqual(h.state.status, "complete");
});
