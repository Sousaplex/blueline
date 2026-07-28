// Optional GitHub/git sync for a workspace: share context/styles/projects with a
// team, or just back the work up. Uses the system git binary and whatever
// credentials the user's environment already has (ssh agent, credential helper).
import { execFile } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// Never let these leave the machine: .env holds the raw API keys, config/workspace.json
// holds absolute local paths. Everything else (projects, context, brand, templates,
// config/providers.json) is meant to be shared with the team.
const SECRET_PATHS = [".env", "config/workspace.json"];
const REQUIRED_IGNORES = [
  ...SECRET_PATHS,
  ".env.*",
  "projects/*/fetched/",
  "projects/*/.run-start.json",
  "projects/*/.search-budget.json",
  ".DS_Store",
];

/** Ensure the workspace .gitignore excludes secrets + transient state (idempotent —
 *  appends only the lines that are missing, so it also repairs a pre-existing file). */
export function ensureGitignore(root: string): void {
  const path = join(root, ".gitignore");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const present = new Set(existing.split("\n").map((l: string) => l.trim()));
  const missing = REQUIRED_IGNORES.filter((ig) => !present.has(ig));
  if (!missing.length && existing) return;
  const header = existing
    ? `${existing}${existing.endsWith("\n") ? "" : "\n"}# blueline — keep secrets and machine-local state out of sync\n`
    : "# blueline workspace — secrets and transient per-run state stay local\n";
  writeFileSync(path, header + missing.join("\n") + "\n");
}

/** Stop tracking secrets a pre-fix connect may already have staged/committed. `--cached`
 *  keeps the file on disk; `--ignore-unmatch` is a no-op when the path was never tracked.
 *  NOTE: this removes them going forward — anything already pushed stays in git history,
 *  so an exposed key must still be rotated. */
async function untrackSecrets(root: string): Promise<void> {
  await git(root, "rm", "-r", "--cached", "--ignore-unmatch", "--", ...SECRET_PATHS).catch(() => {});
}

/** The remote's default branch name, or null if the remote is empty. Robust across GitHub
 *  (symbolic-ref) and quirky local remotes (existence fallback). Assumes origin fetched. */
async function remoteDefaultBranch(root: string): Promise<string | null> {
  await git(root, "remote", "set-head", "origin", "--auto").catch(() => {});
  const sym = await git(root, "symbolic-ref", "--short", "refs/remotes/origin/HEAD").catch(() => null);
  if (sym) return sym.replace(/^origin\//, "");
  for (const b of ["main", "master"]) {
    if (await git(root, "rev-parse", "--verify", "--quiet", `origin/${b}`).catch(() => null)) return b;
  }
  return null;
}

/**
 * Turn the current workspace into a repo connected to `url` (idempotent). If the remote already
 * has commits (a shared team repo), ADOPT it: bring its files and history into the workspace so
 * the first sync fast-forwards instead of being rejected non-fast-forward. Local files are kept
 * (remote-only files are pulled in; colliding local files are preserved and become changes).
 */
export async function gitConnect(root: string, url: string): Promise<GitStatus> {
  if (!/^(https:\/\/|git@)[\w.@:/~-]+$/.test(url.trim())) throw new Error("That does not look like a git remote URL");
  const status = await gitStatus(root);
  if (!status.isRepo) {
    await git(root, "init", "-b", "main");
  }
  ensureGitignore(root); // BEFORE any add/commit — the very first sync must already exclude .env
  await untrackSecrets(root);
  const hasOrigin = await git(root, "remote", "get-url", "origin").catch(() => null);
  if (hasOrigin) await git(root, "remote", "set-url", "origin", url.trim());
  else await git(root, "remote", "add", "origin", url.trim());
  await git(root, "fetch", "--quiet", "origin").catch(() => {}); // may be an empty repo — fine

  const branch = await remoteDefaultBranch(root);
  if (branch) {
    // Non-empty remote → adopt its history so the workspace is "the repo, plus my local files".
    const localHasCommit = await git(root, "rev-parse", "--verify", "--quiet", "HEAD").catch(() => null);
    if (!localHasCommit) {
      // Fresh workspace: base the branch on the remote and pull its files onto disk without
      // clobbering any local files (restore only the paths missing from the working tree).
      await git(root, "reset", "--mixed", `origin/${branch}`);
      const deleted = await git(root, "ls-files", "--deleted", "-z").catch(() => "");
      const files = deleted.split("\0").filter(Boolean);
      if (files.length) await git(root, "checkout", "--", ...files);
    } else {
      // Reconnecting with local commits: replay them on top of the remote (no clobber). A true
      // conflict is surfaced rather than left half-done.
      try {
        await git(root, "rebase", `origin/${branch}`);
      } catch (err: any) {
        await git(root, "rebase", "--abort").catch(() => {});
        throw new Error(
          `This workspace has local commits that conflict with the remote. Resolve them in a terminal ` +
            `(git pull --rebase), or disconnect and clone the repo into a fresh workspace. (${err.message})`,
        );
      }
    }
    await git(root, "branch", "--set-upstream-to", `origin/${branch}`).catch(() => {});
    ensureGitignore(root); // re-assert blueline's ignores on top of whatever .gitignore the repo shipped
    await untrackSecrets(root);
  }
  return gitStatus(root);
}

/** Disconnect the workspace from its remote. Default: drop the `origin` remote but KEEP
 *  local history (reversible, zero data loss). `wipeHistory` fully un-repos the workspace
 *  (removes .git) — irreversible, opt-in only. Neither touches the remote repo itself; a
 *  mis-targeted repo that was already pushed to must be deleted on GitHub by the user. */
export async function gitDisconnect(root: string, opts?: { wipeHistory?: boolean }): Promise<GitStatus> {
  const status = await gitStatus(root);
  if (!status.isRepo) return status;
  await git(root, "remote", "remove", "origin").catch(() => {}); // no-op if already gone
  if (opts?.wipeHistory) {
    const gitDir = join(root, ".git");
    if (existsSync(gitDir) && gitDir.endsWith(".git")) rmSync(gitDir, { recursive: true, force: true });
  }
  return gitStatus(root);
}

/** Clone a shared workspace repo to `dest` (which must not exist yet). */
export async function gitClone(url: string, dest: string): Promise<void> {
  const u = url.trim();
  // Same shape check as gitConnect, applied here too: without it, `ext::sh -c …` URLs or a
  // leading `--upload-pack=` execute arbitrary commands. `--` stops option parsing, and the
  // protocol pins block ext/file transports even if a hostile URL slips past the regex.
  if (!/^(https:\/\/|git@)[\w.@:/~-]+$/.test(u)) throw new Error("That does not look like a git remote URL");
  if (dest.startsWith("-")) throw new Error("Invalid destination");
  if (existsSync(dest)) throw new Error(`Destination already exists: ${dest}`);
  await run(
    "git",
    ["-c", "protocol.ext.allow=never", "-c", "protocol.file.allow=never", "clone", "--", u, dest],
    { timeout: 300_000, maxBuffer: 8 * 1024 * 1024 },
  );
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
  // Defensive: repair the ignore rules and untrack secrets on EVERY sync, so a workspace
  // connected before this fix stops pushing .env from the next sync onward.
  ensureGitignore(root);
  await untrackSecrets(root);
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
    const branch = after.branch ?? "main";
    try {
      await git(root, "push", "-u", "origin", branch);
    } catch (err: any) {
      // A teammate pushed between our pull and our push (concurrent edit). Rebase onto their
      // changes and retry once — disjoint edits (different documents) merge automatically; a
      // genuine same-file conflict surfaces here for the user to resolve.
      if (/non-fast-forward|rejected|fetch first|behind|stale info/i.test(String(err.message))) {
        await git(root, "pull", "--rebase", "--autostash", "origin", branch);
        await git(root, "push", "origin", branch);
        parts.push("merged a teammate's concurrent changes");
      } else {
        throw err;
      }
    }
    pushed = true;
    parts.push("pushed");
  }
  return { pulled, committed, pushed, summary: parts.length ? parts.join(", ") : "already up to date" };
}
