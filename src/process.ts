import { spawn } from "node:child_process";

export async function execute(command: string[], cwd: string, options: { signal?: AbortSignal; timeoutMs?: number; env?: NodeJS.ProcessEnv; maxBytes?: number } = {}): Promise<string> {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), { cwd, env: options.env ?? process.env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let failure: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try { process.platform === "win32" ? child.kill(signal) : process.kill(-child.pid, signal); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") failure ??= e as Error; }
    };
    const stop = (error: Error) => {
      failure ??= error;
      kill("SIGTERM");
      killTimer ??= setTimeout(() => kill("SIGKILL"), 1000);
    };
    const abort = () => stop(new Error("Run stopped"));
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const timeout = setTimeout(() => stop(new Error(`Command timed out: ${command[0]}`)), options.timeoutMs ?? 120000);
    const collect = (chunk: Buffer) => {
      output += chunk.toString();
      const max = options.maxBytes ?? 65536;
      if (Buffer.byteLength(output) > max) stop(new Error(`Command output exceeded ${max} bytes: ${command[0]}`));
      output = output.slice(-max);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", error => { failure = error; });
    child.on("close", code => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abort);
      // Check commands must terminate, not leave a watch server behind.
      kill("SIGKILL");
      if (failure || code !== 0) reject(new Error(`${failure?.message ?? `Exit ${code}: ${command.join(" ")}`}\n${output}`));
      else resolve(output.trimEnd());
    });
  });
}

export async function awake(enabled: boolean): Promise<() => Promise<void>> {
  if (!enabled || process.platform !== "darwin") return async () => {};
  const child = spawn("/usr/bin/caffeinate", ["-is", "-w", String(process.pid)], { stdio: "ignore" });
  await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  return async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>(resolve => { child.once("exit", () => resolve()); child.kill("SIGTERM"); });
  };
}
