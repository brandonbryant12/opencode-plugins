import { focuses, json, review, reviewContract, work, workContract, type Finding, type Role, type Runtime, type Slice } from "./engine.ts";

type Call = <T>(key: string, role: Role, prompt: string, parse: (raw: string) => T) => Promise<T>;
export function coverage(raw: string, ids: number[]): Finding[] {
  const r = json(raw);
  if (!Array.isArray(r.coverage) || r.coverage.length !== ids.length) throw new Error("Explicit coverage required for every assigned slice");
  const remaining = new Set(ids);
  for (const item of r.coverage) {
    if (!item || !remaining.delete(item.slice) || !["checked", "not-applicable"].includes(item.status) || typeof item.evidence !== "string" || !item.evidence.trim()) throw new Error("Invalid or blocked coverage; supply evidence for every slice");
  }
  return review(raw);
}
export function meta(raw: string, known: string[]) {
  const r = json(raw);
  for (const key of ["summary", "nextFocus"]) if (typeof r[key] !== "string" || !r[key].trim() || r[key].length > 4000) throw new Error(`Meta report needs ${key}`);
  if (!Array.isArray(r.assignments) || r.assignments.length !== 3 || !r.assignments.every(v => typeof v === "string" && v.trim() && v.length <= 2000)) throw new Error("Meta report needs three focused assignments");
  for (const key of ["risks", "limitations"]) if (!Array.isArray(r[key]) || r[key].length > 20 || !r[key].every(v => typeof v === "string" && v.length <= 2000)) throw new Error(`Meta report needs ${key}`);
  if (!Array.isArray(r.evidenceRefs) || !r.evidenceRefs.length || r.evidenceRefs.length > 30 || !r.evidenceRefs.every(v => typeof v === "string" && known.includes(v))) throw new Error("Meta report must cite existing receipts");
  review(raw);
  return r;
}
const lenses = ["Trace contracts, requirements and cross-slice dependencies", "Attempt to falsify claims with counterexamples and concrete failure cases", "Find omissions, weak evidence and a smaller sufficient design"];

export async function swarm(r: Runtime, slices: Slice[], call: Call) {
  const s = r.state;
  // Bounded payloads; the source and prior receipts remain available on disk.
  const groups: { slice: number; spec: Slice }[][] = [];
  let group: typeof groups[number] = [];
  let size = 0;
  for (const [i, spec] of slices.entries()) {
    const n = JSON.stringify(spec).length;
    if (group.length && (group.length === 5 || size + n > 12000)) { groups.push(group); group = []; size = 0; }
    group.push({ slice: i + 1, spec }); size += n;
  }
  if (group.length) groups.push(group);
  async function acceptance(label: string) {
    // Recheck every batch after the last mutation; repairs restart the sweep.
      for (let attempt = 0; ; attempt++) {
        const failed: { index: number; findings: Finding[] }[] = [];
        for (const [index, batch] of groups.entries()) {
          const ids = batch.map(x => x.slice);
          const findings = await call(`${label}/${attempt}/verify/${index + 1}`, "verifier", `Final acceptance after ALL round edits. Independently inspect these slices and their cross-slice contracts against the original goal:\n${JSON.stringify(batch)}\nRead relevant saved findings, decisions and evidence. ${reviewContract} Include explicit coverage for exactly these IDs: ${JSON.stringify(ids)} using {"slice":number,"status":"checked or not-applicable","evidence":"observed source or validation evidence"}.`, raw => coverage(raw, ids));
          if (findings.length) failed.push({ index, findings });
        }
        if (!failed.length) break;
        if (attempt === 3) {
          for (const key of Object.keys(s.outputs)) if (key.startsWith(`${label}/${attempt}/`)) delete s.outputs[key];
          await r.save(); throw new Error("Final acceptance still has findings after three repair sweeps");
        }
        for (const { index, findings } of failed) await call(`${label}/${attempt}/fix/${index + 1}`, "evaluator", `Repair final acceptance findings for ${JSON.stringify(groups[index])}. A fresh full sweep follows your edits. Findings: ${JSON.stringify(findings)}\n${workContract}`, raw => work(raw, findings));
      }
  }
  for (let round = 1; round <= 10; round++) {
    for (const [index, batch] of groups.entries()) {
      const base = `round/${round}/batch/${index + 1}`;
      const ids = batch.map(x => x.slice);
      const evidenceFiles = Object.keys(s.outputs).filter(k => ids.some(id => k === `slice/${id}/implement` || k.startsWith(`slice/${id}/fix/`))).map(k => `.opencode/goal/receipts/${s.telemetry?.startedAt ?? "*"}-${k.replaceAll("/", "-")}.json`);
      const context = `Round ${round}/10: ${focuses[round - 1]}. Assigned slices:\n${JSON.stringify(batch)}\nInspect dependencies beyond these slices as needed. Implementation/check receipts: ${JSON.stringify(evidenceFiles)}. Read relevant receipts to assess the actual checks; do not infer exact bytes or trailing newlines from line-numbered file previews. Previous meta guidance: ${round > 1 ? json(s.outputs[`round/${round - 1}/meta`]).nextFocus : "Establish a baseline and expose assumptions"}.`;
      const contract = `${reviewContract} Also include "coverage":[{"slice":number,"status":"checked or not-applicable","evidence":"specific paths, observations or reason this lens does not apply"}] for exactly these IDs: ${JSON.stringify(ids)}. Missing or blocked evidence cannot pass. Proposal reviews assess the design and its assumptions; do not claim planned behavior is implemented.`;
      const reports: Finding[][] = [];
      for (let start = 0; start < 3; start += r.concurrency) {
        const results = await Promise.allSettled(lenses.slice(start, start + r.concurrency).map((lens, offset) => call(`${base}/review/${start + offset + 1}`, "reviewer", `${context}\nIndependent method: ${lens}. Targeted assignment: ${round > 1 ? (json(s.outputs[`round/${round - 1}/meta`]).assignments as string[])[start + offset] : "Establish evidence for your method"}. Do not read other reviewers' verdicts before forming yours.\n${contract}`, raw => coverage(raw, ids))));
        const failure = results.find(x => x.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
        reports.push(...results.map(x => (x as PromiseFulfilledResult<Finding[]>).value));
      }
      const findings = reports.flatMap((xs, reviewer) => xs.map(f => ({ ...f, id: `${reviewer + 1}:${f.id}` })));
      await call(`${base}/evaluate`, "evaluator", `${context}\nAdjudicate all findings, deduplicate without dropping decisions, and make justified corrections only. No issue quota or gratuitous churn.\nFindings:\n${JSON.stringify(findings)}\n${workContract}`, raw => work(raw, findings));
      for (let attempt = 0; ; attempt++) {
        const evidence = s.outputs[`${base}/${attempt ? `fix/${attempt}` : "evaluate"}`];
        const unresolved = await call(`${base}/verify/${attempt}`, "verifier", `${context}\nIndependently inspect the latest files and challenge the evaluator's fixes AND rejections. Check original findings against current evidence.\nOriginal findings: ${JSON.stringify(findings)}\nWork report: ${evidence}\n${contract}`, raw => coverage(raw, ids));
        if (!unresolved.length) break;
        if (attempt === 3) {
          // A manual correction followed by resume must get a fresh verdict.
          delete s.outputs[`${base}/verify/${attempt}`]; await r.save();
          throw new Error(`${base} still has findings after three verified repair attempts`);
        }
        await call(`${base}/fix/${attempt + 1}`, "evaluator", `${context}\nIndependent verification found:\n${JSON.stringify(unresolved)}\n${workContract}`, raw => work(raw, unresolved));
      }
    }
    if (round === 10) await acceptance("final");
    if (!s.outputs[`round/${round}/meta`]) for (let attempt = 0; ; attempt++) {
      const key = `round/${round}/assessment/${attempt}`;
      const known = Object.keys(s.outputs).filter(k => k.startsWith(`round/${round}/`) || (round === 10 && k.startsWith("final/")));
      const assessment = await call(key, "meta", `Round ${round}/10 covers ${slices.length} slices in ${groups.length} batches. Read this round's receipts matching .opencode/goal/receipts/${s.telemetry?.startedAt ?? "*"}-round-${round}-*.json using bounded reads. Prioritize evaluator/verifier receipts, tracing issues to reviews. On round ten inspect final acceptance receipts too. Assess convergence, repeated failures, weak evidence, and integration risks. Concrete defects or missing REQUIRED proof must be findings, not limitations. All ten rounds are mandatory even when the goal is small or no findings remain. Return exactly three nonempty assignment strings; never an empty assignments array. For rounds 1–9, target the next theme (${focuses[round] ?? "final acceptance"}); in round ten, record three possible follow-up checks. If a theme seems inapplicable, assign concrete checks of that assumption without inventing defects. You cannot edit files, change counts, skip rounds, or certify unrun checks. Return only JSON: {"summary":"evidence-backed outcomes","nextFocus":"targeted investigation","assignments":["contract reviewer task","counterexample reviewer task","evidence reviewer task"],"evidenceRefs":["existing receipt key"],"findings":[{"location":"source or acceptance item","problem":"concrete unresolved defect or required proof gap"}],"risks":["non-blocking risks"],"limitations":["non-required proof not established"]}. Available receipt keys: ${JSON.stringify(known)}.`, raw => meta(raw, known));
      const findings = review(s.outputs[key]);
      if (!findings.length) {
        s.outputs[`round/${round}/meta`] = JSON.stringify(assessment); await r.save(); break;
      }
      if (attempt === 3) { delete s.outputs[key]; await r.save(); throw new Error(`Round ${round} meta assessment still has findings after three repairs`); }
      await call(`round/${round}/metafix/${attempt}`, "evaluator", `The meta assessment identified unresolved defects or required proof gaps. Inspect the original objective and relevant slices, and account for every finding: ${JSON.stringify(findings)}\n${workContract}`, raw => work(raw, findings));
      await acceptance(`round/${round}/metaverify/${attempt}`);
    }
  }
}
