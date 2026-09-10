import { swarm } from "./swarm.ts";
export type Slice = { title: string; task: string; acceptance: string[] };
export type Finding = { id: string; location: string; problem: string };
export type Role = "planner" | "implementer" | "reviewer" | "evaluator" | "verifier" | "meta";
export type WorkerStats = { role: Role; phase: string; startedAt: number; activity?: string; activityAt?: number; input?: number; output?: number; cost?: number };
export type State = {
  version: 2; mode?: "goal" | "swarm" | "proposal"; proposalPath?: string; goal: string; status: "running" | "paused" | "complete";
  phase: string; reason: string; outputs: Record<string, string>; active: string[];
  telemetry?: { parentID: string; startedAt: number; updatedAt: number; workers: Record<string, WorkerStats> };
};
export interface Runtime {
  state: State;
  concurrency: number;
  signal: AbortSignal;
  save(): Promise<void>;
  worker(role: Role, task: string, phase?: string): Promise<string>;
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
  const trimmed = raw.trim();
  // Some native models add prose around the requested fenced report. Accept
  // one explicit JSON block; never guess between multiple candidate reports.
  const blocks = [...trimmed.matchAll(/```(?:json)?[\t ]*\r?\n([\s\S]*?)\r?\n```/g)];
  if (blocks.length > 1) throw new Error("Return one JSON report, not multiple blocks");
  return object(JSON.parse(blocks.length === 1 ? blocks[0][1] : trimmed));
}
export function plan(raw: string): Slice[] {
  const p = json(raw);
  if (!Array.isArray(p.slices) || !p.slices.length || p.slices.length > 120) throw new Error("Plan needs 1–120 slices");
  return p.slices.map(value => {
    const s = object(value);
    if (!Array.isArray(s.acceptance) || !s.acceptance.length) throw new Error("Every slice needs acceptance criteria");
    const slice = { title: text(s.title), task: text(s.task), acceptance: s.acceptance.map(text) };
    if (slice.title.length > 200 || JSON.stringify(slice).length > 6000) throw new Error("Keep each slice under 6000 characters with a short title");
    return slice;
  });
}
export function review(raw: string): Finding[] {
  const r = json(raw);
  if (r.blocked !== undefined && (!Array.isArray(r.blocked) || r.blocked.length)) throw new Error("Review reported blocked evidence");
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
  {
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

export const workContract = `Return only JSON: {"summary":"concise changes and evidence","checks":[{"command":"check actually performed","result":"pass","evidence":"observed result"}],"blocked":[],"decisions":[]}. When findings are supplied, replace decisions with exactly one {"id":"supplied finding id","action":"fixed or rejected","reason":"evidence"} per finding. With no supplied findings, decisions MUST be empty. Report failures honestly in blocked; never mark an unrun check pass. Reject unsupported or out-of-scope findings with evidence. Run relevant checks after edits, following repository resource limits. No changes are required when the goal already holds.`;
export const reviewContract = `Return only JSON: {"findings":[{"location":"slice title and file:line","problem":"concrete defect, evidence and smallest correction"}]}. Empty findings is valid. Read files, trace behavior, and check available validation evidence. Stay within the original goal. Do not manufacture issues or request speculative abstractions. Do not edit files or execute shell commands.`;

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
    const raw = await r.worker(role, `${key === "plan" ? `Mode: ${s.mode ?? "goal"}. ${s.mode === "proposal" ? `Source proposal: ${s.proposalPath}. Catalog its design sections; do not implement software.` : ""}\nOriginal goal:\n${s.goal}` : `Original objective is saved in .opencode/goal/objective.md (read only if needed). Mode: ${s.mode ?? "goal"}. ${s.mode === "proposal" ? `Only improve the proposal ${s.proposalPath}; do not implement the proposed software.` : ""}`}\n\n${prompt}`, key);
    r.signal.throwIfAborted();
    let result: T;
    try { result = parse(raw); }
    catch (error) { s.phase = key; throw new Error(`The ${role} report did not pass validation: ${error instanceof Error ? error.message : String(error)}. Inspect the last worker, then resume to retry unfinished work.`); }
    s.outputs[key] = JSON.stringify(json(raw));
    await r.save();
    return result;
  }
  const slices = await call("plan", "planner", 'Read project instructions and relevant code. Turn the goal or supplied document into an ordered, bounded plan of at most 120 concise slices; preserve all requirements. In swarm mode catalog existing work; in proposal mode catalog design sections and decision criteria, not implementation tasks. Preserve explicit requirements and dependencies. Prefer few small slices; do not expand scope. Return only JSON: {"slices":[{"title":"short title","task":"what to implement and relevant paths","acceptance":["observable result"]}]}. Do not edit files.', plan);
  if (!s.mode || s.mode === "goal") for (let i = 0; i < slices.length; i++) {
    const context = `Current slice ${i + 1}/${slices.length}:\n${JSON.stringify(slices[i])}\nEarlier slice titles: ${slices.slice(0, i).map(s => s.title).join("; ")}`;
    await call(`slice/${i + 1}/implement`, "implementer", `${context}\nImplement this slice only. Inspect existing partial edits before continuing. ${workContract}`, work);
    for (let attempt = 0; ; attempt++) {
      const findings = await call(`slice/${i + 1}/review/${attempt}`, "reviewer", `${context}\nImplementation evidence:\n${s.outputs[`slice/${i + 1}/${attempt ? `fix/${attempt}` : "implement"}`]}\n${reviewContract}`, review);
      if (!findings.length) break;
      if (attempt >= 3) { delete s.outputs[`slice/${i + 1}/review/${attempt}`]; await r.save(); throw new Error(`Slice ${i + 1} still has findings after three fixes. Inspect the worker sessions.`); }
      await call(`slice/${i + 1}/fix/${attempt + 1}`, "evaluator", `${context}\nEvaluate these findings and make justified corrections:\n${JSON.stringify(findings)}\n${workContract}`, raw => work(raw, findings));
    }
  }
  await swarm(r, slices, call);
  s.status = "complete";
  s.reason = "Ten rounds completed with explicit coverage, independent verification, and meta reports. See .opencode/goal/report.md for evidence and limitations.";
  await r.save();
}
