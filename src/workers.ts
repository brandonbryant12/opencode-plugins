import type { Plugin } from "@opencode-ai/plugin";
import type { Config, Model } from "./config.ts";
import type { State } from "./state.ts";

export type Role = "planner" | "builder" | "reviewer";
const reads = new Set(["read", "glob", "grep"]);
const edits = new Set(["edit", "write", "multiedit", "apply_patch", "patch"]);
// V2 exposes most tools through its confined Code Mode dispatcher. The hook
// also runs for each nested call, where the actual read/edit policy is applied.
export function allowedTool(role: Role, tool: string) { return tool === "execute" || reads.has(tool) || (role === "builder" && edits.has(tool)); }

export function finalText(messages: Awaited<ReturnType<Plugin.Context["session"]["context"]>>): string {
  const last = messages.findLast(m => m.type === "assistant");
  if (!last || last.type !== "assistant" || !last.time.completed || last.error || last.finish !== "stop")
    throw new Error("Worker did not produce a complete, successful final answer");
  const text = last.content.filter(p => p.type === "text").map(p => p.text).join("\n").trim();
  if (!text) throw new Error("Worker returned no text");
  return text;
}

export class Workers {
  readonly owned = new Map<string, Role>();
  readonly active = new Set<string>();
  calls = 0;
  readonly ctx: Plugin.Context;
  readonly config: Config;
  readonly state: State;
  readonly save: () => Promise<void>;
  readonly signal: AbortSignal;
  readonly defaultModel: Model;
  constructor(ctx: Plugin.Context, config: Config, state: State, save: () => Promise<void>, signal: AbortSignal, defaultModel: Model) {
    this.ctx = ctx; this.config = config; this.state = state; this.save = save; this.signal = signal; this.defaultModel = defaultModel;
  }

  async hooks() {
    const registrations: { dispose(): Promise<void> }[] = [];
    registrations.push(await this.ctx.session.hook("model.request", async event => {
      if (!this.owned.has(event.sessionID)) return;
      this.signal.throwIfAborted();
      if (this.calls >= this.config.maxCalls) throw new Error("Model-request budget reached; resume to grant a new budget");
      this.calls++;
      this.state.calls++;
      await this.save();
    }));
    registrations.push(await this.ctx.session.hook("context", event => {
      const role = this.owned.get(event.sessionID);
      if (!role) return;
      for (const key of Object.keys(event.tools)) if (!allowedTool(role, key)) delete event.tools[key];
    }));
    registrations.push(await this.ctx.tool.hook("execute.before", event => {
      const role = this.owned.get(event.sessionID);
      if (role && !allowedTool(role, event.tool)) throw new Error(`Churn ${role} cannot use ${event.tool}`);
    }));
    registrations.push(await this.ctx.permission.hook("evaluate", event => {
      const role = this.owned.get(event.sessionID);
      if (!role) return;
      // Only reduce permissions; never turn an existing ask/deny into allow.
      if (!(event.action === "execute" || reads.has(event.action) || (role === "builder" && event.action === "edit"))) event.effect = "deny";
      if (event.action === "edit" && event.resources.some(path => /(^|[\\/])(\.git|\.opencode)([\\/]|$)|(^|[\\/])opencode\.jsonc?$/.test(path))) event.effect = "deny";
    }));
    return async () => { for (const registration of registrations.reverse()) await registration.dispose(); };
  }

  async worker(role: Role, prompt: string, override?: Model): Promise<string> {
    this.signal.throwIfAborted();
    if (this.calls >= this.config.maxCalls) throw new Error("Model-request budget reached; resume to grant a new budget");
    const model = override ?? this.config.models[role] ?? this.config.model ?? this.defaultModel;
    // Create is awaited without cancellation so its resulting ID cannot be lost
    // when a stop races creation. No prompt is admitted before ownership is saved.
    const session = await this.ctx.session.create({
      title: `Churn ${role} · ${this.state.slice?.title ?? "goal audit"}`,
      agent: "churn-worker", model, location: { directory: this.ctx.location.directory, ...(this.ctx.location.workspaceID ? { workspaceID: this.ctx.location.workspaceID } : {}) },
      metadata: { churnRun: this.state.id, churnRole: role, churnParent: this.state.parentID },
    });
    const sessionID = session.id;
    this.owned.set(sessionID, role);
    this.active.add(sessionID);
    this.state.sessions.push(sessionID);
    await this.save();
    const signal = AbortSignal.any([this.signal, AbortSignal.timeout(this.config.workerTimeoutMinutes * 60000)]);
    signal.throwIfAborted();
    await this.ctx.session.prompt({ sessionID, text: `You are the Churn ${role} worker in an unattended plan loop. Stay inside the stated goal. You have ${this.config.steps} model steps at most. Read project instructions. You may only ${role === "builder" ? "read and edit project files" : "read project files"}. No shells, network tools, nested agents, commits, or external actions.\n\n${prompt}` }, { signal });
    await this.ctx.session.wait({ sessionID }, { signal });
    const info = await this.ctx.session.get({ sessionID }, { signal });
    if (info.outcome !== "succeeded") throw new Error(`Worker ${sessionID} ended with outcome ${info.outcome ?? "unknown"}`);
    const text = finalText(await this.ctx.session.context({ sessionID }, { signal }));
    this.active.delete(sessionID);
    this.state.receipts.push({ role, sessionID, model: `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}`, text });
    await this.save();
    return text;
  }

  async stop() {
    const results = await Promise.allSettled([...this.active].map(async sessionID => {
      const signal = AbortSignal.timeout(15000);
      await this.ctx.session.interrupt({ sessionID, continue: false }, { signal });
      await this.ctx.session.wait({ sessionID }, { signal });
      this.active.delete(sessionID);
    }));
    if (results.some(r => r.status === "rejected")) throw new Error("Could not confirm every worker stopped. Lock retained. Restart the OpenCode service before recovery.");
  }
}
