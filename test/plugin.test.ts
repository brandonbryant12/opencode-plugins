import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import type { Plugin } from "@opencode-ai/plugin";
import plugin from "../src/index.ts";
import { saveState, readState } from "../src/state.ts";
import { repository } from "./helpers.ts";

async function fixture(t: test.TestContext) {
  const repo = await repository();
  const commands = new Map<string, (input: any) => Promise<void>>();
  const reports: string[] = [];
  const ctx = {
    location: { directory: repo.directory },
    options: { keepAwake: false, checks: [{ name: "test", command: ["true"] }] },
    agent: { transform: async () => {} },
    command: { transform: async (cb: any) => cb({ add: (command: any) => commands.set(command.name, command.execute) }) },
    catalog: { model: { list: async () => ({ data: [{ providerID: "p", id: "m" }] }) } },
    session: {
      synthetic: async ({ text }: { text: string }) => { reports.push(text); },
      get: async () => ({ model: { providerID: "p", id: "m" } }),
      create: async () => { throw new Error("Intentional provider stop"); },
      hook: async () => ({ dispose: async () => {} }),
    },
    tool: { hook: async () => ({ dispose: async () => {} }) },
    permission: { hook: async () => ({ dispose: async () => {} }) },
  } as unknown as Plugin.Context;
  const cleanup = await plugin.setup(ctx);
  t.after(async () => { if (cleanup) await cleanup(); await repo.cleanup(); });
  const path = join(repo.directory, ".git/churn/state.json");
  const invoke = (name: string, text = "") => commands.get(name)!({ sessionID: "parent", prompt: { text } });
  async function settled() {
    for (let i = 0; i < 300; i++) {
      if (reports.some(r => /Intentional provider stop|uncommitted changes|between 1/.test(r))) {
        try { await access(join(repo.directory, ".git/churn.lock")); } catch { return; }
      }
      await new Promise(r => setTimeout(r, 10));
    }
    throw new Error(`Plugin did not settle: ${reports.join("\n")}`);
  }
  return { ...repo, path, invoke, reports, settled };
}
test("failed new start cannot rewrite an earlier completed run", async t => {
  const f = await fixture(t);
  f.state.status = "complete";
  await saveState(f.path, f.state);
  const before = await readFile(f.path, "utf8");
  await f.invoke("churn", "");
  await f.settled();
  assert.equal(await readFile(f.path, "utf8"), before);
});
test("dirty checkout is preserved and no branch is created", async t => {
  const f = await fixture(t);
  await writeFile(join(f.directory, "answer.txt"), "user changes\n");
  await f.invoke("churn", "task");
  await f.settled();
  assert.equal(await f.git.branch(), "main");
  assert.equal(await readFile(join(f.directory, "answer.txt"), "utf8"), "user changes\n");
});
test("journal recovers our exact commit once after a crash", async t => {
  const f = await fixture(t);
  await writeFile(join(f.directory, "answer.txt"), "after\n");
  const candidate = await f.git.snapshot();
  f.state.pendingCommit = { head: f.state.head, tree: candidate.tree, title: "Update answer" };
  const committed = await f.git.commit(candidate.tree, f.state.head, "main", "Update answer", f.state.id);
  await saveState(f.path, f.state);
  await f.invoke("churn-resume");
  await f.settled();
  const state = await readState(f.path);
  assert.equal(state?.head, committed);
  assert.equal(state?.completed.length, 1);
  assert.equal(state?.pendingCommit, undefined);
});
