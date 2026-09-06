import test from "node:test";
import assert from "node:assert/strict";
import { chmod, readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { configure } from "../src/config.ts";
import { plan, review } from "../src/protocol.ts";
import { execute, awake } from "../src/process.ts";
import { lock, saveState, readState } from "../src/state.ts";
import { repository } from "./helpers.ts";
import { allowedTool, finalText } from "../src/workers.ts";

test("configuration is bounded, explicit, and always includes simplicity", () => {
  assert.equal(configure({}).concurrency, 2);
  assert.equal(configure({ reviewers: [{ name: "security" }] }).reviewers.at(-1)?.name, "simplicity");
  for (const value of [{ concurrency: 0 }, { maxCalls: Infinity }, { madeUp: true }, { model: "invalid" }, { checks: [{ name: "x", command: "npm test" }] }, { models: { wrong: "provider/model" } }]) assert.throws(() => configure(value));
  assert.deepEqual(configure({ model: "local/org/model#high" }).model, { providerID: "local", id: "org/model", variant: "high" });
});
test("verdicts cannot be smuggled through prose or contradictory JSON", () => {
  assert.throws(() => review('Here is the report: {"verdict":"pass","findings":[]}'));
  assert.throws(() => review('{"verdict":"revise","findings":[]}'));
  assert.throws(() => review('{"verdict":"pass","findings":[{"severity":"high","location":"a","problem":"b","fix":"c"}]}'));
  assert.throws(() => plan('{"done":true,"reason":"ok","slice":{}}'));
  assert.equal(review('```json\n{"verdict":"pass","findings":[]}\n```').verdict, "pass");
});
test("reviewers cannot edit, execute shells, or delegate", () => {
  for (const tool of ["shell", "bash", "subagent", "write", "apply_patch", "edit", "mcp_execute"]) assert.equal(allowedTool("reviewer", tool), false);
  assert.equal(allowedTool("builder", "edit"), true);
  assert.equal(allowedTool("reviewer", "read"), true);
});
test("truncated or failed model replies cannot pass", () => {
  const assistant = { id: "a", type: "assistant", agent: "build", model: { providerID: "p", id: "m" }, time: { created: 1, completed: 2 }, content: [{ type: "text", text: "done" }], finish: "stop" } as const;
  assert.equal(finalText([structuredClone(assistant)] as never), "done");
  assert.throws(() => finalText([{ ...assistant, finish: "length" }] as never));
  assert.throws(() => finalText([{ ...assistant, time: { created: 1 } }] as never));
});
test("dirty work and potential secrets are preserved and rejected", async t => {
  const f = await repository(); t.after(f.cleanup);
  await writeFile(join(f.directory, ".env"), "SECRET=example\n");
  await assert.rejects(f.git.preflight(), /uncommitted changes/);
  await assert.rejects(f.git.snapshot(), /Potential secret/);
  assert.equal(await readFile(join(f.directory, ".env"), "utf8"), "SECRET=example\n");
});
test("post-review changes cannot be committed", async t => {
  const f = await repository(); t.after(f.cleanup);
  await writeFile(join(f.directory, "answer.txt"), "candidate\n");
  const snapshot = await f.git.snapshot();
  await writeFile(join(f.directory, "answer.txt"), "changed\n");
  await assert.rejects(f.git.commit(snapshot.tree, f.state.head, "main", "test", "run"), /changed after review/);
  assert.equal(await f.git.head(), f.state.head);
});
test("commit hooks cannot silently substitute unreviewed code", async t => {
  const f = await repository(); t.after(f.cleanup);
  await writeFile(join(f.directory, "answer.txt"), "candidate\n");
  const snapshot = await f.git.snapshot();
  const hook = join(f.directory, ".git/hooks/pre-commit");
  await writeFile(hook, '#!/bin/sh\nprintf "hook\\n" > answer.txt\ngit add answer.txt\n'); await chmod(hook, 0o755);
  await assert.rejects(f.git.commit(snapshot.tree, f.state.head, "main", "test", "run"), /Commit hook changed/);
});
test("exclusive lock and durable state", async t => {
  const f = await repository(); t.after(f.cleanup);
  const path = join(f.directory, ".git/churn/state.json");
  await saveState(path, f.state);
  assert.deepEqual(await readState(path), f.state);
  const release = await lock(`${path}.lock`);
  await assert.rejects(lock(`${path}.lock`), /lock exists/);
  await release();
  await (await lock(`${path}.lock`))();
});
test("process runner uses argument arrays and cancels a child process group", async () => {
  const directory = await mkdtemp(join(tmpdir(), "churn-process-"));
  try {
    const literal = "$(touch should-not-exist); `whoami`";
    assert.equal(await execute([process.execPath, "-e", "process.stdout.write(process.argv[1])", literal], directory), literal);
    const controller = new AbortController();
    const promise = execute([process.execPath, "-e", "setInterval(()=>{},1000)"], directory, { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(promise, /Run stopped/);
    await assert.rejects(execute([process.execPath, "-e", "setInterval(()=>{},1000)"], directory, { timeoutMs: 30 }), /timed out/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("macOS keeps awake only while its owned caffeinate process is alive", { skip: process.platform !== "darwin" }, async () => {
  const release = await awake(true);
  let pid = "";
  try {
    pid = await execute(["/usr/bin/pgrep", "-P", String(process.pid), "-x", "caffeinate"], tmpdir());
    assert.match(pid, /^\d+$/);
  } finally { await release(); }
  await assert.rejects(execute(["/bin/kill", "-0", pid], tmpdir()));
  await release();
});
