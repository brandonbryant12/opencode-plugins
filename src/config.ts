export const lenses = {
  correctness: "Trace requirements, contracts, edge cases, and regressions. Cite concrete counterexamples.",
  security: "Check authorization, data exposure, unsafe inputs, trust boundaries, and dependency risks.",
  recovery: "Trace cancellation, retries, partial failure, crashes, concurrency, and durable state.",
  validation: "Check that tests prove behavior and failure paths, are isolated, and cover acceptance criteria.",
  performance: "Find material resource, latency, and scaling problems. Avoid speculative optimization.",
  simplicity: "Remove unnecessary abstractions, duplicated state, scope creep, and clever code. Prefer the smallest clear solution.",
};

export type Model = { providerID: string; id: string; variant?: string };
export type Check = { name: string; command: string[] };
export type Config = {
  model?: Model;
  models: Partial<Record<"planner" | "builder" | "reviewer", Model>>;
  reviewers: { name: string; focus: string; model?: Model }[];
  concurrency: number;
  maxCalls: number;
  maxSlices: number;
  maxFixRounds: number;
  cleanAudits: number;
  maxHours: number;
  workerTimeoutMinutes: number;
  checkTimeoutMinutes: number;
  maxDiffBytes: number;
  steps: number;
  keepAwake: boolean;
  checks: Check[];
  heavyCommand: string[];
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an options object");
  return value as Record<string, unknown>;
}
export function model(value: unknown): Model {
  if (typeof value !== "string" || !/^[^/\s]+\/[^\s#]+(?:#[^\s#]+)?$/.test(value))
    throw new Error("Model must be provider/model, optionally #variant");
  const slash = value.indexOf("/");
  const [id, variant] = value.slice(slash + 1).split("#");
  return { providerID: value.slice(0, slash), id, ...(variant ? { variant } : {}) };
}
function argv(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every(v => typeof v === "string" && v.length > 0 && !v.includes("\0")))
    throw new Error("Commands must be nonempty arrays of arguments, not shell strings");
  return value;
}
export function configure(input: unknown): Config {
  const o = object(input);
  const known = new Set(["model", "models", "reviewers", "concurrency", "maxCalls", "maxSlices", "maxFixRounds", "cleanAudits", "maxHours", "workerTimeoutMinutes", "checkTimeoutMinutes", "maxDiffBytes", "steps", "keepAwake", "checks", "heavyCommand"]);
  for (const key of Object.keys(o)) if (!known.has(key)) throw new Error(`Unknown churn option: ${key}`);
  function number(key: string, fallback: number, min: number, max: number) {
    const n = o[key] ?? fallback;
    if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) throw new Error(`${key} must be an integer between ${min} and ${max}`);
    return n;
  }
  const models: Config["models"] = {};
  for (const [key, value] of Object.entries(object(o.models ?? {}))) {
    if (!["planner", "builder", "reviewer"].includes(key)) throw new Error(`Unknown model role: ${key}`);
    models[key as keyof typeof models] = model(value);
  }
  let reviewers = Object.entries(lenses).map(([name, focus]) => ({ name, focus })) as Config["reviewers"];
  if (o.reviewers !== undefined) {
    if (!Array.isArray(o.reviewers) || o.reviewers.length < 1 || o.reviewers.length > 50) throw new Error("Use 1–50 reviewers");
    reviewers = o.reviewers.map(value => {
      const r = object(value);
      if (typeof r.name !== "string" || !/^[a-z][a-z0-9-]{0,49}$/.test(r.name)) throw new Error("Invalid reviewer name");
      const focus = r.focus ?? lenses[r.name as keyof typeof lenses];
      if (typeof focus !== "string" || !focus.trim()) throw new Error(`Reviewer ${r.name} needs a focus`);
      return { name: r.name, focus, ...(r.model ? { model: model(r.model) } : {}) };
    });
    if (new Set(reviewers.map(r => r.name)).size !== reviewers.length) throw new Error("Reviewer names must be unique");
    // Simplicity is an acceptance gate, even with a custom review panel.
    if (!reviewers.some(r => r.name === "simplicity")) reviewers.push({ name: "simplicity", focus: lenses.simplicity });
  }
  if (o.keepAwake !== undefined && typeof o.keepAwake !== "boolean") throw new Error("keepAwake must be boolean");
  if (o.checks !== undefined && !Array.isArray(o.checks)) throw new Error("checks must be an array");
  const checks = ((o.checks ?? []) as unknown[]).map(value => {
    const c = object(value);
    if (typeof c.name !== "string" || !c.name.trim()) throw new Error("Each check needs a name");
    return { name: c.name, command: argv(c.command) };
  });
  return {
    ...(o.model ? { model: model(o.model) } : {}), models, reviewers, checks,
    concurrency: number("concurrency", 2, 1, 8), maxCalls: number("maxCalls", 256, 1, 10000),
    maxSlices: number("maxSlices", 30, 1, 1000), maxFixRounds: number("maxFixRounds", 5, 1, 30),
    cleanAudits: number("cleanAudits", 2, 1, 10), maxHours: number("maxHours", 8, 1, 168),
    workerTimeoutMinutes: number("workerTimeoutMinutes", 20, 1, 180), checkTimeoutMinutes: number("checkTimeoutMinutes", 20, 1, 180),
    maxDiffBytes: number("maxDiffBytes", 300000, 1000, 2000000), steps: number("steps", 40, 5, 200),
    keepAwake: o.keepAwake !== false,
    heavyCommand: o.heavyCommand === undefined ? [] : argv(o.heavyCommand),
  };
}
