// Guard tests: workspace source curation (write_source/write_brand/organize_sources helpers).
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const { Workspace } = await import("./workspace.ts");
const { moveWorkspaceFiles, writeWorkspaceDoc } = await import("./sources.ts");

function tempWorkspace(): InstanceType<typeof Workspace> {
  return new Workspace(mkdtempSync(join(tmpdir(), "pc-ws-"))).ensure();
}

test("writeWorkspaceDoc creates nested docs and reports create vs update", () => {
  const ws = tempWorkspace();
  const first = writeWorkspaceDoc(ws, "context", "acme/product-facts.md", "# Facts\n- a");
  assert.equal(first.updated, false);
  assert.equal(readFileSync(join(ws.contextDir, "acme/product-facts.md"), "utf8"), "# Facts\n- a\n");
  const second = writeWorkspaceDoc(ws, "context", "acme/product-facts.md", "# Facts v2");
  assert.equal(second.updated, true);
});

test("writeWorkspaceDoc rejects traversal, non-text paths, and empty content", () => {
  const ws = tempWorkspace();
  assert.throws(() => writeWorkspaceDoc(ws, "context", "../escape.md", "x"), /Invalid path/);
  assert.throws(() => writeWorkspaceDoc(ws, "brand", "logo.png", "x"), /Only \.md\/\.txt/);
  assert.throws(() => writeWorkspaceDoc(ws, "brand", "voice.md", "   \n"), /empty/);
});

test("moveWorkspaceFiles renames within and across areas", () => {
  const ws = tempWorkspace();
  writeFileSync(join(ws.contextDir, "notes.md"), "n");
  writeFileSync(join(ws.contextDir, "palette.md"), "p");
  const moved = moveWorkspaceFiles(ws, [
    { from: "context/notes.md", to: "context/acme/notes.md" },
    { from: "context/palette.md", to: "brand/palette.md" },
  ]);
  assert.deepEqual(moved, ["context/notes.md -> context/acme/notes.md", "context/palette.md -> brand/palette.md"]);
  assert.ok(existsSync(join(ws.contextDir, "acme/notes.md")));
  assert.ok(existsSync(join(ws.brandDir, "palette.md")));
  assert.ok(!existsSync(join(ws.contextDir, "notes.md")));
});

test("moveWorkspaceFiles never overwrites and validates the whole batch first", () => {
  const ws = tempWorkspace();
  writeFileSync(join(ws.contextDir, "a.md"), "a");
  writeFileSync(join(ws.contextDir, "b.md"), "b");
  assert.throws(() => moveWorkspaceFiles(ws, [{ from: "context/a.md", to: "context/b.md" }]), /already exists/);
  // second move is invalid -> first must NOT have been applied
  assert.throws(
    () => moveWorkspaceFiles(ws, [
      { from: "context/a.md", to: "context/a2.md" },
      { from: "context/missing.md", to: "context/x.md" },
    ]),
    /No such file/,
  );
  assert.ok(existsSync(join(ws.contextDir, "a.md")), "batch must be atomic — a.md moved despite failed batch");
  // two moves claiming the same destination
  assert.throws(
    () => moveWorkspaceFiles(ws, [
      { from: "context/a.md", to: "context/same.md" },
      { from: "context/b.md", to: "context/same.md" },
    ]),
    /already exists/,
  );
});

test("moveWorkspaceFiles rejects unprefixed or traversal paths", () => {
  const ws = tempWorkspace();
  writeFileSync(join(ws.contextDir, "a.md"), "a");
  assert.throws(() => moveWorkspaceFiles(ws, [{ from: "a.md", to: "context/b.md" }]), /must start with/);
  assert.throws(() => moveWorkspaceFiles(ws, [{ from: "context/a.md", to: "brand" }]), /must start with/);
  assert.throws(() => moveWorkspaceFiles(ws, [{ from: "context/../a.md", to: "context/b.md" }]), /Invalid path/);
});
