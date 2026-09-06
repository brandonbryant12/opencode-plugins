import type { Config, Model } from "./config.ts";
import { plan, review, plannerContract, reviewerContract } from "./protocol.ts";
import type { State } from "./state.ts";

export interface Runtime {
  state: State;
  config: Config;
  signal: AbortSignal;
  save(): Promise<void>;
  report(text: string): Promise<void>;
  worker(role: "planner" | "builder" | "reviewer", prompt: string, model?: Model): Promise<string>;
  snapshot(): Promise<{ tree: string; diff: string }>;
  diff(): Promise<string>;
  identity(): Promise<void>;
  checks(): Promise<string>;
  commit(tree: string, title: string): Promise<string>;
}

// Bound active work, not the number of review perspectives. Always settle the
// current batch before moving on, including when one reviewer fails.
export async function pool<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let start = 0; start < items.length; start += limit) {
    const batch = await Promise.allSettled(items.slice(start, start + limit).map(work));
    const failure = batch.find(r => r.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    results.push(...batch.map(r => (r as PromiseFulfilledResult<R>).value));
  }
  return results;
}

export async function run(runtime: Runtime) {
  const { state: s, config: c, signal } = runtime;
  let slices = 0;
  let cleanAudits = 0;
  const goal = () => `Original goal (keep scope bounded):\n${s.goal}\n\nCompleted slices:\n${JSON.stringify(s.completed)}\n\nOutstanding feedback:\n${s.feedback}`;
  const phase = async (name: string) => {
    signal.throwIfAborted();
    s.phase = name;
    s.reason = s.slice?.title ?? "Evaluating the original goal";
    await runtime.save();
    await runtime.report(`${name}: ${s.reason}`);
    await runtime.identity();
  };
  async function panel(scope: string, tree: string, diff: string, checks: string): Promise<string> {
    const verdicts = await pool(c.reviewers, c.concurrency, async reviewer => {
      signal.throwIfAborted();
      const result = review(await runtime.worker("reviewer", `${goal()}\nReview scope: ${scope}\nYour lens: ${reviewer.focus}\n${reviewerContract}\nAcceptance: ${JSON.stringify(s.slice?.acceptance ?? ["Original goal fully satisfied"])}\nValidation evidence:\n${checks}\nExact candidate tree: ${tree}\nDiff:\n${diff}`, reviewer.model));
      s.reviews.push({ scope, tree, reviewer: reviewer.name, review: result });
      await runtime.save();
      return { reviewer: reviewer.name, ...result };
    });
    await runtime.identity();
    if ((await runtime.snapshot()).tree !== tree) throw new Error("Files changed during read-only review; verdicts discarded");
    return verdicts.some(v => v.verdict === "revise") ? JSON.stringify(verdicts.filter(v => v.verdict === "revise")) : "";
  }
  while (true) {
    signal.throwIfAborted();
    if (!s.slice) {
      await phase("plan");
      const before = await runtime.snapshot();
      const next = plan(await runtime.worker("planner", `${goal()}\nInspect the repository. Select the next small useful slice, or declare the goal satisfied with evidence.\n${plannerContract}`));
      if ((await runtime.snapshot()).tree !== before.tree) throw new Error("Planner changed files");
      if (next.done) {
        await phase("final audit");
        const checks = await runtime.checks();
        if ((await runtime.snapshot()).tree !== before.tree) throw new Error("Validation changed tracked or untracked files");
        s.feedback = await panel("entire task", before.tree, await runtime.diff(), checks);
        if (s.feedback) { cleanAudits = 0; await runtime.save(); continue; }
        cleanAudits++;
        if (cleanAudits < c.cleanAudits) continue;
        s.status = "complete";
        s.phase = "complete";
        s.reason = `Goal satisfied; ${c.cleanAudits} consecutive independent final audits and configured checks passed.`;
        await runtime.save();
        return;
      }
      s.slice = next.slice;
      cleanAudits = 0;
      await runtime.save();
    }
    if (slices >= c.maxSlices) throw new Error("Slice budget reached; resume to grant a new run budget");
    let committed = false;
    for (let attempt = 0; attempt < c.maxFixRounds; attempt++) {
      await phase(attempt ? "fix" : "build");
      const slice = s.slice!;
      await runtime.worker("builder", `${goal()}\nImplement only this slice:\n${JSON.stringify(slice)}\nYou are the only writer. Inspect existing partial edits before continuing. Follow repository instructions. Prefer simple direct code and meaningful focused tests. Do not change the goal, create commits, or edit Churn configuration. Shell tools are unavailable; the runner executes configured validation commands. Finish with a concise summary of edits and any blocker.`);
      await runtime.identity();
      const candidate = await runtime.snapshot();
      if (!candidate.diff.trim()) throw new Error("Builder made no changes; inspect the worker report before resuming");
      await phase("check");
      let checks: string;
      try { checks = await runtime.checks(); }
      catch (e) { signal.throwIfAborted(); s.feedback = `Configured validation failed:\n${String(e)}`; await runtime.save(); continue; }
      if ((await runtime.snapshot()).tree !== candidate.tree) throw new Error("Checks changed files; inspect before resuming");
      await phase("review");
      s.feedback = await panel(slice.title, candidate.tree, candidate.diff, checks);
      if (s.feedback) { await runtime.save(); continue; }
      signal.throwIfAborted();
      await phase("commit");
      s.pendingCommit = { head: s.head, tree: candidate.tree, title: slice.title };
      await runtime.save();
      s.head = await runtime.commit(candidate.tree, slice.title);
      s.completed.push({ title: slice.title, head: s.head, tree: candidate.tree });
      s.slice = null;
      s.feedback = "";
      delete s.pendingCommit;
      await runtime.save();
      await runtime.report(`Committed ${s.head.slice(0, 8)}: ${slice.title}`);
      slices++;
      committed = true;
      break;
    }
    if (!committed) throw new Error("Review/fix limit reached without convergence; partial work and all findings are preserved. Inspect, then resume.");
  }
}
