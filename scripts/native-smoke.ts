// Optional real-runtime integration test. A deterministic local HTTP provider
// exercises the native OpenCode loop without credentials or paid inference.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { OpenCode } from "@opencode-ai/client";
import { Git } from "../src/git.ts";
import { readState } from "../src/state.ts";

const binary = process.env.OPENCODE2_BIN;
if (!binary) throw new Error("Set OPENCODE2_BIN to the age-eligible OpenCode 2 binary");
const root = await realpath(await mkdtemp(join(tmpdir(), "churn-native-")));
const directory = join(root, "repo");
await mkdir(directory);
const git = new Git(directory);
const plugin = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let nativeLog = "";
let requests = 0;
let edits = 0;
let reads = 0;
let forbiddenAttempts = 0;
const denialEvidence: string[] = [];
let builderToolNames: string[] = [];
let native: ReturnType<typeof spawn> | undefined;
let providerFailure: unknown;

const provider = createServer(async (req, res) => {
  try {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests++;
    const messages = body.messages as { role: string; content: unknown }[];
    const text = messages.filter(m => m.role === "user").map(m => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).join("\n");
    const role = text.match(/You are the Churn (planner|builder|reviewer) worker/)?.[1];
    const hasToolResult = messages.some(m => m.role === "tool");
    let result = "Churn smoke test";
    let call: { name: string; arguments: string } | undefined;
    if (role === "builder" && body.tools?.length) builderToolNames = body.tools.map((t: { function: { name: string } }) => t.function.name);
    if (role === "builder" && !hasToolResult) {
      edits++;
      call = { name: "write", arguments: JSON.stringify({ path: "answer.txt", content: "after\n" }) };
    } else if (role === "planner" && !hasToolResult) {
      reads++;
      call = { name: "read", arguments: JSON.stringify({ path: "answer.txt" }) };
    } else if (role === "planner") {
      const changed = await readFile(join(directory, "answer.txt"), "utf8") === "after\n";
      result = JSON.stringify(changed ? { done: true, reason: "Answer is after", slice: null } : { done: false, reason: "Answer is before", slice: { title: "Update answer", instructions: "Write after to answer.txt", acceptance: ["answer.txt contains after"] } });
    } else if (role === "reviewer" && !hasToolResult) {
      // Attempt a forbidden nested edit through Code Mode. It must be rejected
      // without changing the reviewed tree. The model then reports the result.
      forbiddenAttempts++;
      call = { name: "execute", arguments: JSON.stringify({ code: 'return await tools.opencode.session_move({directory:"/tmp"});' }) };
    } else if (role === "reviewer") {
      denialEvidence.push(JSON.stringify(messages.filter(m => m.role === "tool")));
      result = '{"verdict":"pass","findings":[]}';
    }
    else if (role === "builder") result = "Updated answer.txt";
    const id = `smoke-${requests}`;
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const delta = call ? { role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: call }] } : { role: "assistant", content: result };
      res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model: "smoke", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model: "smoke", choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id, object: "chat.completion", created: 1, model: "smoke", choices: [{ index: 0, message: { role: "assistant", content: result }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
    }
  } catch (error) { providerFailure = error; res.writeHead(500); res.end(String(error)); }
});
await new Promise<void>(r => provider.listen(0, "127.0.0.1", r));
const providerPort = (provider.address() as { port: number }).port;
const reserved = createServer();
await new Promise<void>(r => reserved.listen(0, "127.0.0.1", r));
const port = (reserved.address() as { port: number }).port;
await new Promise<void>(r => reserved.close(() => r()));
try {
  await writeFile(join(directory, "answer.txt"), "before\n");
  await writeFile(join(directory, "opencode.json"), JSON.stringify({
    model: "churn-smoke/smoke",
    providers: { "churn-smoke": { package: "@opencode-ai/ai/providers/openai-compatible", settings: { baseURL: `http://127.0.0.1:${providerPort}/v1`, apiKey: "smoke-only" }, models: { smoke: { name: "Smoke", limit: { context: 64000, output: 4000 } } } } },
    permissions: [{ action: "*", resource: "*", effect: "allow" }],
    plugins: [{ package: plugin, options: { model: "churn-smoke/smoke", reviewers: [{ name: "correctness" }], cleanAudits: 1, keepAwake: false, maxCalls: 40, heavyCommand: ["env"], checks: [{ name: "answer", command: [process.execPath, "-e", 'if(require("fs").readFileSync("answer.txt","utf8")!=="after\\n")process.exit(1)'] }] } }],
  }));
  await git.run(["init", "-b", "main"]);
  await git.run(["config", "user.name", "Churn Smoke"]);
  await git.run(["config", "user.email", "smoke@example.invalid"]);
  await git.run(["config", "commit.gpgsign", "false"]);
  await git.run(["add", "."]);
  await git.run(["commit", "-m", "Initial"]);
  const password = randomUUID();
  const env = { ...process.env, XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"), OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_PASSWORD: password };
  native = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs"], { cwd: directory, env, stdio: ["ignore", "pipe", "pipe"] });
  native.stdout?.on("data", chunk => { nativeLog = (nativeLog + chunk).slice(-12000); });
  native.stderr?.on("data", chunk => { nativeLog = (nativeLog + chunk).slice(-12000); });
  const client = OpenCode.make({ baseUrl: `http://127.0.0.1:${port}`, headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } });
  let ready = false;
  for (let i = 0; i < 120; i++) {
    try { await client.health.get({ signal: AbortSignal.timeout(500) }); ready = true; break; } catch { await new Promise(r => setTimeout(r, 250)); }
  }
  assert.ok(ready, `Native server did not start: ${nativeLog}`);
  const parent = await client.session.create({ title: "Smoke parent", model: { providerID: "churn-smoke", id: "smoke" }, location: { directory } });
  await client.plugin.awaitActivation({ location: { directory } });
  const commands = await client.command.list({ location: { directory } });
  assert.ok(commands.data.some(c => c.name === "churn"), JSON.stringify({ commands, plugins: await client.plugin.list({ location: { directory } }) }));
  await client.session.command({ sessionID: parent.id, command: "churn", text: "Change answer.txt from before to after. Keep it simple." });
  let state;
  for (let i = 0; i < 240; i++) {
    state = await readState(join(directory, ".git/churn/state.json"));
    if (state && state.status !== "running") break;
    await new Promise(r => setTimeout(r, 250));
  }
  assert.equal(state?.status, "complete", `${state?.reason}\n${nativeLog}`);
  assert.equal(state.completed.length, 1);
  assert.equal(state.reviews.length, 4);
  assert.ok(edits > 0 && reads > 0 && forbiddenAttempts > 0);
  assert.ok(denialEvidence.every(text => text.includes("Churn reviewer cannot use opencode_session_move")), JSON.stringify(denialEvidence));
  assert.ok(builderToolNames.includes("write"));
  assert.ok(!builderToolNames.includes("shell"));
  assert.equal(await readFile(join(directory, "answer.txt"), "utf8"), "after\n");
  await git.clean();
  assert.equal(providerFailure, undefined);
  console.log(JSON.stringify({ native: "OpenCode 2 beta-19157", status: state.status, commits: state.completed.length, reviews: state.reviews.length, requests, countedRequests: state.calls, edits, reads, forbiddenAttempts, builderToolNames }, null, 2));
} catch (error) { console.error(nativeLog.split("\n").filter(line => /ERROR|WARN|error|failed/.test(line)).join("\n")); throw error; }
finally {
  if (native && native.exitCode === null) {
    const exited = new Promise<void>(r => native!.once("exit", () => r()));
    native.kill("SIGTERM");
    const killTimer = setTimeout(() => native?.kill("SIGKILL"), 5000);
    await exited; clearTimeout(killTimer);
  }
  await new Promise<void>(r => provider.close(() => r()));
  await rm(root, { recursive: true, force: true });
}
