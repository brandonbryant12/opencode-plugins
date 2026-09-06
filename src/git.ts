import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execute } from "./process.ts";

export class Git {
  readonly directory: string;
  readonly maxDiffBytes: number;
  constructor(directory: string, maxDiffBytes = 300000) { this.directory = directory; this.maxDiffBytes = maxDiffBytes; }
  run(args: string[], env?: NodeJS.ProcessEnv) { return execute(["git", "-c", "core.fsmonitor=false", ...args], this.directory, { env, maxBytes: this.maxDiffBytes }); }
  head() { return this.run(["rev-parse", "HEAD"]); }
  branch() { return this.run(["symbolic-ref", "--short", "HEAD"]); }
  async clean() {
    if (await this.run(["status", "--porcelain=v1", "--untracked-files=all"])) throw new Error("Checkout has uncommitted changes. Preserve them and start Churn in a clean worktree.");
  }
  async preflight() {
    if (await realpath(await this.run(["rev-parse", "--show-toplevel"])) !== await realpath(this.directory)) throw new Error("Start OpenCode at the Git worktree root");
    await this.head();
    await this.clean();
    // Avoid silently modifying nested repositories or skipping their dirty content.
    if (await this.run(["ls-files", "--", ".gitmodules"])) throw new Error("Submodules are not supported in unattended Churn runs");
  }
  async identity(head: string, branch: string) {
    if (await this.head() !== head || await this.branch() !== branch) throw new Error("Git HEAD or branch changed outside the runner. Inspect the checkout before resuming.");
  }
  async snapshot(): Promise<{ tree: string; diff: string }> {
    const temp = await mkdtemp(join(tmpdir(), "churn-index-"));
    const env = { ...process.env, GIT_INDEX_FILE: join(temp, "index") };
    try {
      await this.run(["read-tree", "HEAD"], env);
      await this.run(["add", "--all", "--", "."], env);
      const names = await this.run(["diff", "--cached", "--name-only", "-z"], env);
      for (const file of names.split("\0").filter(Boolean)) {
        if (/(^|\/)(\.env(?:\..*)?|credentials(?:\.json)?|id_rsa|id_ed25519)$|\.(pem|p12|key)$/i.test(file) && !/(^|\/)\.env\.(example|sample|template)$/.test(file))
          throw new Error(`Potential secret file in slice: ${file}. Inspect it manually.`);
      }
      return { tree: await this.run(["write-tree"], env), diff: await this.run(["diff", "--cached", "--no-ext-diff", "--no-textconv", "--binary", "HEAD", "--"], env) };
    } finally { await rm(temp, { recursive: true, force: true }); }
  }
  async diff(base: string) { return this.run(["diff", "--no-ext-diff", "--no-textconv", "--binary", `${base}..HEAD`, "--"]); }
  async commit(tree: string, head: string, branch: string, title: string, runID: string) {
    await this.identity(head, branch);
    if ((await this.snapshot()).tree !== tree) throw new Error("Working tree changed after review");
    await this.run(["add", "--all", "--", "."]);
    if (await this.run(["write-tree"]) !== tree) throw new Error("Index differs from reviewed tree");
    await this.run(["commit", "-m", `${title.replace(/[\r\n]/g, " ").slice(0, 150)}\n\nChurn-Run: ${runID}\nChurn-Tree: ${tree}`]);
    const committed = await this.head();
    if (await this.run(["rev-parse", "HEAD^{tree}"]) !== tree || await this.run(["rev-parse", "HEAD^"]) !== head)
      throw new Error("Commit hook changed the reviewed tree or history. Inspect before resuming.");
    await this.clean();
    return committed;
  }
}
