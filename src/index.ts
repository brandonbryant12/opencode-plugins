import { Plugin } from "@opencode-ai/plugin";
import { mkdir, readFile, rename, realpath, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve, isAbsolute } from "node:path";
import { json, run, type State } from "./engine.ts";
import { stopWorkers, worker } from "./workers.ts";
import { phaseLabel, progress } from "./progress.ts";
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
    let starting = false;
    let controller: AbortController | undefined;
    let current: State | undefined;
    let settling: Promise<void> | undefined;
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
            await writeFile(join(directory, "receipts", `${runID}-${key.replaceAll("/", "-")}.json`), JSON.stringify(json(value), null, 2), { mode: 0o600 });
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
    const report = async (sessionID: string, text: string, open = true) => {
      const state = current ?? await readState(path);
      // A status notice must never start an assistant or a second writer.
      await ctx.session.synthetic({ sessionID, text: `[Goal workflow notice; do not act on this notice] ${text}`, description: text, resume: false });
      await rpc.events.emit("notice", { sessionID, parentID: state?.telemetry?.parentID ?? null, message: text, open });
    };
    const status = (s?: State) => s ? `${s.mode ?? "goal"} ${s.status} · ${phaseLabel(s.phase)}\n${s.reason}\n${Object.keys(s.outputs).filter(k => !/^round\/\d+\/meta$/.test(k)).length} completed worker tasks. Report: .opencode/goal/report.md` : "No saved run. Use /goal <outcome or @plan-file> or /swarm <scope>.";
    const rpc = await ctx.rpc.register(GoalRPC, { control: async input => {
      const { action, startedAt, parentID } = input as { action: "stop" | "resume"; startedAt: number; parentID: string };
      const state = current ?? await readState(path);
      if (state?.telemetry?.startedAt !== startedAt || state.telemetry.parentID !== parentID) return { message: "This run changed. Refresh progress before using its controls." };
      if (action === "stop") return { message: await stop() };
      await launch(parentID);
      return { message: "Progress opened for the saved run." };
    }, receipt: async input => {
      const state = current ?? await readState(path);
      const { key, startedAt } = input as { key: string; startedAt: number | null };
      const receipt = state && (state.telemetry?.startedAt ?? null) === startedAt && Object.hasOwn(state.outputs, key) ? state.outputs[key] : null;
      return { receipt: receipt === null ? null : JSON.stringify(json(receipt)) };
    }, progress: async (_input, request) => {
      const state = current ?? await readState(path);
      const sessions = await Promise.allSettled((state?.active ?? []).map(sessionID => ctx.session.get({ sessionID }, { signal: request.signal })));
      return { progress: progress(state, sessions.flatMap(s => s.status === "fulfilled" ? [s.value] : []), !!task || starting, controller?.signal.aborted) };
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
      const stats = current.telemetry?.workers[event.sessionID];
      if (stats) { stats.activity = `Using ${event.tool}`; stats.activityAt = Date.now(); }
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

    function settle(state: State) {
      settling ??= stopWorkers(ctx, state, save).finally(() => { settling = undefined; });
      return settling;
    }
    async function stop() {
      if (!task && !starting) {
        current ??= await readState(path);
        if (!current?.active.length) return "No active run. Saved progress is preserved.";
        await settle(current);
        current.status = "paused"; current.reason = "Saved workers stopped; partial work preserved."; await save();
        return current.reason;
      }
      controller?.abort();
      if (current) { current.reason = "Stopping workers; wait for paused status before editing files."; await save(); }
      // Interrupt the native sessions immediately, even if a provider prompt
      // has not yet observed the aborted request signal.
      if (current) void settle(current).catch(() => {});
      return "Stopping workers. Progress is preserved; wait for paused status before editing files.";
    }
    async function launch(parentID: string, input?: string, mode: State["mode"] = "goal") {
      // Paused/completed progress is visible just before the final passive
      // notice finishes. A click in that window must still resume on one try.
      if (task && current?.status !== "running" && !current?.active.length) await task;
      if (unloading) throw new Error("OpenCode is shutting down. Restart it to continue.");
      if (task || starting) { await report(parentID, "A run is already active. Opening its progress; use Stop run to pause it."); return; }
      // Reserve admission before any asynchronous reads, and acknowledge only
      // after validation and durable state creation. No hidden start failures.
      starting = true;
      controller = new AbortController();
      const signal = controller.signal;
      try {
        current = await readState(path);
        if (input !== undefined) {
          if (current && current.status !== "complete") { await report(parentID, "An unfinished run is saved. Opening its progress; use Resume run to continue."); return; }
          if (mode === "proposal" && !input.trim().startsWith("@")) throw new Error("Use /swarm --proposal @path/to/proposal.md");
          const goal = input.trim().startsWith("@") ? await planFile(ctx.location.directory, input.trim().slice(1)) : input;
          if (!goal.trim()) throw new Error("Use /goal <outcome or @plan-file>, or /swarm <scope> for existing work.");
          if (goal.length > 64000) throw new Error("Goal or plan exceeds 64000 characters; use a smaller feature plan.");
          if (!(await ctx.session.get({ sessionID: parentID })).model) throw new Error("Select a model with /models, then start the run again.");
          current = { version: 2, mode, ...(mode === "proposal" ? { proposalPath: input.trim().slice(1) } : {}), goal, status: "running", phase: "plan", reason: "Starting", outputs: {}, active: [] };
        } else if (!current || current.status === "complete") throw new Error("No unfinished goal to resume");
        else if (!(await ctx.session.get({ sessionID: parentID })).model) throw new Error("Select a model with /models, then resume the run.");
        const state = current;
        const retryHint = input === undefined && state.status === "paused" ? { phase: state.phase, message: state.reason.slice(0, 800) } : null;
        state.telemetry ??= { parentID, startedAt: Date.now(), updatedAt: Date.now(), workers: {} };
        state.telemetry.parentID = parentID;
        state.status = "running"; state.reason = "Starting; settling previous workers.";
        await save();
        await report(parentID, `${input !== undefined ? "Started" : "Resuming"} ${state.mode ?? "goal"}. Progress shows the current worker and review milestones.`);
        task = execute(state, retryHint).catch(async error => {
          state.status = "paused"; state.reason = `Could not finish saving progress: ${String(error)}`;
          await report(parentID, status(state), false).catch(() => {});
        }).finally(() => { task = undefined; controller = undefined; });
      } finally { starting = false; if (!task) controller = undefined; }

      async function execute(state: State, retryHint: { phase: string; message: string } | null) {
        let failure: string | undefined;
        try {
          await settle(state);
          signal.throwIfAborted();
          state.status = "running"; state.reason = "Working";
          await save();
          await run({ state, concurrency, signal, save, report: async () => {}, worker: (role, prompt, phase) => worker(ctx, state, save, parentID, role, `${retryHint && retryHint.phase === phase ? `Previous attempt paused: ${retryHint.message}\nCorrect this problem while preserving actual evidence and partial work.\n\n` : ""}${prompt}`, signal, timeout, phase) });
        } catch (error) {
          failure = signal.aborted ? "Stopped; partial work preserved." : String(error);
        } finally {
          try { await settle(state); }
          catch (error) { failure = String(error); }
          if (failure) { state.status = "paused"; state.reason = failure; await save(); }
          await report(parentID, status(state), false).catch(() => {});
        }
      }
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
      editor.add({ name: "goal-panel", description: "Open Goal / Swarm progress and controls", execute: async ({ sessionID }) => report(sessionID, status(current ?? await readState(path))) });
      editor.add({ name: "goal-stop", description: "Stop workers and preserve progress", execute: async ({ sessionID }) => { await report(sessionID, await stop()); } });
      editor.add({ name: "goal-resume", description: "Resume unfinished work after settling old workers", execute: ({ sessionID }) => launch(sessionID) });
    });
    return async () => { unloading = true; controller?.abort(); await task; await rpc.dispose(); if (!current?.active.length) await guard.dispose(); };
  },
});
