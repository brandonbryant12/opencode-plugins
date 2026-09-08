import { Plugin } from "@opencode-ai/plugin";
import { mkdir, readFile, rename, realpath, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve, isAbsolute } from "node:path";
import { run, type State } from "./engine.ts";
import { stopWorkers, worker } from "./workers.ts";

export function option(input: unknown, fallback: number, max: number): number {
  const n = input ?? fallback;
  if (!Number.isInteger(n) || Number(n) < 1 || Number(n) > max) throw new Error(`Expected an integer from 1 to ${max}`);
  return Number(n);
}
export async function readState(path: string): Promise<State | undefined> {
  let raw: string;
  try { raw = await readFile(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  const s = JSON.parse(raw) as State;
  if (s.version !== 2 || typeof s.goal !== "string" || !s.outputs || typeof s.outputs !== "object" || Array.isArray(s.outputs) || !Object.values(s.outputs).every(x => typeof x === "string") || !Array.isArray(s.active) || !s.active.every(x => typeof x === "string") || !["running", "paused", "complete"].includes(s.status)) throw new Error("Invalid goal state; inspect .opencode/goal/state.json");
  return s;
}
export async function planFile(directory: string, input: string): Promise<string> {
  const root = await realpath(directory);
  const file = await realpath(resolve(root, input.trim()));
  const rel = relative(root, file);
  if (!rel || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) throw new Error("Plan file must be inside the project");
  if ((await stat(file)).size > 64000) throw new Error("Plan file exceeds 64000 bytes");
  return readFile(file, "utf8");
}

export default Plugin.define({
  id: "goal",
  async setup(ctx) {
    for (const key of Object.keys(ctx.options)) if (!["reviewConcurrency", "steps", "workerTimeoutMinutes"].includes(key)) throw new Error(`Unknown goal option: ${key}. Remove old Churn options; see README.`);
    const concurrency = option(ctx.options.reviewConcurrency, 1, 3);
    const steps = option(ctx.options.steps, 40, 100);
    const timeout = option(ctx.options.workerTimeoutMinutes, 20, 120);
    const directory = join(ctx.location.directory, ".opencode", "goal");
    const path = join(directory, "state.json");
    let task: Promise<void> | undefined;
    let controller: AbortController | undefined;
    let current: State | undefined;
    let unloading = false;
    let saves = Promise.resolve();
    const save = () => {
      const raw = JSON.stringify(current, null, 2);
      const pending = saves.then(async () => {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeFile(`${path}.tmp`, raw, { mode: 0o600 });
        await rename(`${path}.tmp`, path);
      });
      saves = pending.catch(() => {});
      return pending;
    };
    const report = async (sessionID: string, text: string) => { await ctx.session.synthetic({ sessionID, text: `[Goal] ${text}` }); };
    const status = (s?: State) => s ? `${s.status}: ${s.phase}\n${s.reason}\n${Object.keys(s.outputs).length} completed worker tasks. Progress: ${path}` : "No goal yet. Use /goal <goal or @plan-file>.";
    await ctx.agent.transform(editor => {
      for (const name of ["goal-read", "goal-write"]) editor.update(name, agent => {
        agent.mode = "all"; agent.hidden = true; agent.steps = steps;
        agent.description = "Fresh worker for the /goal coordinator";
        agent.permissions.push({ action: "subagent", resource: "*", effect: "deny" });
        if (name === "goal-read") for (const action of ["edit", "shell"]) agent.permissions.push({ action, resource: "*", effect: "deny" });
      });
    });
    // This beta can resolve project permissions after agent permissions. Enforce
    // read-only workers at the tool boundary, including nested Code Mode calls.
    const guard = await ctx.tool.hook("execute.before", async event => {
      if (!current?.active.includes(event.sessionID)) return;
      const session = await ctx.session.get({ sessionID: event.sessionID });
      const allowed = ["read", "glob", "grep", "execute"];
      if (session.agent === "goal-write") allowed.push("edit", "write", "multiedit", "apply_patch", "patch", "shell");
      if (!allowed.includes(event.tool)) throw new Error(`Goal worker denied tool: ${event.tool}`);
    });

    async function launch(parentID: string, input?: string) {
      if (unloading || task) throw new Error("Goal is already active or unloading; use /goal-status or /goal-stop");
      controller = new AbortController();
      const signal = controller.signal;
      // Assign before asynchronous reads to prevent double starts.
      task = (async () => {
        current = await readState(path);
        if (input !== undefined) {
          if (current && current.status !== "complete") throw new Error("An unfinished goal exists. Use /goal-resume.");
          const goal = input.trim().startsWith("@") ? await planFile(ctx.location.directory, input.trim().slice(1)) : input;
          if (!goal.trim() || goal.length > 64000) throw new Error("Provide a goal or plan of 1–64000 characters");
          current = { version: 2, goal, status: "running", phase: "plan", reason: "Starting", outputs: {}, active: [] };
        } else if (!current || current.status === "complete") throw new Error("No unfinished goal to resume");
        const state = current;
        try {
          await stopWorkers(ctx, state, save);
          signal.throwIfAborted();
          state.status = "running"; state.reason = "Working";
          await save();
          await run({ state, concurrency, signal, save, report: text => report(parentID, text), worker: (role, prompt) => worker(ctx, state, save, parentID, role, prompt, signal, timeout) });
        } catch (error) {
          state.status = "paused"; state.reason = signal.aborted ? "Stopped; partial work preserved." : String(error);
          await save();
        } finally {
          try { await stopWorkers(ctx, state, save); }
          catch (error) { state.status = "paused"; state.reason = String(error); await save(); }
          await report(parentID, status(state));
        }
      })().catch(error => report(parentID, String(error))).finally(() => { task = undefined; controller = undefined; });
    }
    await ctx.command.transform(editor => {
      editor.add({ name: "goal", description: "Implement and review a goal or @plan-file, then run ten review rounds", execute: ({ sessionID, prompt }) => launch(sessionID, prompt.text) });
      editor.add({ name: "goal-status", description: "Show saved goal progress", execute: async ({ sessionID }) => report(sessionID, status(current ?? await readState(path))) });
      editor.add({ name: "goal-stop", description: "Stop workers and preserve progress", execute: async ({ sessionID }) => { controller?.abort(); await report(sessionID, task ? "Stopping workers; wait for paused status before editing files." : "No active goal."); } });
      editor.add({ name: "goal-resume", description: "Resume unfinished work after settling old workers", execute: ({ sessionID }) => launch(sessionID) });
    });
    return async () => { unloading = true; controller?.abort(); await task; if (!current?.active.length) await guard.dispose(); };
  },
});
