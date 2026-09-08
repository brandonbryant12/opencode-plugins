import { json, type State } from "./engine.ts";

const cache = new WeakMap<State["outputs"], Map<string, { raw: string; data: Record<string, unknown> }>>();
export function records(s: State) {
  let parsed = cache.get(s.outputs);
  if (!parsed) { parsed = new Map(); cache.set(s.outputs, parsed); }
  for (const key of parsed.keys()) if (!(key in s.outputs)) parsed.delete(key);
  return Object.entries(s.outputs).map(([key, raw]) => {
    let item = parsed!.get(key);
    if (!item || item.raw !== raw) { item = { raw, data: json(raw) }; parsed!.set(key, item); }
    return { key, data: item.data };
  });
}
export function ledger(s: State) {
  const entries = records(s);
  const byKey = new Map(entries.map(e => [e.key, e.data]));
  const first = new Map<string, string>();
  const findings = entries.filter(e => Array.isArray(e.data.findings) && !/^round\/\d+\/meta$/.test(e.key)).flatMap(({ key, data }) => (data.findings as { location: string; problem: string }[]).map((finding, i) => {
    const id = `${key}#${i}`;
    const signature = `${finding.location}\n${finding.problem}`.trim().toLowerCase().replace(/\s+/g, " ");
    const repeatedFrom = first.get(signature) ?? null;
    if (!repeatedFrom) first.set(signature, id);
    let decisionKey = "", decisionID = String(i), verificationPrefix = "";
    const panel = key.match(/^(round\/\d+\/batch\/\d+)\/review\/(\d+)$/);
    const slice = key.match(/^(slice\/\d+)\/review\/(\d+)$/);
    const batch = key.match(/^(round\/\d+\/batch\/\d+)\/verify\/(\d+)$/);
    const sweep = key.match(/^(.*)\/(\d+)\/verify\/(\d+)$/);
    const assessment = key.match(/^(round\/\d+)\/assessment\/(\d+)$/);
    if (panel) { decisionKey = `${panel[1]}/evaluate`; decisionID = `${panel[2]}:${i}`; verificationPrefix = `${panel[1]}/verify/`; }
    else if (slice) { decisionKey = `${slice[1]}/fix/${Number(slice[2]) + 1}`; verificationPrefix = `${slice[1]}/review/`; }
    else if (batch) { decisionKey = `${batch[1]}/fix/${Number(batch[2]) + 1}`; verificationPrefix = `${batch[1]}/verify/`; }
    else if (sweep) { decisionKey = `${sweep[1]}/${sweep[2]}/fix/${sweep[3]}`; verificationPrefix = `${sweep[1]}/${Number(sweep[2]) + 1}/verify/${sweep[3]}`; }
    else if (assessment) { decisionKey = `${assessment[1]}/metafix/${assessment[2]}`; verificationPrefix = `${assessment[1]}/meta`; }
    const decisions = byKey.get(decisionKey)?.decisions as { id: string; action: string; reason: string }[] | undefined;
    const decision = decisions?.find(d => String(d.id) === decisionID) ?? null;
    const verification = verificationPrefix ? entries.findLast(e => (sweep && !batch ? e.key === verificationPrefix : e.key.startsWith(verificationPrefix)) && Array.isArray(e.data.findings) && !e.data.findings.length)?.key ?? null : null;
    return { id, source: key, ...finding, repeatedFrom, decision, verification, outcome: decision ? verification ? decision.action === "fixed" ? "verified-fix" : "verified-rejection" : "pending-verification" : "open" };
  }));
  const coverage = entries.flatMap(({ key, data }) => Array.isArray(data.coverage) ? (data.coverage as { slice: number; status: string; evidence: string }[]).map(c => ({ receipt: key, ...c })) : []);
  return { findings, coverage };
}
function safe(text: string) { return text.replaceAll("<", "&lt;").replaceAll(">", "&gt;"); }
export function reportMarkdown(s: State) {
  const entries = records(s);
  const latest = entries.filter(e => /^round\/\d+\/meta$/.test(e.key)).at(-1);
  const outcomes = ledger(s);
  const lines = [`# ${s.mode === "proposal" ? "Proposal" : "Goal / Swarm"} report`, "", `Status: ${s.status}`, safe(s.reason), "", "## Scope", "", safe(s.goal), "", "## Outcomes", "", latest ? safe(String(latest.data.summary)) : "Assessment pending.", "", `${outcomes.findings.length} finding reports; ${outcomes.findings.filter(f => f.repeatedFrom).length} exact repeats; ${outcomes.findings.filter(f => f.outcome === "verified-fix").length} verified fix decisions.`, "", "Findings are linked by stable receipt IDs. Exact repeats do not identify every semantic duplicate. Verification is agent inspection of source and recorded evidence, not independently executed harness checks.", ""];
  if (latest) for (const key of ["risks", "limitations"]) lines.push(`## ${key}`, "", ...(latest.data[key] as string[]).map(x => `- ${safe(x)}`), "");
  lines.push("## Finding decisions", "");
  for (const f of outcomes.findings) lines.push(`- **${f.outcome}** ${safe(f.location)} — ${safe(f.problem)} (${f.id})${f.decision ? `: ${safe(f.decision.reason)}` : ""}${f.verification ? `; verification: ${f.verification}` : ""}`, "");
  lines.push("## Receipts", "");
  for (const { key } of entries) if (key !== "plan" && !/^round\/\d+\/meta$/.test(key)) lines.push(`- [${key}](receipts/${s.telemetry?.startedAt}-${key.replaceAll("/", "-")}.json)`);
  return lines.join("\n");
}
