import test from "node:test";
import assert from "node:assert/strict";
import { run, json, plan, review, work, type State, type Role } from "../src/engine.ts";

test("one fenced JSON report can include model prose, while ambiguous reports fail", () => {
  assert.deepEqual(json('Evidence reviewed.\n```json\n{"findings":[]}\n```\nEnd of report.'), { findings: [] });
  assert.throws(() => json('```json\n{"findings":[]}\n```\n```json\n{"blocked":["missing proof"]}\n```'), /one JSON report/);
  assert.throws(() => review('```json\n{"findings":[],"blocked":["missing proof"]}\n```'), /blocked/);
});

const validPlan = JSON.stringify({ slices: [{ title: "First", task: "Do first", acceptance: ["First works"] }, { title: "Second", task: "Do second", acceptance: ["Second works"] }] });
const pass = JSON.stringify({ summary: "Checked", checks: [{ command: "npm test", result: "pass", evidence: "Tests passed" }], blocked: [], decisions: [] });
const clean = JSON.stringify({findings:[], coverage:[1,2].map(slice => ({slice,status:"checked",evidence:"Inspected source"}))});
const metaReport = JSON.stringify({ findings: [], summary: "Verified", nextFocus: "Check integration", assignments: ["Trace contracts", "Seek counterexamples", "Inspect evidence"], risks: [], limitations: ["Deterministic test"] });
const defect = JSON.stringify({...JSON.parse(clean), findings:[{location:"a.ts:3",problem:"Off by one; fix the bound"}]});
function harness(concurrency = 1) {
  const state: State = { version: 2, goal: "A small goal", status: "running", phase: "", reason: "", outputs: {}, active: [] };
  const calls: { role: Role; prompt: string; phase: string }[] = [];
  const controller = new AbortController();
  let respond = async (role: Role, _prompt: string) => role === "planner" ? validPlan : role === "meta" ? metaReport : role === "reviewer" || role === "verifier" ? clean : pass;
  const r = { state, concurrency, signal: controller.signal, save: async () => {}, report: async () => {}, worker: async (role: Role, prompt: string) => { calls.push({ role, prompt, phase: state.phase }); const raw = await respond(role, prompt); if (role !== "meta") return raw;
    const result = JSON.parse(raw); result.evidenceRefs ??= [JSON.parse(prompt.match(/Available receipt keys: (\[[^\n]*\])/ )![1])[0]]; return JSON.stringify(result); } };
  return { r, state, calls, controller, response: (fn: typeof respond) => { respond = fn; } };
}
test("two slices each get an implementer and reviewer, then exactly ten three-plus-one rounds", async () => {
  const h = harness(); await run(h.r);
  assert.equal(h.state.status, "complete");
  assert.deepEqual(h.calls.slice(0, 5).map(c => c.role), ["planner", "implementer", "reviewer", "implementer", "reviewer"]);
  assert.equal(h.calls.length, 66);
  for (let i = 5; i < 59; i += 6) assert.deepEqual(h.calls.slice(i, i + 6).filter(c => !c.phase.startsWith("final/")).map(c => c.role), ["reviewer", "reviewer", "reviewer", "evaluator", "verifier", "meta"]);
  assert.ok(h.calls.slice(5).filter(c => c.role !== "meta").every(c => c.prompt.includes('"First"') && c.prompt.includes('"Second"')));
});
test("slice findings trigger a fix and fresh review before the next implementation", async () => {
  const h = harness(); let reviewed = false;
  h.response(async role => {
    if (role === "planner") return validPlan;
    if (role === "reviewer" && !reviewed) { reviewed = true; return defect; }
    if (role === "meta") return metaReport;
    if (role === "reviewer" || role === "verifier") return clean;
    if (h.state.phase.includes("/fix/")) return JSON.stringify({ ...JSON.parse(pass), decisions: [{ id: "0", action: "fixed", reason: "Boundary corrected" }] });
    return pass;
  });
  await run(h.r);
  assert.deepEqual(h.calls.slice(0, 6).map(c => c.role), ["planner", "implementer", "reviewer", "evaluator", "reviewer", "implementer"]);
});
test("persistent slice findings pause after three fixes", async () => {
  const h = harness(); h.response(async role => role === "planner" ? validPlan : role === "reviewer" ? defect : role === "implementer" ? pass : JSON.stringify({ ...JSON.parse(pass), decisions: [{ id: "0", action: "fixed", reason: "Attempted" }] }));
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
    assert.equal(active, 0); return role === "meta" ? metaReport : role === "verifier" ? clean : pass;
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
    return role === "meta" ? metaReport : role === "reviewer" || role === "verifier" ? clean : pass;
  });
  await assert.rejects(run(h.r), /Reader failed/);
  assert.equal(settled, true); assert.equal(h.calls.filter(c => c.role === "evaluator").length, 0);
});
test("resume reuses completed tasks and retries only the interrupted worker", async () => {
  const h = harness(); let fail = true;
  h.response(async role => { if (h.state.phase === "round/4/batch/1/evaluate" && fail) throw new Error("Interrupted"); return role === "planner" ? validPlan : role === "meta" ? metaReport : role === "reviewer" || role === "verifier" ? clean : pass; });
  await assert.rejects(run(h.r), /Interrupted/); const count = h.calls.length;
  fail = false; await run(h.r);
  assert.equal(h.calls[count].phase, "round/4/batch/1/evaluate");
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
  assert.equal(h.state.outputs["round/1/batch/1/evaluate"], undefined);
  assert.notEqual(h.state.status, "complete");
});

test("swarm skips implementation and requires coverage, verification and meta for all ten rounds", async () => {
  const h = harness(); h.state.mode = "swarm"; await run(h.r);
  assert.equal(h.calls.filter(c => c.role === "implementer").length, 0);
  assert.equal(h.calls.filter(c => c.role === "verifier").length, 11);
  assert.equal(h.calls.filter(c => c.role === "meta").length, 10);
  assert.equal(h.calls.length, 62);
});
test("proposal assignments prohibit implementing the proposed software", async () => {
  const h = harness(); h.state.mode = "proposal"; h.state.proposalPath = "design.md"; await run(h.r);
  assert.ok(h.calls.filter(c => c.role !== "planner").every(c => c.prompt.includes("Only improve the proposal design.md")));
});
test("large goals use bounded batches with explicit coverage", async () => {
  const h = harness(2); h.state.mode = "swarm";
  const slices = Array.from({length: 12}, (_, i) => ({ title: `Slice ${i+1}`, task: `Inspect module ${i+1}`, acceptance: ["Requirement holds"] }));
  h.response(async (role, prompt) => {
    if (role === "planner") return JSON.stringify({ slices });
    if (role === "meta") return metaReport;
    if (role === "reviewer" || role === "verifier") {
      const ids = JSON.parse(prompt.match(/exactly these IDs: (\[[^\n]+?\])/ )![1]) as number[];
      assert.ok(ids.length <= 5);
      return JSON.stringify({ findings: [], coverage: ids.map(slice => ({slice, status:"checked", evidence:"Inspected module"})) });
    }
    return pass;
  });
  await run(h.r);
  assert.equal(h.calls.filter(c => c.role === "reviewer").length, 90);
  assert.equal(h.calls.filter(c => c.role === "verifier").length, 33);
});
test("the last evaluator cannot complete without independent verification", async () => {
  const h = harness(); h.state.mode = "swarm";
  h.response(async role => {
    if (role === "planner") return validPlan;
    if (role === "meta") return metaReport;
    if (role === "verifier" && h.state.phase.startsWith("round/10/")) return defect;
    if (role === "verifier" || role === "reviewer") return clean;
    return h.state.phase.includes("/fix/") ? JSON.stringify({...JSON.parse(pass), decisions:[{id:"0",action:"fixed",reason:"Tried correction"}]}) : pass;
  });
  await assert.rejects(run(h.r), /three verified repair/);
  assert.notEqual(h.state.status, "complete");
  assert.equal(h.state.outputs["round/10/meta"], undefined);
  assert.equal(h.state.outputs["round/10/batch/1/verify/3"], undefined);
});
test("omitted or blocked coverage cannot count as a clean review", async () => {
  const h = harness(); h.state.mode = "swarm";
  h.response(async role => role === "planner" ? validPlan : '{"findings":[],"coverage":[]}');
  await assert.rejects(run(h.r), /coverage/);
  assert.equal(h.calls.filter(c => c.role === "evaluator").length, 0);
});

test("a concrete meta finding triggers repair and full verification before round completion", async () => {
  const h = harness(); h.state.mode = "swarm"; let raised = false;
  h.response(async role => {
    if (role === "planner") return validPlan;
    if (role === "meta") {
      if (!raised) { raised = true; return JSON.stringify({...JSON.parse(metaReport), findings: JSON.parse(defect).findings}); }
      return metaReport;
    }
    if (role === "reviewer" || role === "verifier") return clean;
    return h.state.phase.includes("/metafix/") ? JSON.stringify({...JSON.parse(pass), decisions:[{id:"0",action:"fixed",reason:"Fixed meta finding"}]}) : pass;
  });
  await run(h.r);
  assert.ok(h.calls.some(c => c.phase === "round/1/metafix/0"));
  assert.ok(h.calls.some(c => c.phase === "round/1/metaverify/0/0/verify/1"));
  assert.equal(h.calls.filter(c => c.role === "meta").length, 11);
  assert.equal(h.state.status, "complete");
});
test("meta cannot cite nonexistent receipts or hide a reported blocker", async () => {
  const h = harness(); h.state.mode = "swarm";
  h.response(async role => role === "planner" ? validPlan : role === "meta" ? JSON.stringify({...JSON.parse(metaReport),evidenceRefs:["invented"]}) : role === "reviewer" || role === "verifier" ? clean : pass);
  await assert.rejects(run(h.r), /existing receipts/);
  assert.equal(h.state.outputs["round/1/meta"], undefined);
  assert.throws(() => review('{"findings":[],"blocked":["Could not read source"]}'), /blocked/);
});
