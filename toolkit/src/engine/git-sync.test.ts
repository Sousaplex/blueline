import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gitConnect, gitStatus, gitSync } from "./git-sync.ts";

// Hermetic git: identity + a writable global config (so we can map a github-looking URL to a
// local bare repo via insteadOf — gitConnect only accepts https/git@ URLs, by design).
const GLOBAL_CFG = join(mkdtempSync(join(tmpdir(), "gcfg-")), ".gitconfig");
writeFileSync(GLOBAL_CFG, "[user]\n\tname = t\n\temail = t@t\n");
Object.assign(process.env, {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
  GIT_CONFIG_GLOBAL: GLOBAL_CFG,
  GIT_CONFIG_SYSTEM: "/dev/null",
});
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
const remoteFiles = (remote: string) =>
  execFileSync("git", ["--git-dir", remote, "ls-tree", "-r", "--name-only", "main"]).toString();

let remoteSeq = 0;
/** A seeded non-empty bare remote, returned as a github-looking URL that git rewrites to the
 *  local bare repo (so the real, URL-validated gitConnect can be exercised hermetically). */
function seededRemote(): { url: string; path: string } {
  const base = mkdtempSync(join(tmpdir(), "gsync-"));
  const remote = join(base, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", remote]);
  const url = `https://blueline.test/repo-${remoteSeq++}.git`;
  execFileSync("git", ["config", "--global", `url.${remote}.insteadOf`, url]);
  const seed = join(base, "seed");
  mkdirSync(seed);
  execFileSync("git", ["init", "-q", "-b", "main", seed]);
  writeFileSync(join(seed, "README.md"), "# repo\n");
  mkdirSync(join(seed, "brand"));
  writeFileSync(join(seed, "brand", "guidelines.md"), "shared brand\n");
  sh(seed, "add", "-A");
  sh(seed, "commit", "-qm", "init");
  sh(seed, "remote", "add", "origin", remote);
  sh(seed, "push", "-q", "-u", "origin", "main");
  return { url, path: remote };
}

test("gitConnect adopts a non-empty remote and gitSync fast-forwards (no non-fast-forward reject)", async () => {
  const { url, path } = seededRemote();
  const ws = mkdtempSync(join(tmpdir(), "gsync-ws-"));
  mkdirSync(join(ws, "projects"), { recursive: true });
  writeFileSync(join(ws, ".env"), "GEMINI_API_KEY=secret\n"); // must NOT be pushed
  writeFileSync(join(ws, "projects", "mine.txt"), "local work\n");

  await gitConnect(ws, url);
  assert.ok(existsSync(join(ws, "README.md")), "the repo's files were pulled into the workspace");
  assert.ok(existsSync(join(ws, "brand", "guidelines.md")), "shared brand pulled in");
  assert.ok(existsSync(join(ws, "projects", "mine.txt")), "local file preserved");

  const res = await gitSync(ws, "add my document");
  assert.ok(res.pushed, "sync pushed successfully (fast-forward, no reject)");
  const files = remoteFiles(path);
  assert.ok(files.includes("projects/mine.txt"), "local work reached the remote");
  assert.ok(!files.includes(".env"), "the .env secret was NOT pushed");
});

test("gitSync merges a teammate's concurrent change to a different document", async () => {
  const { url, path } = seededRemote();
  // Person A connects and adds document A.
  const wsA = mkdtempSync(join(tmpdir(), "gsync-a-"));
  await gitConnect(wsA, url);
  mkdirSync(join(wsA, "projects", "a"), { recursive: true });
  writeFileSync(join(wsA, "projects", "a", "page.html"), "A\n");
  await gitSync(wsA, "doc A");

  // Person B connected earlier; now edits a DIFFERENT document and syncs while behind A's push.
  const wsB = mkdtempSync(join(tmpdir(), "gsync-b-"));
  await gitConnect(wsB, url); // adopts remote incl. A's doc
  mkdirSync(join(wsB, "projects", "b"), { recursive: true });
  writeFileSync(join(wsB, "projects", "b", "page.html"), "B\n");
  // A pushes one more change AFTER B connected, so B is now behind.
  writeFileSync(join(wsA, "projects", "a", "page.html"), "A2\n");
  await gitSync(wsA, "doc A update");

  const res = await gitSync(wsB, "doc B");
  assert.ok(res.pushed, "B's sync pushed after integrating A's changes");
  const files = remoteFiles(path);
  assert.ok(files.includes("projects/a/page.html"), "A's document survived");
  assert.ok(files.includes("projects/b/page.html"), "B's document was added — disjoint edits auto-merged");
});
