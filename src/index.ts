import { Plugin } from "@opencode-ai/plugin";
import { access, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { configure } from "./config.ts";
import { Git } from "./git.ts";
import { run } from "./engine.ts";
import { awake, execute } from "./process.ts";
import { lock, readState, saveState, status, type State } from "./state.ts";
import { Workers } from "./workers.ts";

export default Plugin.define({
  id: "churn",
  async setup(ctx) {
    const config = configure(ctx.options);
    const git = new Git(ctx.location.directory, config.maxDiffBytes);
    await ctx.agent.transform(editor => {
      editor.update("churn-worker", agent => {
        agent.mode = "all";
        agent.hidden = true;
        agent.steps = config.steps;
        agent.description = "Fresh, bounded worker owned by the Churn runner";
        agent.permissions.push({ action: "subagent", resource: "*", effect: "deny" });
        agent.permissions.push({ action: "shell", resource: "*", effect: "deny" });
      });
    });
    // Loading the plugin is also valid outside a repository. Start gives the
    // actionable Git error; opening OpenCode must not create files or branches.
    let task: Promise<void> | undefined;
    let controller: AbortController | undefined;
    let current: State | undefined;
    let unloading = false;
    const paths = async () => ({
      state: resolve(ctx.location.directory, await git.run(["rev-parse", "--git-path", "churn/state.json"])),
      lock: resolve(ctx.location.directory, await git.run(["rev-parse", "--git-common-dir"]), "churn.lock"),
    });
    const report = async (sessionID: string, text: string) => { await ctx.session.synthetic({ sessionID, text: `[Churn] ${text}` }); };

    async function launch(parentID: string, goal?: string) {
      if (unloading) throw new Error("Plugin is unloading");
      if (task) throw new Error("Churn is already running; use /churn-status or /churn-stop");
      current = undefined;
      // Assign the task before the first asynchronous preflight, closing the
      // double-start race within this plugin instance.
      controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(config.maxHours * 3600000)]);
      task = (async () => {
        const p = await paths();
        const release = await lock(p.lock);
        let sleep = async () => {};
        let dispose = async () => {};
        let workers: Workers | undefined;
        let safe = true;
        let saves = Promise.resolve();
        const save = () => {
          const copy = structuredClone(current!);
          const pending = saves.then(() => saveState(p.state, copy));
          saves = pending.catch(() => {});
          return pending;
        };
        try {
          if (!config.checks.length) throw new Error("Configure at least one validation check in the plugin options before starting Churn");
          const previous = await readState(p.state);
          if (goal !== undefined) {
            if (previous && previous.status !== "complete") throw new Error("An unfinished run exists. Use /churn-resume, or finish recovery before starting another task.");
            if (!goal.trim() || goal.length > 128000) throw new Error("Provide a task or plan between 1 and 128000 characters");
            await git.preflight();
            const id = randomUUID();
            const head = await git.head();
            const branch = `churn/${id.slice(0, 8)}`;
            await git.run(["switch", "-c", branch]);
            const now = new Date().toISOString();
            current = { version: 1, id, goal, parentID, base: head, head, branch, status: "running", phase: "starting", reason: "Starting run", calls: 0, createdAt: now, updatedAt: now, slice: null, feedback: "", completed: [], sessions: [], receipts: [], reviews: [] };
          } else {
            if (!previous || previous.status === "complete") throw new Error("No unfinished run to resume");
            current = previous;
            current.parentID = parentID;
            // Recover only our exact journaled commit, never arbitrary HEAD drift.
            if (current.pendingCommit && await git.head() !== current.head) {
              const pending = current.pendingCommit;
              if (await git.run(["rev-parse", "HEAD^"]) !== pending.head || await git.run(["rev-parse", "HEAD^{tree}"]) !== pending.tree || !(await git.run(["log", "-1", "--format=%B"])).includes(`Churn-Run: ${current.id}`)) throw new Error("Unrecognized commit after interruption; inspect Git history");
              current.head = await git.head();
              current.completed.push({ title: pending.title, head: current.head, tree: pending.tree });
              current.slice = null;
              current.feedback = "";
              delete current.pendingCommit;
            }
            await git.identity(current.head, current.branch);
            if (!current.slice) await git.clean();
          }
          const s = current;
          await save();
          const parent = await ctx.session.get({ sessionID: parentID });
          const selected = config.model ?? parent.model;
          if (!selected) throw new Error("Select an OpenCode model, or configure options.model");
          // Pin all role selections for this activation, and fail before writing
          // if a configured provider/model isn't in the current catalog.
          const available = await ctx.catalog.model.list();
          for (const choice of [selected, ...Object.values(config.models), ...config.reviewers.map(r => r.model).filter(r => r !== undefined)]) {
            if (!available.data.some(m => m.providerID === choice.providerID && m.id === choice.id)) throw new Error(`Model unavailable: ${choice.providerID}/${choice.id}`);
          }
          workers = new Workers(ctx, config, s, save, signal, selected);
          // Interrupted old workers must settle before a new writer can start.
          if (goal === undefined) {
            for (const id of s.sessions) { workers.owned.set(id, "reviewer"); workers.active.add(id); }
          }
          dispose = await workers.hooks();
          await workers.stop();
          sleep = await awake(config.keepAwake);
          s.status = "running";
          await save();
          let gate = config.heavyCommand;
          if (!gate.length) {
            const localGate = join(homedir(), ".local/bin/codex-heavy");
            try { await access(localGate); gate = [localGate, "--"]; } catch { /* Optional cross-task gate. Checks still run serially. */ }
          }
          await run({
            state: s, config, signal, save,
            report: text => report(parentID, text),
            worker: (role, prompt, model) => workers!.worker(role, prompt, model),
            snapshot: () => git.snapshot(), diff: () => git.diff(s.base),
            identity: () => git.identity(s.head, s.branch),
            checks: async () => {
              const results = [];
              for (const check of config.checks) {
                signal.throwIfAborted();
                const output = await execute([...gate, ...check.command], git.directory, { signal, timeoutMs: config.checkTimeoutMinutes * 60000 });
                results.push(`${check.name}: PASS\n${output}`);
              }
              return results.join("\n\n");
            },
            commit: (tree, title) => git.commit(tree, s.head, s.branch, title, s.id),
          });
        } catch (error) {
          if (current) { current.status = "paused"; current.reason = signal.aborted ? "Stopped or time budget reached. Partial work is preserved." : String(error); await save(); }
          else await report(parentID, String(error));
        } finally {
          try { await workers?.stop(); } catch (error) {
            safe = false;
            if (current) { current.status = "paused"; current.reason = String(error); await save(); }
          }
          await sleep();
          // Keep restrictions and the repository lock if cleanup is uncertain.
          if (safe) { await dispose(); await release(); }
          if (current) await report(parentID, status(current));
        }
      })().catch(async error => { await report(parentID, String(error)); }).finally(() => { task = undefined; controller = undefined; });
      await report(parentID, "Started in the background. /churn-status shows progress; /churn-stop interrupts workers and preserves partial work.");
    }

    await ctx.command.transform(editor => {
      editor.add({ name: "churn", description: "Implement a task in reviewed, tested commit slices", execute: ({ sessionID, prompt }) => launch(sessionID, prompt.text) });
      editor.add({ name: "churn-file", description: "Run a plan from a repository-relative text file", execute: async ({ sessionID, prompt }) => {
        const root = await realpath(git.directory);
        const file = await realpath(resolve(root, prompt.text.trim()));
        const rel = relative(root, file);
        if (!rel || rel.startsWith("..") || rel.startsWith("/")) throw new Error("Plan file must be inside the current repository");
        await launch(sessionID, await readFile(file, "utf8"));
      } });
      editor.add({ name: "churn-status", description: "Show Churn progress, branch, and stop reason", execute: async ({ sessionID }) => report(sessionID, status(current ?? await readState((await paths()).state))) });
      editor.add({ name: "churn-stop", description: "Stop Churn and preserve all work", execute: async ({ sessionID }) => {
        controller?.abort();
        await report(sessionID, task ? "Stop requested. Waiting for worker and check cleanup; the lock is held until cleanup finishes." : "No active Churn run.");
      } });
      editor.add({ name: "churn-resume", description: "Resume the preserved task with fresh time and call budgets", execute: ({ sessionID }) => launch(sessionID) });
    });
    return async () => { unloading = true; controller?.abort(); await task; };
  },
});
