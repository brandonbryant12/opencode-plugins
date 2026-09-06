import test from "node:test";
import assert from "node:assert/strict";
import type { Plugin } from "@opencode-ai/plugin";
import { Workers } from "../src/workers.ts";
import { configure } from "../src/config.ts";
import { repository } from "./helpers.ts";

async function fixture(t: test.TestContext) {
  const repo = await repository(); t.after(repo.cleanup);
  const hooks = new Map<string, (event: any) => any>();
  const calls: string[] = [];
  const controller = new AbortController();
  const hook = async (name: string, callback: (event: any) => any) => { hooks.set(name, callback); return { dispose: async () => { hooks.delete(name); } }; };
  const session = {
    hook,
    create: async () => { calls.push("create"); return { id: "worker" }; },
    prompt: async () => { calls.push("prompt"); },
    wait: async () => { calls.push("wait"); },
    get: async () => ({ outcome: "succeeded" }),
    interrupt: async () => { calls.push("interrupt"); },
    context: async () => [{ id: "message", type: "assistant", time: { created: 1, completed: 2 }, finish: "stop", content: [{ type: "text", text: "Result" }] }],
  };
  const ctx = { location: { directory: repo.directory }, session, tool: { hook }, permission: { hook } } as unknown as Plugin.Context;
  const workers = new Workers(ctx, configure({ maxCalls: 2 }), repo.state, async () => { calls.push("save"); }, controller.signal, { providerID: "test", id: "model" });
  return { ...repo, workers, session, calls, hooks, controller };
}
test("ownership is saved before prompt admission; completed workers produce receipts", async t => {
  const f = await fixture(t);
  assert.equal(await f.workers.worker("builder", "task"), "Result");
  assert.deepEqual(f.calls.slice(0, 3), ["create", "save", "prompt"]);
  assert.equal(f.workers.active.size, 0);
  assert.equal(f.state.receipts[0].sessionID, "worker");
});
test("cancel racing creation cannot lose a worker or admit its prompt", async t => {
  const f = await fixture(t);
  f.session.create = async () => { f.controller.abort(); return { id: "worker" }; };
  await assert.rejects(f.workers.worker("builder", "task"));
  assert.deepEqual(f.state.sessions, ["worker"]);
  assert.ok(!f.calls.includes("prompt"));
  await f.workers.stop();
  assert.deepEqual(f.calls.slice(-2), ["interrupt", "wait"]);
  assert.equal(f.workers.active.size, 0);
});
test("failed outcome is not accepted as an idle success", async t => {
  const f = await fixture(t);
  f.session.get = async () => ({ outcome: "failed" });
  await assert.rejects(f.workers.worker("reviewer", "task"), /outcome failed/);
  assert.equal(f.state.receipts.length, 0);
  assert.equal(f.workers.active.size, 1);
  await f.workers.stop();
});
test("uncertain interrupt retains active workers for fail-closed cleanup", async t => {
  const f = await fixture(t);
  f.workers.active.add("worker");
  f.session.interrupt = async () => { throw new Error("disconnected"); };
  await assert.rejects(f.workers.stop(), /Lock retained/);
  assert.equal(f.workers.active.size, 1);
});
test("hooks restrict nested Code Mode calls and never relax existing permission", async t => {
  const f = await fixture(t);
  await f.workers.hooks();
  f.workers.owned.set("reader", "reviewer");
  f.workers.owned.set("writer", "builder");
  const before = f.hooks.get("execute.before")!;
  assert.doesNotThrow(() => before({ sessionID: "reader", tool: "execute" }));
  assert.throws(() => before({ sessionID: "reader", tool: "write" }), /cannot use/);
  assert.throws(() => before({ sessionID: "writer", tool: "shell" }), /cannot use/);
  assert.doesNotThrow(() => before({ sessionID: "unrelated", tool: "shell" }));
  const evaluate = f.hooks.get("evaluate")!;
  for (const effect of ["deny", "ask"]) {
    const event = { sessionID: "reader", action: "read", resources: [".env"], effect };
    evaluate(event); assert.equal(event.effect, effect);
  }
  const event = { sessionID: "writer", action: "edit", resources: ["opencode.json"], effect: "allow" };
  evaluate(event); assert.equal(event.effect, "deny");
  const context = { sessionID: "reader", tools: { execute: {}, read: {}, write: {}, shell: {} } };
  f.hooks.get("context")!(context);
  assert.deepEqual(Object.keys(context.tools), ["execute", "read"]);
});
test("request budget counts actual primary and auxiliary model requests", async t => {
  const f = await fixture(t);
  await f.workers.hooks();
  f.workers.owned.set("worker", "reviewer");
  const request = f.hooks.get("model.request")!;
  await request({ sessionID: "unrelated", kind: "primary" });
  assert.equal(f.state.calls, 0);
  await request({ sessionID: "worker", kind: "primary" });
  await request({ sessionID: "worker", kind: "title" });
  await assert.rejects(request({ sessionID: "worker", kind: "primary" }), /budget reached/);
  assert.equal(f.state.calls, 2);
});
