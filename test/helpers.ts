import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Git } from "../src/git.ts";
import type { State } from "../src/state.ts";

export async function repository() {
  const directory = await mkdtemp(join(tmpdir(), "churn-test-"));
  const git = new Git(directory);
  await git.run(["init", "-b", "main"]);
  await git.run(["config", "user.name", "Churn Test"]);
  await git.run(["config", "user.email", "churn@example.invalid"]);
  await git.run(["config", "commit.gpgsign", "false"]);
  await writeFile(join(directory, "answer.txt"), "before\n");
  await git.run(["add", "."]);
  await git.run(["commit", "-m", "Initial"]);
  const head = await git.head();
  const state: State = { version: 1, id: "test-run", goal: "Change answer to after", parentID: "parent", base: head, head, branch: "main", status: "running", phase: "starting", reason: "", calls: 0, createdAt: "", updatedAt: "", slice: null, feedback: "", completed: [], sessions: [], receipts: [], reviews: [] };
  return { directory, git, state, cleanup: () => rm(directory, { recursive: true, force: true }) };
}
