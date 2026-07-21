// Optional GitHub/git sync for a workspace: share context/styles/projects with a
// team, or just back the work up. Uses the system git binary and whatever
// credentials the user's environment already has (ssh agent, credential helper).
import { execFile } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

async function git(root: string, ...args: string[]): Promise<string> {
  try {
    const { stdout } = await run("git", args, { cwd: root, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
    return stdout.trim();
  } catch (err: any) {
    const detail = (err.stderr || err.stdout || err.message || "").toString().trim().slice(0, 500);
    throw new Error(`git ${args[0]} failed: ${detail}`);
  }
}

export interface GitStatus {
  isRepo: boolean;
  remote: string | null;
  branch: string | null;
  dirty: number; // changed/untracked paths
  ahead: number;
  behind: number;
}

export async function gitStatus(root: string): Promise<GitStatus> {
  const none: GitStatus = { isRepo: false, remote: null, branch: null, dirty: 0, ahead: 0, behind: 0 };
  try {
    await git(root, "rev-parse", "--git-dir");
  } catch {
    return none;
  }
  const remote = await git(root, "remote", "get-url", "origin").catch(() => null);
  const branch = await git(root, "rev-parse", "--abbrev-ref", "HEAD").catch(() => null);
  const dirty = (await git(root, "status", "--porcelain").catch(() => "")).split("\n").filter(Boolean).length;
  let ahead = 0;
  let behind = 0;
  if (remote) {
    await git(root, "fetch", "--quiet", "origin").catch(() => {});
    const counts = await git(root, "rev-list", "--left-right", "--count", "@{upstream}...HEAD").catch(() => null);
    if (counts) {
      const [b, a] = counts.split(/\s+/).map(Number);
      behind = b || 0;
      ahead = a || 0;
    }
  }
  return { isRepo: true, remote, branch, dirty, ahead, behind };
}

const WORKSPACE_GITIGNORE = `# blueline workspace — transient per-run state stays local
projects/*/fetched/
projects/*/.run-start.json
projects/*/.search-budget.json
.DS_Store
`;

/** Turn the current workspace into a repo connected to `url` (idempotent). */
export async function gitConnect(root: string, url: string): Promise<GitStatus> {
  if (!/^(https:\/\/|git@)[\w.@:/~-]+$/.test(url.trim())) throw new Error("That does not look like a git remote URL");
  const status = await gitStatus(root);
  if (!status.isRepo) {
    await git(root, "init", "-b", "main");
  }
  if (!existsSync(join(root, ".gitignore"))) writeFileSync(join(root, ".gitignore"), WORKSPACE_GITIGNORE);
  const hasOrigin = await git(root, "remote", "get-url", "origin").catch(() => null);
  if (hasOrigin) await git(root, "remote", "set-url", "origin", url.trim());
  else await git(root, "remote", "add", "origin", url.trim());
  await git(root, "fetch", "--quiet", "origin").catch(() => {}); // may be an empty repo — fine
  return gitStatus(root);
}

/** Clone a shared workspace repo to `dest` (which must not exist yet). */
export async function gitClone(url: string, dest: string): Promise<void> {
  if (existsSync(dest)) throw new Error(`Destination already exists: ${dest}`);
  await run("git", ["clone", url.trim(), dest], { timeout: 300_000, maxBuffer: 8 * 1024 * 1024 });
}

export interface SyncResult {
  pulled: boolean;
  committed: boolean;
  pushed: boolean;
  summary: string;
}

/** Pull (rebase, autostash) → commit local changes → push. */
export async function gitSync(root: string, message?: string): Promise<SyncResult> {
  const status = await gitStatus(root);
  if (!status.isRepo || !status.remote) throw new Error("Workspace is not connected to a remote — connect a repo first");
  const parts: string[] = [];

  const hasUpstream = await git(root, "rev-parse", "--abbrev-ref", "@{upstream}").catch(() => null);
  let pulled = false;
  if (hasUpstream) {
    const before = await git(root, "rev-parse", "HEAD").catch(() => "");
    await git(root, "pull", "--rebase", "--autostash", "origin", status.branch ?? "main");
    pulled = before !== (await git(root, "rev-parse", "HEAD").catch(() => before));
    if (pulled) parts.push("pulled remote changes");
  }

  await git(root, "add", "-A");
  const staged = await git(root, "status", "--porcelain");
  let committed = false;
  if (staged) {
    await git(root, "commit", "-m", message?.trim() || "blueline workspace sync");
    committed = true;
    parts.push(`committed ${staged.split("\n").filter(Boolean).length} change(s)`);
  }

  let pushed = false;
  const after = await gitStatus(root);
  if (after.ahead > 0 || !hasUpstream) {
    await git(root, "push", "-u", "origin", after.branch ?? "main");
    pushed = true;
    parts.push("pushed");
  }
  return { pulled, committed, pushed, summary: parts.length ? parts.join(", ") : "already up to date" };
}
