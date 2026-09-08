import { Plugin } from "@opencode-ai/plugin/tui";
import { createSignal, For, Show } from "solid-js";
import { bar, elapsed, type Progress } from "./progress.ts";
import { GoalRPC } from "./rpc.ts";

type ViewProps = { context: Plugin.Context; progress: Progress; now: number; error?: string };
const count = (n: number) => n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`;
const color = (p: ViewProps) => p.error || p.progress.status === "paused" ? p.context.theme.text.feedback.warning.default : p.progress.status === "complete" ? p.context.theme.text.feedback.success.default : p.context.theme.text.status.running;

export function GoalBanner(p: ViewProps) {
  return <box flexDirection="column" paddingX={1} marginBottom={1} border={["left"]} borderColor={color(p)} onMouseDown={() => p.context.ui.panel.open("goal.progress")}>
    <text fg={color(p)}><b>{p.progress.mode.toUpperCase()} · {p.error ? "STATUS UNAVAILABLE" : p.progress.status.toUpperCase()}</b><span style={{ fg: p.context.theme.text.subdued }}>  /goal-panel</span></text>
    <Show when={p.progress.status !== "complete"}>
      <text fg={p.context.theme.text.default}>{p.progress.phase}</text>
      <text fg={p.context.theme.text.subdued}>{p.progress.slices.length ? `Slices ${bar(p.progress.slices.filter(s => s.done).length, p.progress.slices.length, 10)} ${p.progress.slices.filter(s => s.done).length}/${p.progress.slices.length}   Rounds ${p.progress.rounds.filter(r => r.done).length}/10` : "Reading the goal and planning slices…"}</text>
    </Show>
  </box>;
}

export function GoalPanel(p: ViewProps) {
  const t = p.context.theme;
  const [selected, setSelected] = createSignal<{ key: string; text: string; startedAt: number | null }>();
  let selection = 0;
  async function showReceipt(key: string) {
    const request = ++selection;
    const startedAt = p.progress.startedAt;
    setSelected({ key, startedAt, text: "Loading evidence…" });
    try {
      const session = p.context.data.session.get(p.progress.parentID!) ?? await p.context.client.session.get({ sessionID: p.progress.parentID! });
      const result = await p.context.client.rpc(GoalRPC).receipt({ key, startedAt }, { location: session.location, signal: AbortSignal.timeout(4000) }) as { receipt: string | null };
      if (request === selection) setSelected({ key, startedAt, text: result.receipt ? JSON.stringify(JSON.parse(result.receipt), null, 2) : "Receipt is no longer available for this run." });
    } catch { if (request === selection) setSelected({ key, startedAt, text: "Could not load evidence. Click the coverage mark to retry." }); }
  }
  const duration = () => elapsed(p.progress.startedAt, p.progress.status === "running" && !p.error ? p.now : p.progress.updatedAt ?? p.now);
  return <scrollbox flexGrow={1} paddingX={2} paddingY={1}>
    <box flexDirection="column" gap={1}>
      <text fg={color(p)}><b>{p.progress.mode.toUpperCase()} · {p.error ? "STATUS UNAVAILABLE" : p.progress.status.toUpperCase()}</b></text>
      <text fg={t.text.default}>{p.progress.title}</text>
      <Show when={p.error}><text fg={t.text.feedback.warning.default}>{p.error}</text></Show>
      <text fg={t.text.default}>{p.progress.phase}</text>
      <Show when={p.progress.status === "paused"}><text fg={t.text.feedback.warning.default}>{p.progress.message}</text></Show>
      <Show when={selected()?.startedAt === p.progress.startedAt ? selected() : undefined}>{receipt => <box flexDirection="column" border={["left"]} paddingLeft={1} borderColor={t.text.status.running}><text fg={t.text.default}><b>EVIDENCE · {receipt().key}</b></text><text fg={t.text.default}>{receipt().text}</text><text fg={t.text.subdued} onMouseDown={() => { selection++; setSelected(undefined); }}>Close evidence ×</text></box>}</Show>
      <box flexDirection="column">
        <text fg={t.text.status.running}>Slices  {bar(p.progress.slices.filter(s => s.done).length, p.progress.slices.length)} {p.progress.slices.filter(s => s.done).length}/{p.progress.slices.length || "?"}</text>
        <text fg={t.text.status.running}>Rounds  {bar(p.progress.rounds.filter(r => r.done).length, 10)} {p.progress.rounds.filter(r => r.done).length}/10</text>
      </box>
      <box flexDirection="column">
        <text fg={t.text.default}>{duration()} elapsed · {p.progress.tasks} tasks done</text>
        <text fg={t.text.subdued}>{p.progress.reviews} reviews · {p.progress.fixes} repair passes · {p.progress.active.length} active</text>
        <text fg={t.text.subdued}>{p.progress.usageAvailable ? `${count(p.progress.input)} input / ${count(p.progress.output)} output tokens · $${p.progress.cost.toFixed(4)}` : "Usage unavailable or updating"}</text>
        <text fg={t.text.subdued}>Cost reported by OpenCode; may exclude provider charges.</text>
      </box>
      <text fg={t.text.subdued}>{p.progress.verifications} verified batches · {p.progress.fixed} fix decisions · {p.progress.rejected} rejected</text>
      <Show when={p.progress.meta}>{m => <box flexDirection="column"><text fg={t.text.default}><b>META ASSESSMENT</b></text><text fg={t.text.default}>{String(m().summary)}</text><text fg={t.text.subdued}>Next: {String(m().nextFocus)}</text><For each={m().risks as string[]}>{risk => <text fg={t.text.feedback.warning.default}>Risk: {risk}</text>}</For><For each={m().limitations as string[]}>{limit => <text fg={t.text.subdued}>Limit: {limit}</text>}</For></box>}</Show>
      <Show when={p.progress.active.length}>
        <box flexDirection="column">
          <text fg={t.text.default}><b>ACTIVE AGENTS</b></text>
          <For each={p.progress.active}>{agent => <text fg={t.text.status.running} onMouseDown={() => p.context.ui.router.navigate({ type: "session", sessionID: agent.id })}>› {agent.phase} · {elapsed(agent.startedAt, p.now)}</text>}</For>
          <text fg={t.text.subdued}>Click an agent to open its session.</text>
        </box>
      </Show>
      <box flexDirection="column">
        <text fg={t.text.default}><b>PLAN · CLICK COVERAGE FOR EVIDENCE</b></text>
        <Show when={p.progress.slices.length} fallback={<text fg={t.text.subdued}>Planner is preparing the slices…</text>}>
          <For each={p.progress.slices}>{(slice, i) => <box flexDirection="column"><text fg={slice.done ? t.text.feedback.success.default : slice.active ? t.text.status.running : t.text.subdued}>{slice.done ? "✓" : slice.active ? "›" : "○"} {i() + 1}. {slice.title}</text><box flexDirection="row"><text fg={t.text.subdued}>   </text><For each={slice.receipts}>{(key, n) => <text fg={key ? t.text.feedback.success.default : t.text.subdued} onMouseDown={() => { if (key) void showReceipt(key); }}>{key ? "●" : "·"}{n() === 9 ? "" : " "}</text>}</For><text fg={t.text.subdued}> {slice.verifiedRounds}/10</text></box></box>}</For>
        </Show>
      </box>
      <box flexDirection="column">
        <text fg={t.text.default}><b>REVIEW ROUNDS</b></text>
        <For each={p.progress.rounds}>{(round, i) => <text fg={round.done ? t.text.feedback.success.default : t.text.subdued}>{round.done ? "✓" : "○"} {i() + 1}. {round.focus}{round.done ? "" : ` · ${round.reviews} reviews`}</text>}</For>
      </box>
      <Show when={p.progress.status !== "running"}><text fg={t.text.default}>{p.progress.message}</text></Show>
      <text fg={t.text.subdued}>/goal-stop · /goal-resume · f fullscreen · esc close</text>
    </box>
  </scrollbox>;
}

export default Plugin.define({
  id: "goal.tui",
  setup(context) {
    const rpc = context.client.rpc(GoalRPC);
    const [snapshot, setSnapshot] = createSignal<Progress | null>(null);
    const [error, setError] = createSignal<string>();
    const [now, setNow] = createSignal(Date.now());
    const [memory, updateMemory] = context.storage.memory("auto-open", { initial: { opened: [] as string[] } });
    const controller = new AbortController();
    let busy = false;
    const relevant = (sessionID: string) => snapshot()?.parentID === sessionID ? snapshot() : null;
    async function refresh() {
      if (busy || controller.signal.aborted) return;
      const route = context.ui.router.current();
      if (route.type !== "session") return;
      busy = true;
      try {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(4000)]);
        const session = context.data.session.get(route.sessionID) ?? await context.client.session.get({ sessionID: route.sessionID }, { signal });
        const result = await rpc.progress(null, { location: session.location, signal }) as { progress: Progress | null };
        const current = context.ui.router.current();
        if (controller.signal.aborted || current.type !== "session" || current.sessionID !== route.sessionID) return;
        setSnapshot(result.progress); setError(undefined);
        const p = result.progress;
        const key = p && `${p.parentID}:${p.startedAt}`;
        if (p?.status === "running" && p.parentID === route.sessionID && key && !memory.opened.includes(key) && context.ui.panel.open("goal.progress")) updateMemory(draft => { draft.opened = [...draft.opened.slice(-19), key]; });
      } catch {
        if (!controller.signal.aborted) setError("Cannot refresh progress. Showing the last update; reconnecting…");
      } finally { busy = false; }
    }
    const timer = setInterval(() => { setNow(Date.now()); void refresh(); }, 1500);
    void refresh();
    const unregister = [
      context.ui.slot({ append: "app", render: () => {
        context.keymap.layer(() => ({ commands: [{ id: "goal.panel", title: "Show goal progress", group: "Goal", palette: true, slash: { name: "goal-panel" }, run: () => { context.ui.panel.open("goal.progress"); void refresh(); } }] }));
        return null;
      } }),
      context.ui.slot({ append: "session.composer.top", render: p => <Show when={relevant(p.sessionID)}>{s => <GoalBanner context={context} progress={s()} now={now()} error={error()} />}</Show> }),
      context.ui.slot({ append: "session.panel", render: panel => {
        context.keymap.layer(() => ({ enabled: () => panel.name === "goal.progress", commands: [{ bind: "f", run: panel.toggleFullscreen }, { bind: "escape", run: panel.close }] }));
        return <Show when={panel.name === "goal.progress"}><Show when={relevant(panel.sessionID)} fallback={<text>No goal for this session. Start with /goal.</text>}>{s => <GoalPanel context={context} progress={s()} now={now()} error={error()} />}</Show></Show>;
      } }),
    ];
    return () => { controller.abort(); clearInterval(timer); unregister.reverse().forEach(dispose => dispose()); };
  },
});
