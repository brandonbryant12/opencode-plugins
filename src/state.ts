import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { Slice, Review } from "./protocol.ts";

export type Receipt = { role: string; sessionID: string; model: string; text: string };
export type State = {
  version: 1; id: string; goal: string; parentID: string;
  base: string; head: string; branch: string;
  status: "running" | "paused" | "complete"; phase: string; reason: string;
  calls: number; createdAt: string; updatedAt: string;
  slice: Slice | null; feedback: string;
  completed: { title: string; head: string; tree: string }[];
  sessions: string[]; receipts: Receipt[];
  reviews: { scope: string; tree: string; reviewer: string; review: Review }[];
  pendingCommit?: { head: string; tree: string; title: string };
};

export async function readState(path: string): Promise<State | undefined> {
  let text: string;
  try { text = await readFile(path, "utf8"); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
  const state = JSON.parse(text) as State;
  if (state.version !== 1 || !state.id || !Array.isArray(state.sessions) || !Array.isArray(state.completed)) throw new Error("Invalid Churn state; inspect it before continuing");
  return state;
}
export async function saveState(path: string, state: State) {
  state.updatedAt = new Date().toISOString();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp`;
  const handle = await open(temp, "w", 0o600);
  try { await handle.writeFile(JSON.stringify(state, null, 2)); await handle.sync(); } finally { await handle.close(); }
  await rename(temp, path);
}

export async function lock(path: string): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // Never steal a lock automatically: OpenCode may outlive a crashed plugin.
  const handle = await open(path, "wx", 0o600).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "EEXIST") throw new Error(`Churn lock exists: ${path}. Stop the existing run. After a crash, restart the OpenCode service, inspect the checkout, then remove only this lock and resume.`);
    throw e;
  });
  await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
  await handle.close();
  return () => rm(path);
}

export function status(state: State | undefined): string {
  if (!state) return "No Churn run in this worktree. Use /churn <task or plan text>.";
  return `Churn ${state.id}: ${state.status}\n${state.phase}: ${state.reason}\nBranch: ${state.branch}\nCommitted slices: ${state.completed.length}; model calls: ${state.calls}\nHEAD: ${state.head}${state.slice ? `\nCurrent slice: ${state.slice.title}` : ""}`;
}
