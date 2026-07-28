// Optional GitHub/git sync for a workspace: share context/styles/projects with a
// team, or just back the work up. Uses the system git binary and whatever
// credentials the user's environment already has (ssh agent, credential helper).
import { execFile } from "node:child_process";
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { shortId } from "./workspace.ts";

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

/** One document (or the shared-files group) with unresolved conflicts, for the resolution UI. */
export interface DocConflict {
  /** Document folder id under projects/, or "__shared__" for brand/context/root-level files. */
  docId: string;
  displayName: string;
  files: string[]; // repo-relative paths still in conflict
}

export interface SyncResult {
  pulled: boolean;
  committed: boolean;
  pushed: boolean;
  summary: string;
  /** Present (and non-empty) when the sync paused on a merge conflict awaiting resolution. */
  conflicts?: DocConflict[];
}

/** The name to credit a fork to: the git identity they commit as, then the OS user. */
async function currentUserName(root: string): Promise<string> {
  const gitName = (await git(root, "config", "user.name").catch(() => "")).trim();
  if (gitName) return gitName;
  try {
    return userInfo().username || "me";
  } catch {
    return "me";
  }
}

/** Read a document's display name from its project.json (falls back to the folder id). */
function docDisplayName(root: string, docId: string): string {
  try {
    const meta = JSON.parse(readFileSync(join(root, "projects", docId, "project.json"), "utf8"));
    return (meta.displayName as string) || docId;
  } catch {
    return docId;
  }
}

/** Group the currently-unmerged files into per-document conflicts. */
async function collectConflicts(root: string): Promise<DocConflict[]> {
  const out = (await git(root, "diff", "--name-only", "--diff-filter=U").catch(() => "")).split("\n").filter(Boolean);
  const byDoc = new Map<string, string[]>();
  for (const f of out) {
    const m = f.match(/^projects\/([^/]+)\//);
    const key = m ? m[1]! : "__shared__";
    (byDoc.get(key) ?? byDoc.set(key, []).get(key)!).push(f);
  }
  return [...byDoc.entries()].map(([docId, files]) => ({
    docId,
    displayName: docId === "__shared__" ? "Shared brand & sources" : docDisplayName(root, docId),
    files,
  }));
}

/** Commit local changes → integrate the remote (merge) → push. If the merge conflicts, leave the
 *  merge in progress and return the conflicts for the UI to resolve (see gitResolveConflicts). */
export async function gitSync(root: string, message?: string): Promise<SyncResult> {
  const status = await gitStatus(root);
  if (!status.isRepo || !status.remote) throw new Error("Workspace is not connected to a remote — connect a repo first");
  ensureGitignore(root); // repair ignores + untrack secrets on EVERY sync (heals pre-fix workspaces)
  await untrackSecrets(root);
  const branch = status.branch ?? "main";
  const parts: string[] = [];

  // 1) Commit local work first, so the merge reconciles whole commits (clean ours/theirs).
  await git(root, "add", "-A");
  const staged = await git(root, "status", "--porcelain");
  let committed = false;
  if (staged) {
    await git(root, "commit", "-m", message?.trim() || "blueline workspace sync");
    committed = true;
    parts.push(`committed ${staged.split("\n").filter(Boolean).length} change(s)`);
  }

  // 2) Integrate the remote via merge (ours = mine, theirs = remote — intuitive for resolution).
  let pulled = false;
  const hasUpstream = await git(root, "rev-parse", "--abbrev-ref", "@{upstream}").catch(() => null);
  if (hasUpstream) {
    await git(root, "fetch", "--quiet", "origin").catch(() => {});
    const before = await git(root, "rev-parse", "HEAD").catch(() => "");
    if ((await mergeRemote(root, branch)) === "conflict") {
      return { pulled: false, committed, pushed: false, conflicts: await collectConflicts(root), summary: "paused on a merge conflict — needs resolution" };
    }
    pulled = before !== (await git(root, "rev-parse", "HEAD").catch(() => before));
    if (pulled) parts.push("pulled remote changes");
  }

  const push = await pushWithRetry(root, branch, parts);
  if (push.conflicts) {
    return { pulled, committed, pushed: false, conflicts: push.conflicts, summary: "paused on a merge conflict — needs resolution" };
  }
  return { pulled, committed, pushed: push.pushed, summary: parts.length ? parts.join(", ") : "already up to date" };
}

/**
 * Merge origin/<branch> into the current branch. Heals a history unrelated to the remote's — the
 * mark of a workspace connected before adopt-on-connect — once with --allow-unrelated-histories.
 * Returns "ok" or "conflict" (leaving the merge in progress for the resolver); throws otherwise.
 */
async function mergeRemote(root: string, branch: string): Promise<"ok" | "conflict"> {
  try {
    await git(root, "merge", "--no-edit", `origin/${branch}`);
    return "ok";
  } catch (err: any) {
    if (/unrelated histories/i.test(String(err.message))) {
      try {
        await git(root, "merge", "--no-edit", "--allow-unrelated-histories", `origin/${branch}`);
        return "ok";
      } catch {
        /* fall through to conflict/abort handling below */
      }
    }
    if ((await collectConflicts(root)).length) return "conflict";
    await git(root, "merge", "--abort").catch(() => {});
    throw new Error("Merge failed. Try syncing again, or resolve the workspace in a terminal.");
  }
}

/** Push; on a race (teammate pushed in between) merge their changes and retry once. Returns a
 *  conflict list instead of throwing when that concurrent merge itself conflicts. */
async function pushWithRetry(root: string, branch: string, parts: string[]): Promise<{ pushed: boolean; conflicts?: DocConflict[] }> {
  const status = await gitStatus(root);
  if (status.ahead <= 0 && (await git(root, "rev-parse", "--abbrev-ref", "@{upstream}").catch(() => null))) return { pushed: false };
  try {
    await git(root, "push", "-u", "origin", branch);
  } catch (err: any) {
    if (/non-fast-forward|rejected|fetch first|behind|stale info/i.test(String(err.message))) {
      await git(root, "fetch", "--quiet", "origin");
      if ((await mergeRemote(root, branch)) === "conflict") return { pushed: false, conflicts: await collectConflicts(root) };
      await git(root, "push", "origin", branch);
      parts.push("merged a teammate's concurrent changes");
    } else {
      throw err;
    }
  }
  parts.push("pushed");
  return { pushed: true };
}

/**
 * The gated "just make one side win" escape hatch for when a merge is too tangled to resolve
 * document-by-document (e.g. wildly unrelated histories). DESTRUCTIVE — the UI must warn first.
 *   "push" = the remote is overwritten with your local workspace (teammates' remote-only work lost).
 *   "pull" = your local workspace is reset to exactly the remote (your uncommitted local work lost;
 *            brand-new files you never committed are left in place).
 */
export async function gitForceOverwrite(root: string, direction: "push" | "pull"): Promise<{ summary: string }> {
  const status = await gitStatus(root);
  if (!status.isRepo || !status.remote) throw new Error("Workspace is not connected to a remote — connect a repo first");
  const branch = status.branch ?? "main";
  await git(root, "merge", "--abort").catch(() => {}); // clear any half-finished merge/rebase
  await git(root, "rebase", "--abort").catch(() => {});
  ensureGitignore(root);
  await untrackSecrets(root);
  await git(root, "fetch", "--quiet", "origin").catch(() => {});

  if (direction === "pull") {
    await git(root, "reset", "--hard", `origin/${branch}`);
    return { summary: "Local workspace reset to match the remote. (Uncommitted local changes were discarded; brand-new files you never synced were kept.)" };
  }
  // push: force the remote to match local.
  await git(root, "add", "-A");
  if (await git(root, "status", "--porcelain")) {
    await git(root, "commit", "-m", "blueline workspace overwrite");
  }
  await git(root, "branch", "--set-upstream-to", `origin/${branch}`).catch(() => {});
  await git(root, "push", "--force", "origin", branch);
  return { summary: "Remote overwritten with your local workspace. (Any remote-only changes were discarded.)" };
}

export type ConflictChoice = "mine" | "theirs" | "fork";
export interface ConflictResolution {
  docId: string;
  choice: ConflictChoice;
}
export interface ResolveResult {
  pushed: boolean;
  forked: { fromDocId: string; newDocId: string; displayName: string }[];
  summary: string;
}

/**
 * Resolve an in-progress merge conflict per document. "mine"/"theirs" keep one side; "fork" keeps
 * BOTH — your version is copied into a brand-new document (new id, credited to you) and the shared
 * document takes the remote's version, so nobody loses work. Then the merge is committed and pushed.
 */
export async function gitResolveConflicts(root: string, resolutions: ConflictResolution[]): Promise<ResolveResult> {
  const pending = await collectConflicts(root);
  if (!pending.length) throw new Error("No conflict to resolve.");
  const choiceFor = new Map(resolutions.map((r) => [r.docId, r.choice]));
  const forked: ResolveResult["forked"] = [];
  const userName = await currentUserName(root);

  for (const conflict of pending) {
    const choice = choiceFor.get(conflict.docId) ?? "theirs";
    // Check out one side into the working tree. Does NOT `git add` — adding collapses the merge
    // stages, so a subsequent checkout of the other side would silently no-op (fork needs both).
    const checkoutSide = async (side: "--ours" | "--theirs") => {
      for (const f of conflict.files) await git(root, "checkout", side, "--", f).catch(() => {});
    };
    const take = async (side: "--ours" | "--theirs") => {
      await checkoutSide(side);
      await git(root, "add", "--", ...conflict.files);
    };

    if (choice === "fork" && conflict.docId !== "__shared__") {
      // 1) Materialize MY version of the whole document, 2) copy it to a new id, 3) reset the
      //    shared document to THEIRS. Both survive. Check out both sides BEFORE adding.
      await checkoutSide("--ours");
      const srcDir = join(root, "projects", conflict.docId);
      const base = (docDisplayName(root, conflict.docId) || conflict.docId)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "document";
      const newDocId = `${base}-${shortId()}`;
      const destDir = join(root, "projects", newDocId);
      cpSync(srcDir, destDir, { recursive: true });
      // Patch the fork's identity + name so it's a distinct, clearly-credited document.
      try {
        const metaPath = join(destDir, "project.json");
        const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf8")) : {};
        meta.id = newDocId;
        meta.displayName = `${docDisplayName(root, conflict.docId)} (${userName}'s version)`;
        writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n");
      } catch {
        /* a doc without project.json still forks — just without the renamed metadata */
      }
      await take("--theirs"); // the shared document keeps the remote's version
      await git(root, "add", "--", `projects/${conflict.docId}`, `projects/${newDocId}`);
      forked.push({ fromDocId: conflict.docId, newDocId, displayName: `${docDisplayName(root, conflict.docId)} (${userName}'s version)` });
    } else {
      await take(choice === "mine" ? "--ours" : "--theirs");
    }
  }

  // Any straggler unmerged files (defensive) block the commit — take theirs.
  const still = (await git(root, "diff", "--name-only", "--diff-filter=U").catch(() => "")).split("\n").filter(Boolean);
  for (const f of still) {
    await git(root, "checkout", "--theirs", "--", f).catch(() => {});
    await git(root, "add", "--", f);
  }

  await git(root, "commit", "--no-edit");
  const branch = (await gitStatus(root)).branch ?? "main";
  const parts: string[] = [];
  const push = await pushWithRetry(root, branch, parts);
  return {
    pushed: push.pushed,
    forked,
    summary: [forked.length ? `forked ${forked.length} document(s)` : "", ...parts].filter(Boolean).join(", ") || "resolved",
  };
}
