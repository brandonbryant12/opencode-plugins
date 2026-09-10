import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { testRender } from "@opentui/solid";
import { DEFAULT_THEME, resolveThemeDocument } from "@opencode-ai/theme/tui";
import type { Plugin } from "@opencode-ai/plugin/tui";
import tui, { GoalBanner, GoalPanel } from "../src/tui.tsx";
import { progress } from "../src/progress.ts";
import type { State } from "../src/engine.ts";

const startedAt = Date.now() - 92000;
const state: State = {
  version: 2, goal: "Add orders pagination", status: "running", phase: "slice/2/implement", reason: "Working",
  outputs: { plan: JSON.stringify({ slices: ["Keep filters in the URL", "Add cursor pagination", "Cover empty and last pages"].map(title => ({ title, task: title, acceptance: ["Works"] })) }), "slice/1/implement": '{"summary":"Done","decisions":[]}' , "slice/1/review/0": '{"findings":[]}' },
  active: ["worker"], telemetry: { parentID: "parent", startedAt, updatedAt: Date.now(), workers: { worker: { role: "implementer", phase: "slice/2/implement", startedAt: startedAt + 50000, input: 12345, output: 2345, cost: 0.1234 } } },
};
state.outputs["round/1/batch/1/verify/0"] = JSON.stringify({findings:[],coverage:[{slice:1,status:"checked",evidence:"Cursor proof 123"}]});
const snapshot = progress(state, [], true)!;
const theme = resolveThemeDocument(DEFAULT_THEME);
let opens = 0;
let receiptRequests = 0;
let requestedLocation: unknown;
let resolveProgress: ((value: unknown) => void) | undefined;
let rejectProgress: ((error: unknown) => void) | undefined;
let notice: ((event: { data: unknown }) => void) | undefined;
let route: { type: "session"; sessionID: string } | { type: "home" } = { type: "session", sessionID: "parent" };
let stopClicks = 0;
let resumeClicks = 0;
const memory = { opened: [] as string[] };
const slots = new Map<string, (input: any) => any>();
const context = {
  theme,
  location: { directory: "/test-project" },
  storage: { memory: () => [memory, (fn: (draft: typeof memory) => void) => fn(memory)] },
  client: { rpc: () => ({ events: { on: (_name: string, handler: typeof notice) => { notice = handler; return () => {}; } }, receipt: async (input: {key:string}, options: {location:{directory:string}}) => { receiptRequests++; assert.equal(options.location.directory,"/test-project"); return {receipt:state.outputs[input.key]}; }, progress: async (_input: unknown, options: unknown) => { requestedLocation = options; return new Promise((resolve, reject) => { resolveProgress = resolve; rejectProgress = reject; }); } }) },
  data: { session: { get: () => ({ location: { directory: "/test-project" } }) } },
  keymap: { layer: () => {} },
  ui: { toast: { show: () => {} }, slot: (claim: { append: string; render: (input: any) => any }) => { slots.set(claim.append, claim.render); return () => {}; }, router: { current: () => route, navigate: (next: typeof route) => { route = next; } }, panel: { open: () => { opens++; return true; } } },
} as unknown as Plugin.Context;
const cleanup = await tui.setup(context);
try {
  resolveProgress!({ progress: snapshot });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(opens, 1, "An active goal must automatically open its panel");
  assert.equal((requestedLocation as { location: { directory: string } }).location.directory, "/test-project");
  await new Promise(resolve => setTimeout(resolve, 1600));
  resolveProgress!({ progress: snapshot });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(opens, 1, "A dismissed panel must not keep reopening");
  notice!({ data: { sessionID: "parent", parentID: "parent", message: "Already active", open: true } });
  assert.equal(opens, 2, "Repeating a start explicitly reopens existing progress");
  resolveProgress!({ progress: { ...snapshot, status: "paused", message: "Check failed" } });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(opens, 3, "A paused run automatically shows its reason and recovery");
  route = { type: "home" };
  await new Promise(resolve => setTimeout(resolve, 1600));
  resolveProgress!({ progress: snapshot });
  await new Promise(resolve => setTimeout(resolve, 0));
  const home = await testRender(() => slots.get("home.footer")!({}), { width: 80, height: 8 });
  try { await home.renderOnce(); assert.match(home.captureCharFrame(), /GOAL · RUNNING · \/goal-panel/); } finally { home.renderer.destroy(); }
} finally { await cleanup?.(); }

// A failed first fetch must still render a visible warning without a snapshot.
const failedCleanup = await tui.setup(context);
try {
  rejectProgress!(new Error("RPC unavailable"));
  await new Promise(resolve => setTimeout(resolve, 0));
  const failed = await testRender(() => slots.get("home.footer")!({}), { width: 80, height: 8 });
  try { await failed.renderOnce(); assert.match(failed.captureCharFrame(), /Progress connection unavailable/); } finally { failed.renderer.destroy(); }
} finally { await failedCleanup?.(); }

const output = process.env.GOAL_TUI_CAPTURE;
if (output) await mkdir(output, { recursive: true });
for (const [name, width, height] of [["wide", 64, 42], ["narrow", 32, 28]] as const) {
  const setup = await testRender(() => <GoalPanel context={context} progress={snapshot} now={Date.now()} control={async action => { if (action === "stop") stopClicks++; }} />, { width, height });
  try {
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    assert.match(frame, /GOAL/); assert.match(frame, /RUNNING/); assert.match(frame, /Slices/); assert.match(frame, /Rounds.*0\/10/); assert.match(frame, /tokens/);
    if (output) await writeFile(`${output}/${name}.txt`, frame);
    const stopRows = frame.split("\n"), stopY = stopRows.findIndex(row => row.includes("Stop run"));
    assert.ok(stopY >= 0, "Stop remains visible in a narrow panel");
    await setup.mockMouse.click(stopRows[stopY].indexOf("Stop run"), stopY);
    await new Promise(resolve => setTimeout(resolve, 0));
    if (name === "wide") {
      const rows = frame.split("\n"), y = rows.findIndex(row => row.includes("●")), x = rows[y].indexOf("●");
      await setup.mockMouse.click(x, y);
      await new Promise(resolve => setTimeout(resolve, 0));
      await setup.renderOnce();
      assert.equal(receiptRequests, 1, "Coverage click requests one receipt");
      assert.match(setup.captureCharFrame(), /Cursor proof 123/);
    }
  } finally { setup.renderer.destroy(); }
}
assert.equal(stopClicks, 2);
const pausedPanel = await testRender(() => <GoalPanel context={context} progress={{ ...snapshot, status: "paused", message: "A required check failed" }} now={Date.now()} control={async action => { if (action === "resume") resumeClicks++; }} />, { width: 44, height: 24 });
try {
  await pausedPanel.renderOnce(); const frame = pausedPanel.captureCharFrame();
  assert.match(frame, /A required check failed/);
  const rows = frame.split("\n"), y = rows.findIndex(row => row.includes("Resume run"));
  await pausedPanel.mockMouse.click(rows[y].indexOf("Resume run"), y);
  await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(resumeClicks, 1);
} finally { pausedPanel.renderer.destroy(); }
const banner = await testRender(() => <GoalBanner context={context} progress={snapshot} now={Date.now()} />, { width: 58, height: 7 });
try {
  await banner.renderOnce();
  const frame = banner.captureCharFrame();
  assert.match(frame, /goal-panel/); assert.match(frame, /1\/3/);
  if (output) await writeFile(`${output}/banner.txt`, frame);
} finally { banner.renderer.destroy(); }
console.log("TUI passed: active/paused opening, repeat-start recovery, home discovery, initial RPC failure, Stop/Resume clicks, remote location, evidence, narrow/wide layout.");
