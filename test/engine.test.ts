import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { run, pool, type Runtime } from "../src/engine.ts";
import { configure } from "../src/config.ts";
import { repository } from "./helpers.ts";

const slice = { title: "Update answer", instructions: "Change answer", acceptance: ["answer is after"] };
const next = JSON.stringify({ done: false, reason: "Answer needs correction", slice });
const done = JSON.stringify({ done: true, reason: "Answer verified", slice: null });
const pass = JSON.stringify({ verdict: "pass", findings: [] });
const revise = JSON.stringify({ verdict: "revise", findings: [{ severity: "high", location: "answer.txt:1", problem: "Wrong answer", fix: "Use after" }] });

async function fixture(t: test.TestContext) {
  const repo = await repository();
  t.after(repo.cleanup);
  const config = configure({ reviewers: [{ name: "correctness" }], cleanAudits: 2, checks: [{ name: "answer", command: ["true"] }] });
  let builders = 0;
  let reviews = 0;
  const runtime: Runtime = {
    state: repo.state, config, signal: new AbortController().signal,
    save: async () => {}, report: async () => {},
    identity: () => repo.git.identity(repo.state.head, repo.state.branch),
    snapshot: () => repo.git.snapshot(), diff: () => repo.git.diff(repo.state.base),
    checks: async () => {
      assert.equal(await readFile(join(repo.directory, "answer.txt"), "utf8"), "after\n");
      return "answer passed";
    },
    commit: (tree, title) => repo.git.commit(tree, repo.state.head, repo.state.branch, title, repo.state.id),
    worker: async role => {
      if (role === "planner") return repo.state.completed.length ? done : next;
      if (role === "builder") { builders++; await writeFile(join(repo.directory, "answer.txt"), "after\n"); return "Updated answer"; }
      reviews++;
      return pass;
    },
  };
  return { ...repo, runtime, counts: () => ({ builders, reviews }) };
}

test("real Git: builds, checks, reviews, commits exact tree, and audits twice", async t => {
  const f = await fixture(t);
  await run(f.runtime);
  assert.equal(f.state.status, "complete");
  assert.equal(f.state.completed.length, 1);
  assert.deepEqual(f.counts(), { builders: 1, reviews: 6 });
  assert.equal(f.state.reviews.length, 6);
  assert.equal(await f.git.run(["rev-parse", "HEAD^{tree}"]), f.state.completed[0].tree);
  await f.git.clean();
});
test("one rejecting reviewer vetoes a slice and triggers a fresh review panel", async t => {
  const f = await fixture(t);
  const original = f.runtime.worker;
  let rejected = false;
  f.runtime.worker = async (role, prompt, model) => {
    if (role === "reviewer" && !rejected) { rejected = true; return revise; }
    return original(role, prompt, model);
  };
  await run(f.runtime);
  assert.equal(f.counts().builders, 2);
  assert.equal(f.state.completed.length, 1);
});
test("failing checks go back to builder; no commit happens before success", async t => {
  const f = await fixture(t);
  const original = f.runtime.checks;
  let count = 0;
  f.runtime.checks = async () => { if (++count === 1) throw new Error("Expected after"); return original(); };
  await run(f.runtime);
  assert.equal(f.counts().builders, 2);
  assert.equal(f.state.completed.length, 1);
});
test("malformed reviewer output never authorizes a commit", async t => {
  const f = await fixture(t);
  const original = f.runtime.worker;
  f.runtime.worker = async (role, prompt, model) => role === "reviewer" ? "Looks good!" : original(role, prompt, model);
  await assert.rejects(run(f.runtime));
  assert.equal(await f.git.head(), f.state.base);
  assert.equal(f.state.completed.length, 0);
});
test("review mutation invalidates the entire panel", async t => {
  const f = await fixture(t);
  const original = f.runtime.worker;
  f.runtime.worker = async (role, prompt, model) => {
    if (role === "reviewer") await writeFile(join(f.directory, "answer.txt"), "tampered\n");
    return original(role, prompt, model);
  };
  await assert.rejects(run(f.runtime), /changed during read-only review/);
  assert.equal(await f.git.head(), f.state.base);
});
test("persistent findings reach the repair limit with partial work preserved", async t => {
  const f = await fixture(t);
  f.runtime.config.maxFixRounds = 2;
  const original = f.runtime.worker;
  f.runtime.worker = async (role, prompt, model) => role === "reviewer" ? revise : original(role, prompt, model);
  await assert.rejects(run(f.runtime), /without convergence/);
  assert.equal(f.counts().builders, 2);
  assert.equal(await f.git.head(), f.state.base);
  assert.equal(await readFile(join(f.directory, "answer.txt"), "utf8"), "after\n");
});
test("a no-op builder pauses instead of claiming completion", async t => {
  const f = await fixture(t);
  const original = f.runtime.worker;
  f.runtime.worker = async (role, prompt, model) => role === "builder" ? "Done" : original(role, prompt, model);
  await assert.rejects(run(f.runtime), /made no changes/);
  assert.equal(f.state.completed.length, 0);
});
test("abort after checks cannot commit", async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  f.runtime.signal = controller.signal;
  f.runtime.checks = async () => { controller.abort(); return "pass"; };
  await assert.rejects(run(f.runtime));
  assert.equal(await f.git.head(), f.state.base);
});
test("pool bounds concurrency and settles peers before throwing", async () => {
  let active = 0;
  let maximum = 0;
  let finished = 0;
  await assert.rejects(pool([0, 1, 2], 2, async value => {
    active++; maximum = Math.max(maximum, active);
    try { if (value === 0) throw new Error("fail"); await new Promise(r => setTimeout(r, 20)); finished++; }
    finally { active--; }
  }), /fail/);
  assert.equal(active, 0);
  assert.equal(finished, 1);
  assert.equal(maximum, 1);
  let concurrent = 0;
  await pool([0, 1, 2, 3, 4], 2, async () => { active++; concurrent = Math.max(concurrent, active); await new Promise(r => setTimeout(r, 5)); active--; });
  assert.equal(concurrent, 2);
});
