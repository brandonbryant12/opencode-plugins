import { Plugin } from "@opencode-ai/plugin/tui";
import { createSignal, For, Show } from "solid-js";
import { bar, elapsed, type Progress } from "./progress.ts";
import { GoalRPC } from "./rpc.ts";

type ViewProps = { context: Plugin.Context; progress: Progress; now: number; error?: string; open?: () => void; control?: (action: "stop" | "resume") => Promise<void> };
const count = (n: number) => n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`;
const color = (p: ViewProps) => p.error || p.progress.status === "paused" ? p.context.theme.text.feedback.warning.default : p.progress.status === "complete" ? p.context.theme.text.feedback.success.default : p.context.theme.text.status.running;

export function GoalBanner(p: ViewProps) {
  return <box flexDirection="column" paddingX={1} marginBottom={1} border={["left"]} borderColor={color(p)} onMouseDown={() => p.open ? p.open() : p.context.ui.panel.open("goal.progress")}>
    <text fg={color(p)}><b>{p.progress.mode.toUpperCase()} · {p.error ? "STATUS UNAVAILABLE" : p.progress.status.toUpperCase()}</b><span style={{ fg: p.context.theme.text.subdued }}>  Open progress · /goal-panel</span></text>
    <Show when={p.progress.status !== "complete"}>
      <text fg={p.context.theme.text.default}>{p.error ?? (p.progress.status === "paused" || p.progress.status === "stopping" ? p.progress.message : p.progress.phase)}</text>
      <text fg={p.context.theme.text.subdued}>{p.progress.slices.length ? `Slices ${bar(p.progress.slices.filter(s => s.done).length, p.progress.slices.length, 10)} ${p.progress.slices.filter(s => s.done).length}/${p.progress.slices.length}   Rounds ${p.progress.rounds.filter(r => r.done).length}/10` : "Reading the goal and planning slices…"}</text>
    </Show>
  </box>;
}

export function GoalPanel(p: ViewProps) {
  const t = p.context.theme;
  const [selected, setSelected] = createSignal<{ key: string; text: string; startedAt: number | null }>();
  const [pending, setPending] = createSignal(false);
  const [controlError, setControlError] = createSignal<string>();
  async function control(action: "stop" | "resume") {
    if (pending() || p.error || !p.control) return;
    setPending(true); setControlError(undefined);
    try { await p.control(action); }
    catch { setControlError("Control did not confirm. Refresh progress before trying again."); }
    finally { setPending(false); }
  }
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
  return <box flexGrow={1} flexDirection="column" paddingX={2} paddingY={1}>
    <box flexDirection="column" flexShrink={0} paddingBottom={1}>
      <text fg={color(p)}><b>{p.progress.mode.toUpperCase()} · {p.error ? "STATUS UNAVAILABLE" : p.progress.status.toUpperCase()}</b></text>
      <text fg={t.text.default}>{p.progress.title}</text>
      <text fg={t.text.subdued}>{p.progress.phase}</text>
      <Show when={p.error}><text fg={t.text.feedback.warning.default}>{p.error}</text></Show>
      <Show when={p.progress.status === "paused" || p.progress.status === "stopping"}><text fg={t.text.feedback.warning.default}>{p.progress.message}</text></Show>
      <Show when={!p.error && (p.progress.status === "running" || p.progress.status === "paused")}>
        <text fg={t.text.status.running} onMouseDown={() => { void control(p.progress.status === "running" ? "stop" : "resume"); }}><b>{pending() ? "Applying control…" : p.progress.status === "running" ? "[ Stop run ]" : "[ Resume run ]"}</b></text>
      </Show>
      <Show when={p.progress.status === "stopping"}><text fg={t.text.subdued}>Waiting for workers to stop. Partial work is preserved.</text></Show>
      <Show when={controlError()}><text fg={t.text.feedback.warning.default}>{controlError()}</text></Show>
      <Show when={p.progress.status === "paused" && p.progress.lastWorker}><text fg={t.text.status.running} onMouseDown={() => p.context.ui.router.navigate({ type: "session", sessionID: p.progress.lastWorker! })}>[ Inspect last worker ]</text></Show>
    </box>
    <scrollbox flexGrow={1} minHeight={0}>
    <box flexDirection="column" gap={1}>
      <Show when={p.progress.active.length}>
        <box flexDirection="column">
          <text fg={t.text.default}><b>CURRENT WORK · CLICK TO INSPECT</b></text>
          <For each={p.progress.active}>{agent => <box flexDirection="column" onMouseDown={() => p.context.ui.router.navigate({ type: "session", sessionID: agent.id })}><text fg={t.text.status.running}>› {agent.phase} · {elapsed(agent.startedAt, p.now)}</text><text fg={t.text.subdued}>{agent.activity ?? "Worker is active"}{agent.activityAt ? ` · ${elapsed(agent.activityAt, p.now)} ago` : ""}</text></box>}</For>
        </box>
      </Show>
      <Show when={selected()?.startedAt === p.progress.startedAt ? selected() : undefined}>{receipt => <box flexDirection="column" border={["left"]} paddingLeft={1} borderColor={t.text.status.running}><text fg={t.text.default}><b>EVIDENCE · {receipt().key}</b></text><text fg={t.text.default}>{receipt().text}</text><text fg={t.text.subdued} onMouseDown={() => { selection++; setSelected(undefined); }}>Close evidence ×</text></box>}</Show>
      <box flexDirection="column">
        <text fg={t.text.status.running}>Slices  {bar(p.progress.slices.filter(s => s.done).length, p.progress.slices.length, 8)} {p.progress.slices.filter(s => s.done).length}/{p.progress.slices.length || "?"}</text>
        <text fg={t.text.status.running}>Rounds  {bar(p.progress.rounds.filter(r => r.done).length, 10, 8)} {p.progress.rounds.filter(r => r.done).length}/10</text>
      </box>
      <box flexDirection="column">
        <text fg={t.text.default}>{duration()} elapsed · {p.progress.tasks} tasks done</text>
        <text fg={t.text.subdued}>{p.progress.reviews} reviews · {p.progress.fixes} repair passes · {p.progress.active.length} active</text>
        <text fg={t.text.subdued}>{p.progress.usageAvailable ? `${count(p.progress.input)} input / ${count(p.progress.output)} output tokens · $${p.progress.cost.toFixed(4)}` : "Usage unavailable or updating"}</text>
        <text fg={t.text.subdued}>Cost reported by OpenCode; may exclude provider charges.</text>
      </box>
      <text fg={t.text.subdued}>{p.progress.verifications} verified batches · {p.progress.fixed} fix decisions · {p.progress.rejected} rejected</text>
      <Show when={p.progress.meta}>{m => <box flexDirection="column"><text fg={t.text.default}><b>META ASSESSMENT</b></text><text fg={t.text.default}>{String(m().summary)}</text><text fg={t.text.subdued}>Next: {String(m().nextFocus)}</text><For each={m().risks as string[]}>{risk => <text fg={t.text.feedback.warning.default}>Risk: {risk}</text>}</For><For each={m().limitations as string[]}>{limit => <text fg={t.text.subdued}>Limit: {limit}</text>}</For></box>}</Show>
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
    </box>
    </scrollbox>
    <text flexShrink={0} fg={t.text.subdued}>/goal-stop · /goal-resume · f fullscreen · esc close</text>
  </box>;
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
    let locationKey = "";
    function open() {
      const p = snapshot();
      const route = context.ui.router.current();
      if (p?.parentID && (route.type !== "session" || route.sessionID !== p.parentID)) context.ui.router.navigate({ type: "session", sessionID: p.parentID });
      context.ui.panel.open("goal.progress");
      void refresh();
    }
    async function control(action: "stop" | "resume") {
      const p = snapshot();
      if (!p?.parentID || p.startedAt === null || error()) return;
      const session = context.data.session.get(p.parentID) ?? await context.client.session.get({ sessionID: p.parentID });
      const result = await rpc.control({ action, startedAt: p.startedAt, parentID: p.parentID }, { location: session.location, signal: AbortSignal.timeout(10000) }) as { message: string };
      context.ui.toast.show({ title: "Goal / Swarm", message: result.message, duration: 5000 });
      await refresh();
    }
    async function refresh() {
      if (busy || controller.signal.aborted) return;
      const route = context.ui.router.current();
      if (route.type !== "session" && route.type !== "home") return;
      busy = true;
      try {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(4000)]);
        const location = route.type === "session" ? (context.data.session.get(route.sessionID) ?? await context.client.session.get({ sessionID: route.sessionID }, { signal })).location : context.location ?? context.data.location.default();
        const key = `${location.directory}:${location.workspaceID ?? ""}`;
        if (key !== locationKey) { locationKey = key; setSnapshot(null); setError(undefined); }
        const result = await rpc.progress(null, { location, signal }) as { progress: Progress | null };
        const current = context.ui.router.current();
        if (controller.signal.aborted || current.type !== route.type || (current.type === "session" && route.type === "session" && current.sessionID !== route.sessionID)) return;
        setSnapshot(result.progress); setError(undefined);
        const p = result.progress;
        const openKey = p && `${p.parentID}:${p.startedAt}:${p.status === "paused" ? `paused:${p.updatedAt}` : "run"}`;
        if (p && p.status !== "complete" && route.type === "session" && p.parentID === route.sessionID && openKey && !memory.opened.includes(openKey) && context.ui.panel.open("goal.progress")) updateMemory(draft => { draft.opened = [...draft.opened.slice(-19), openKey]; });
      } catch {
        if (!controller.signal.aborted) setError("Progress connection unavailable. Work may still be active. Reconnecting… Use /goal-status or /goal-stop.");
      } finally { busy = false; }
    }
    const timer = setInterval(() => { setNow(Date.now()); void refresh(); }, 1500);
    void refresh();
    const unregister = [
      rpc.events.on("notice", event => {
        const route = context.ui.router.current();
        const notice = event.data as { sessionID: string; parentID: string | null; message: string; open: boolean };
        // A notice from another chat must not move this user's focus.
        if (route.type !== "session" || route.sessionID !== notice.sessionID) return;
        context.ui.toast.show({ title: "Goal / Swarm", message: notice.message, duration: 6000 });
        if (notice.open) {
          if (notice.parentID && notice.parentID !== route.sessionID) context.ui.router.navigate({ type: "session", sessionID: notice.parentID });
          context.ui.panel.open("goal.progress");
        }
        void refresh();
      }),
      context.ui.slot({ append: "app", render: () => {
        context.keymap.layer(() => ({ commands: [{ id: "goal.panel", title: "Show Goal / Swarm progress", group: "Goal", palette: true, run: open }] }));
        return null;
      } }),
      context.ui.slot({ append: "home.footer", render: () => <Show when={snapshot()} fallback={<Show when={error()}><text fg={context.theme.text.feedback.warning.default} onMouseDown={open}>Progress connection unavailable · /goal-panel</text></Show>}>{s => <text fg={context.theme.text.status.running} onMouseDown={open}>{s().mode.toUpperCase()} · {error() ? "UNAVAILABLE" : s().status.toUpperCase()} · /goal-panel</text>}</Show> }),
      context.ui.slot({ append: "session.composer.top", render: () => <Show when={snapshot()} fallback={<Show when={error()}><text fg={context.theme.text.feedback.warning.default} onMouseDown={open}>{error()} · /goal-panel</text></Show>}>{s => <GoalBanner context={context} progress={s()} now={now()} error={error()} open={open} />}</Show> }),
      context.ui.slot({ append: "session.panel", render: panel => {
        context.keymap.layer(() => ({ enabled: () => panel.name === "goal.progress" && panel.focused, commands: [{ bind: "f", run: panel.toggleFullscreen }, { bind: "escape", run: panel.close }] }));
        return <Show when={panel.name === "goal.progress"}><Show when={snapshot()} fallback={<text fg={context.theme.text.feedback.warning.default}>{error() ?? "No saved run. Use /goal <outcome>, /swarm <scope>, or /swarm --proposal @file."}</text>}>{s => <GoalPanel context={context} progress={s()} now={now()} error={error()} control={control} />}</Show></Show>;
      } }),
    ];
    return () => { controller.abort(); clearInterval(timer); unregister.reverse().forEach(dispose => dispose()); };
  },
});
