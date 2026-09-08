import { records } from "./reports.ts";
import { focuses, plan, type State } from "./engine.ts";
import type { SessionInfo } from "@opencode-ai/client";

export function usage(info: SessionInfo) {
  return { input: info.tokens.input, output: info.tokens.output, cost: info.cost };
}
export function phaseLabel(phase: string) {
  if (phase === "plan") return "Planning slices";
  const batch = phase.match(/^round\/(\d+)\/batch\/(\d+)\/(review|evaluate|verify|fix)(?:\/(\d+))?$/);
  const verbs: Record<string, string> = { implement: "Implementing", fix: "Repairing", evaluate: "Evaluating", review: "Reviewing", verify: "Verifying", meta: "Assessing progress", assessment: "Assessing progress", metafix: "Repairing meta findings" };
  if (batch) return `${verbs[batch[3]]} round ${batch[1]} · batch ${batch[2]}${batch[3] === "review" ? ` · reviewer ${batch[4]}/3` : ""}`;
  const final = phase.match(/^final\/(\d+)\/(verify|fix)\/(\d+)$/);
  if (final) return `${verbs[final[2]]} final acceptance · sweep ${Number(final[1]) + 1} · batch ${final[3]}`;
  const [, kind, n, action] = phase.match(/^(slice|round)\/(\d+)\/(\w+)(?:\/(\d+))?$/) ?? [];
  return kind ? `${verbs[action] ?? action} ${kind} ${n}` : phase;
}
export function progress(state: State | undefined, live: SessionInfo[] = [], running = false) {
  if (!state) return null;
  const outputs = state.outputs;
  const entries = records(state);
  const keys = entries.map(e => e.key);
  const byKey = new Map(entries.map(e => [e.key, e.data]));
  const coverageFor = (slice: number) => keys.filter(key => key.startsWith("round/") && key.includes("/verify/") && (byKey.get(key)?.findings as unknown[] | undefined)?.length === 0 && (byKey.get(key)?.coverage as { slice: number }[] | undefined)?.some(c => c.slice === slice));
  const slices = outputs.plan ? plan(outputs.plan).map((slice, i) => ({
    title: slice.title,
    verifiedRounds: new Set(coverageFor(i + 1).map(k => k.split("/")[1])).size,
    receipts: Array.from({ length: 10 }, (_, round) => coverageFor(i + 1).findLast(k => k.startsWith(`round/${round + 1}/`)) ?? null),
    done: (state.mode === "swarm" || state.mode === "proposal") ? new Set(coverageFor(i + 1).map(k => k.split("/")[1])).size >= 10 : keys.some(key => key.startsWith(`slice/${i + 1}/review/`) && (byKey.get(key)?.findings as unknown[] | undefined)?.length === 0),
    active: state.active.some(id => state.telemetry?.workers[id]?.phase.startsWith(`slice/${i + 1}/`)),
  })) : [];
  const rounds = focuses.map((focus, i) => ({
    focus, done: outputs[`round/${i + 1}/meta`] !== undefined,
    reviews: keys.filter(k => k.startsWith(`round/${i + 1}/`) && k.includes("/review/")).length,
  }));
  const workers = { ...state.telemetry?.workers };
  for (const session of live) if (workers[session.id]) workers[session.id] = { ...workers[session.id], ...usage(session) };
  const stats = Object.values(workers);
  const status = state.status === "running" && !running ? "paused" : state.status;
  return {
    mode: state.mode ?? "goal",
    meta: keys.filter(k => k.endsWith("/meta")).map(k => byKey.get(k)!).at(-1),
    verifications: keys.filter(k => k.includes("/verify/") && (byKey.get(k)?.findings as unknown[] | undefined)?.length === 0).length,
    fixed: keys.filter(k => k.endsWith("/evaluate") || k.includes("/fix/") || k.includes("/metafix/")).flatMap(k => (byKey.get(k)!.decisions ?? []) as { action: string }[]).filter(d => d.action === "fixed").length,
    rejected: keys.filter(k => k.endsWith("/evaluate") || k.includes("/fix/") || k.includes("/metafix/")).flatMap(k => (byKey.get(k)!.decisions ?? []) as { action: string }[]).filter(d => d.action === "rejected").length,
    parentID: state.telemetry?.parentID ?? null,
    title: state.goal.trim().split("\n")[0].slice(0, 120), status,
    phase: phaseLabel(state.phase), slices, rounds,
    tasks: keys.filter(k => !/^round\/\d+\/meta$/.test(k)).length,
    reviews: keys.filter(key => key.includes("/review/")).length,
    fixes: keys.filter(key => key.includes("/fix/") || key.includes("/metafix/")).length,
    active: state.active.map(id => ({ id, ...workers[id], phase: phaseLabel(workers[id]?.phase ?? state.phase) })),
    startedAt: state.telemetry?.startedAt ?? null,
    updatedAt: state.telemetry?.updatedAt ?? null,
    input: stats.reduce((sum, s) => sum + (s.input ?? 0), 0),
    output: stats.reduce((sum, s) => sum + (s.output ?? 0), 0),
    cost: stats.reduce((sum, s) => sum + (s.cost ?? 0), 0),
    usageAvailable: !!state.telemetry && stats.every(s => s.cost !== undefined),
    message: !running && state.status === "running" ? "Run is not active. Use /goal-resume to continue." : state.reason.slice(0, 600),
  };
}
export type Progress = NonNullable<ReturnType<typeof progress>>;
export function bar(done: number, total: number, width = 16) {
  const filled = total ? Math.max(0, Math.min(width, Math.floor(done / total * width))) : 0;
  return "█".repeat(filled) + "░".repeat(width - filled);
}
export function elapsed(start: number | null | undefined, end: number) {
  if (start == null) return "—";
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
}
