import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gitConnect, gitForceOverwrite, gitResolveConflicts, gitStatus, gitSync } from "./git-sync.ts";

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
const remoteShow = (remote: string, path: string) =>
  execFileSync("git", ["--git-dir", remote, "show", `main:${path}`]).toString();

/** Seed a remote that already contains one document, and return two connected workspaces plus a
 *  same-file conflict staged in B (B edited projects/doc/page.html differently from A, who pushed). */
async function conflictSetup() {
  const base = mkdtempSync(join(tmpdir(), "gsync-"));
  const remote = join(base, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", remote]);
  const url = `https://blueline.test/repo-${remoteSeq++}.git`;
  execFileSync("git", ["config", "--global", `url.${remote}.insteadOf`, url]);
  const seed = join(base, "seed");
  mkdirSync(join(seed, "projects", "doc"), { recursive: true });
  writeFileSync(join(seed, "projects", "doc", "page.html"), "base\n");
  writeFileSync(join(seed, "projects", "doc", "project.json"), JSON.stringify({ id: "doc", displayName: "Poster" }));
  execFileSync("git", ["init", "-q", "-b", "main", seed]);
  sh(seed, "add", "-A");
  sh(seed, "commit", "-qm", "seed doc");
  sh(seed, "remote", "add", "origin", remote);
  sh(seed, "push", "-q", "-u", "origin", "main");

  const wsA = mkdtempSync(join(tmpdir(), "gsync-a-"));
  const wsB = mkdtempSync(join(tmpdir(), "gsync-b-"));
  await gitConnect(wsA, url);
  await gitConnect(wsB, url); // both now hold "base"
  // A edits the poster and pushes.
  writeFileSync(join(wsA, "projects", "doc", "page.html"), "A version\n");
  await gitSync(wsA, "A edit");
  // B edits the SAME file from base; sync must detect the conflict (not push).
  writeFileSync(join(wsB, "projects", "doc", "page.html"), "B version\n");
  const res = await gitSync(wsB, "B edit");
  return { remote, wsB, res };
}

test("gitSync detects a same-document conflict; fork keeps BOTH versions", async () => {
  const { remote, wsB, res } = await conflictSetup();
  assert.ok(res.conflicts && res.conflicts.length === 1, "sync paused on a conflict instead of pushing");
  assert.equal(res.conflicts![0]!.docId, "doc");
  assert.ok(!res.pushed, "nothing pushed while unresolved");

  const resolved = await gitResolveConflicts(wsB, [{ docId: "doc", choice: "fork" }]);
  assert.ok(resolved.pushed, "resolution pushed");
  assert.equal(resolved.forked.length, 1, "one document was forked");
  const newId = resolved.forked[0]!.newDocId;

  assert.equal(remoteShow(remote, "projects/doc/page.html").trim(), "A version", "shared doc keeps the remote's version");
  assert.equal(remoteShow(remote, `projects/${newId}/page.html`).trim(), "B version", "my version survives as a new document");
  assert.match(remoteShow(remote, `projects/${newId}/project.json`), /'s version\)/, "fork is credited to the user");
});

/** A workspace mimicking the OLD gitConnect: fresh init, remote added + fetched, but never
 *  adopted — so its history is unrelated to the remote's. */
function legacyUnrelatedWs(url: string): string {
  const ws = mkdtempSync(join(tmpdir(), "gsync-legacy-"));
  mkdirSync(join(ws, "projects"), { recursive: true });
  writeFileSync(join(ws, "projects", "mine.txt"), "local work\n");
  sh(ws, "init", "-b", "main");
  sh(ws, "remote", "add", "origin", url);
  sh(ws, "fetch", "origin");
  return ws;
}

test("gitSync heals a legacy workspace whose history is unrelated to the remote", async () => {
  const { url, path } = seededRemote();
  const ws = legacyUnrelatedWs(url);
  const res = await gitSync(ws, "first sync");
  assert.ok(res.pushed, "healed the unrelated history and pushed (no 'refusing to merge unrelated histories')");
  const files = remoteFiles(path);
  assert.ok(files.includes("projects/mine.txt"), "my work reached the remote");
  assert.ok(files.includes("README.md"), "the remote's content is merged in, not lost");
});

test("gitForceOverwrite push replaces the remote with local; pull resets local to the remote", async () => {
  const push = seededRemote();
  const wsPush = legacyUnrelatedWs(push.url);
  await gitForceOverwrite(wsPush, "push");
  const pushed = remoteFiles(push.path);
  assert.ok(pushed.includes("projects/mine.txt"), "local made it to the remote");
  assert.ok(!pushed.includes("README.md"), "remote overwritten — its old content is gone");

  const pull = seededRemote();
  const wsPull = legacyUnrelatedWs(pull.url);
  await gitForceOverwrite(wsPull, "pull");
  assert.ok(existsSync(join(wsPull, "README.md")), "local now matches the remote (README pulled in)");
});

test("gitResolveConflicts 'mine' keeps my version on the shared document", async () => {
  const { remote, wsB } = await conflictSetup();
  const resolved = await gitResolveConflicts(wsB, [{ docId: "doc", choice: "mine" }]);
  assert.ok(resolved.pushed);
  assert.equal(resolved.forked.length, 0, "no fork when keeping mine");
  assert.equal(remoteShow(remote, "projects/doc/page.html").trim(), "B version", "my version won");
});

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
