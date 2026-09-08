export type Slice = { title: string; task: string; acceptance: string[] };
export type Finding = { id: string; location: string; problem: string };
export type Role = "planner" | "implementer" | "reviewer" | "evaluator";
export type State = {
  version: 2; goal: string; status: "running" | "paused" | "complete";
  phase: string; reason: string; outputs: Record<string, string>; active: string[];
};
export interface Runtime {
  state: State;
  concurrency: number;
  signal: AbortSignal;
  save(): Promise<void>;
  worker(role: Role, task: string): Promise<string>;
  report(text: string): Promise<void>;
}

export const focuses = [
  "Requirements and missing behavior",
  "Correctness and edge cases",
  "Integration and API contracts",
  "Failure handling and recovery",
  "Security and data privacy",
  "Concurrency and state consistency",
  "Performance and resource use",
  "Tests and validation gaps",
  "Simplicity and maintainability",
  "Final acceptance and regressions",
];
const perspectives = ["Trace normal execution and contracts", "Challenge assumptions with concrete failure cases", "Look for omissions and the smallest simpler solution"];

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object");
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 8000) throw new Error("Expected nonempty text of at most 8000 characters");
  return value;
}
export function json(raw: string): Record<string, unknown> {
  if (raw.length > 32000) throw new Error("Worker report exceeds 32000 characters; keep reports concise");
  return object(JSON.parse(raw.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, "$1")));
}
export function plan(raw: string): Slice[] {
  const p = json(raw);
  if (!Array.isArray(p.slices) || !p.slices.length || p.slices.length > 30) throw new Error("Plan needs 1–30 slices");
  return p.slices.map(value => {
    const s = object(value);
    if (!Array.isArray(s.acceptance) || !s.acceptance.length) throw new Error("Every slice needs acceptance criteria");
    return { title: text(s.title), task: text(s.task), acceptance: s.acceptance.map(text) };
  });
}
export function review(raw: string): Finding[] {
  const r = json(raw);
  if (!Array.isArray(r.findings) || r.findings.length > 20) throw new Error("Review needs at most 20 findings");
  return r.findings.map((value, i) => {
    const f = object(value);
    return { id: String(i), location: text(f.location), problem: text(f.problem) };
  });
}
export function work(raw: string, findings: Finding[] = []): string {
  const r = json(raw);
  const summary = text(r.summary);
  if (!Array.isArray(r.blocked) || r.blocked.length) throw new Error(`Worker blocked: ${JSON.stringify(r.blocked ?? "missing blocked field")}`);
  if (!Array.isArray(r.checks) || !r.checks.length) throw new Error("Worker must supply validation evidence");
  for (const value of r.checks) {
    const check = object(value);
    text(check.command); text(check.evidence);
    if (check.result !== "pass") throw new Error(`Validation did not pass: ${check.command}`);
  }
  if (findings.length) {
    if (!Array.isArray(r.decisions) || r.decisions.length !== findings.length) throw new Error("Account for every finding exactly once");
    const remaining = new Set(findings.map(f => f.id));
    for (const value of r.decisions) {
      const d = object(value);
      if (!remaining.delete(String(d.id)) || !["fixed", "rejected"].includes(String(d.action))) throw new Error("Invalid finding decision");
      text(d.reason);
    }
  }
  return summary;
}

export const workContract = `Return only JSON: {"summary":"concise changes and evidence","checks":[{"command":"check actually performed","result":"pass","evidence":"observed result"}],"blocked":[],"decisions":[{"id":"finding id","action":"fixed or rejected","reason":"evidence"}]}. Report failures honestly in blocked; never mark an unrun check pass. Account for each supplied finding once. Reject unsupported or out-of-scope findings with evidence. Run relevant checks after edits, following repository resource limits. No changes are required when the goal already holds.`;
const reviewContract = `Return only JSON: {"findings":[{"location":"slice title and file:line","problem":"concrete defect, evidence and smallest correction"}]}. Empty findings is valid. Read files, trace behavior, and check available validation evidence. Stay within the original goal. Do not manufacture issues or request speculative abstractions. Do not edit files or execute shell commands.`;

// Every worker starts fresh. Only the plan and relevant reports cross sessions.
// Saved successful outputs are checkpoints; errors never become successes.
export async function run(r: Runtime) {
  const s = r.state;
  async function call<T>(key: string, role: Role, prompt: string, parse: (raw: string) => T): Promise<T> {
    r.signal.throwIfAborted();
    if (s.outputs[key] !== undefined) return parse(s.outputs[key]);
    s.phase = key;
    await r.save();
    await r.report(key);
    const raw = await r.worker(role, `Original goal:\n${s.goal}\n\n${prompt}`);
    r.signal.throwIfAborted();
    const result = parse(raw);
    s.outputs[key] = raw;
    await r.save();
    return result;
  }
  const slices = await call("plan", "planner", 'Read project instructions and relevant code. Turn the goal or supplied document into an ordered, bounded plan. Preserve explicit requirements and dependencies. Prefer few small slices; do not expand scope. Return only JSON: {"slices":[{"title":"short title","task":"what to implement and relevant paths","acceptance":["observable result"]}]}. Do not edit files.', plan);
  for (let i = 0; i < slices.length; i++) {
    const context = `Current slice ${i + 1}/${slices.length}:\n${JSON.stringify(slices[i])}\nEarlier slice titles: ${slices.slice(0, i).map(s => s.title).join("; ")}`;
    await call(`slice/${i + 1}/implement`, "implementer", `${context}\nImplement this slice only. Inspect existing partial edits before continuing. ${workContract}`, work);
    for (let attempt = 0; ; attempt++) {
      const findings = await call(`slice/${i + 1}/review/${attempt}`, "reviewer", `${context}\nImplementation evidence:\n${s.outputs[`slice/${i + 1}/${attempt ? `fix/${attempt}` : "implement"}`]}\n${reviewContract}`, review);
      if (!findings.length) break;
      if (attempt >= 3) throw new Error(`Slice ${i + 1} still has findings after three fixes. Inspect the worker sessions.`);
      await call(`slice/${i + 1}/fix/${attempt + 1}`, "evaluator", `${context}\nEvaluate these findings and make justified corrections:\n${JSON.stringify(findings)}\n${workContract}`, raw => work(raw, findings));
    }
  }
  for (let round = 0; round < focuses.length; round++) {
    const evidence = round ? s.outputs[`round/${round}/evaluate`] : s.outputs[`slice/${slices.length}/implement`];
    const context = `Review round ${round + 1}/10: ${focuses[round]}. Walk through EVERY slice in order, then check their integration:\n${JSON.stringify(slices)}\nLatest available work report (verify its claims against current code):\n${evidence}`;
    const reports: Finding[][] = [];
    // Settle every reader before admitting the fourth, writing agent.
    for (let start = 0; start < 3; start += r.concurrency) {
      const batch = await Promise.allSettled(perspectives.slice(start, start + r.concurrency).map((perspective, offset) =>
        call(`round/${round + 1}/review/${start + offset + 1}`, "reviewer", `${context}\nYour independent perspective: ${perspective}.\n${reviewContract}`, review)));
      const failure = batch.find(result => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
      reports.push(...batch.map(result => (result as PromiseFulfilledResult<Finding[]>).value));
    }
    const findings = reports.flatMap((report, reviewer) => report.map(f => ({ ...f, id: `${reviewer + 1}:${f.id}` })));
    await call(`round/${round + 1}/evaluate`, "evaluator", `${context}\nYou are the fourth agent. Evaluate all three independent reviews, deduplicate their findings, reject unsupported suggestions, and implement the smallest justified improvements. Verify the original goal and all acceptance criteria, including when there are no findings.\nFindings:\n${JSON.stringify(findings)}\n${workContract}`, raw => work(raw, findings));
  }
  s.status = "complete";
  s.reason = `All slices reviewed; ten review/evaluation rounds finished with reported passing checks.\n${work(s.outputs["round/10/evaluate"])}`;
  await r.save();
}
