import { Plugin } from "@opencode-ai/plugin";
import { mkdir, readFile, rename, realpath, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve, isAbsolute } from "node:path";
import { run, type State } from "./engine.ts";
import { stopWorkers, worker } from "./workers.ts";
import { progress } from "./progress.ts";
import { ledger, reportMarkdown } from "./reports.ts";
import { GoalRPC } from "./rpc.ts";

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
    let reportStamp = "";
    let receiptRun = "";
    const savedReceipts = new Map<string, string>();
    const save = () => {
      if (current?.telemetry) current.telemetry.updatedAt = Date.now();
      const raw = JSON.stringify(current, null, 2);
      const snapshot = current;
      const receiptEntries = Object.entries(current?.outputs ?? {});
      const runID = String(current?.telemetry?.startedAt);
      const stamp = `${current?.telemetry?.startedAt}:${current?.status}:${current?.reason}:${Object.keys(current?.outputs ?? {}).filter(k => k.endsWith("/meta")).length}`;
      const reportText = current && stamp !== reportStamp ? reportMarkdown(current) : undefined;
      const outcomes = reportText !== undefined && current ? ledger(current) : undefined;
      const pending = saves.then(async () => {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeFile(`${path}.tmp`, raw, { mode: 0o600 });
        await rename(`${path}.tmp`, path);
        if (snapshot) {
          if (receiptRun !== runID) { savedReceipts.clear(); receiptRun = runID; await writeFile(join(directory, "objective.md"), snapshot.goal, { mode: 0o600 }); }
          await mkdir(join(directory, "receipts"), { recursive: true, mode: 0o700 });
          for (const [key, value] of receiptEntries) if (savedReceipts.get(key) !== value) {
            if (!/^[a-z0-9/]+$/.test(key)) throw new Error("Invalid checkpoint key");
            await writeFile(join(directory, "receipts", `${runID}-${key.replaceAll("/", "-")}.json`), value, { mode: 0o600 });
            savedReceipts.set(key, value);
          }
        }
        if (reportText !== undefined) {
          await writeFile(join(directory, "report.md.tmp"), reportText, { mode: 0o600 });
          await rename(join(directory, "report.md.tmp"), join(directory, "report.md"));
          for (const key of ["findings", "coverage"] as const) {
            await writeFile(join(directory, `${key}.json.tmp`), JSON.stringify(outcomes?.[key] ?? [], null, 2), { mode: 0o600 });
            await rename(join(directory, `${key}.json.tmp`), join(directory, `${key}.json`));
          }
          reportStamp = stamp;
        }
      });
      saves = pending.catch(() => {});
      return pending;
    };
    const report = async (sessionID: string, text: string) => { await ctx.session.synthetic({ sessionID, text: `[Goal] ${text}` }); };
    const status = (s?: State) => s ? `${s.status}: ${s.phase}\n${s.reason}\n${Object.keys(s.outputs).filter(k => !/^round\/\d+\/meta$/.test(k)).length} completed worker tasks. Progress: ${path}` : "No goal yet. Use /goal <goal or @plan-file>.";
    const rpc = await ctx.rpc.register(GoalRPC, { receipt: async input => {
      const state = current ?? await readState(path);
      const { key, startedAt } = input as { key: string; startedAt: number | null };
      const receipt = state && (state.telemetry?.startedAt ?? null) === startedAt && Object.hasOwn(state.outputs, key) ? state.outputs[key] : null;
      return { receipt };
    }, progress: async (_input, request) => {
      const state = current ?? await readState(path);
      const sessions = await Promise.allSettled((state?.active ?? []).map(sessionID => ctx.session.get({ sessionID }, { signal: request.signal })));
      return { progress: progress(state, sessions.flatMap(s => s.status === "fulfilled" ? [s.value] : []), !!task) };
    } });
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
      if (session.agent === "goal-write" && current.mode !== "proposal") allowed.push("edit", "write", "multiedit", "apply_patch", "patch", "shell");
      if (session.agent === "goal-write" && current.mode === "proposal" && ["edit", "write"].includes(event.tool)) {
        const input = event.input as { path?: string; filePath?: string };
        const target = input.path ?? input.filePath;
        if (!target || !current.proposalPath || await realpath(resolve(ctx.location.directory, target)) !== await realpath(resolve(ctx.location.directory, current.proposalPath))) throw new Error("Proposal mode can edit only its source document");
        allowed.push(event.tool);
      }
      if (!allowed.includes(event.tool)) throw new Error(`Goal worker denied tool: ${event.tool}`);
    });

    async function launch(parentID: string, input?: string, mode: State["mode"] = "goal") {
      if (unloading || task) throw new Error("Goal is already active or unloading; use /goal-status or /goal-stop");
      controller = new AbortController();
      const signal = controller.signal;
      // Assign before asynchronous reads to prevent double starts.
      task = (async () => {
        current = await readState(path);
        if (input !== undefined) {
          if (current && current.status !== "complete") throw new Error("An unfinished goal exists. Use /goal-resume.");
          if (mode === "proposal" && !input.trim().startsWith("@")) throw new Error("Use /swarm --proposal @path/to/proposal.md");
          const goal = input.trim().startsWith("@") ? await planFile(ctx.location.directory, input.trim().slice(1)) : input;
          if (!goal.trim() || goal.length > 64000) throw new Error("Provide a goal or plan of 1–64000 characters");
          current = { version: 2, mode, ...(mode === "proposal" ? { proposalPath: input.trim().slice(1) } : {}), goal, status: "running", phase: "plan", reason: "Starting", outputs: {}, active: [] };
        } else if (!current || current.status === "complete") throw new Error("No unfinished goal to resume");
        const state = current;
        state.telemetry ??= { parentID, startedAt: Date.now(), updatedAt: Date.now(), workers: {} };
        state.telemetry.parentID = parentID;
        try {
          await stopWorkers(ctx, state, save);
          signal.throwIfAborted();
          state.status = "running"; state.reason = "Working";
          await save();
          await run({ state, concurrency, signal, save, report: async () => {}, worker: (role, prompt, phase) => worker(ctx, state, save, parentID, role, prompt, signal, timeout, phase) });
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
      editor.add({ name: "swarm", description: "Audit and improve existing work; --proposal @file reviews a design only", execute: async ({ sessionID, prompt }) => {
        let input = prompt.text.trim();
        if (!input) {
          const saved = current ?? await readState(path);
          if (!saved) throw new Error("Provide a swarm scope or @document; there is no previous goal to reuse.");
          input = saved.mode === "proposal" ? `--proposal @${saved.proposalPath}` : saved.goal;
        }
        return launch(sessionID, /^--proposal(?:\s|$)/.test(input) ? input.slice(10).trim() : input || "Audit and improve current project changes against repository requirements.", /^--proposal(?:\s|$)/.test(input) ? "proposal" : "swarm");
      } });
      editor.add({ name: "goal-status", description: "Show saved goal progress", execute: async ({ sessionID }) => report(sessionID, status(current ?? await readState(path))) });
      editor.add({ name: "goal-stop", description: "Stop workers and preserve progress", execute: async ({ sessionID }) => { controller?.abort(); await report(sessionID, task ? "Stopping workers; wait for paused status before editing files." : "No active goal."); } });
      editor.add({ name: "goal-resume", description: "Resume unfinished work after settling old workers", execute: ({ sessionID }) => launch(sessionID) });
    });
    return async () => { unloading = true; controller?.abort(); await task; await rpc.dispose(); if (!current?.active.length) await guard.dispose(); };
  },
});
