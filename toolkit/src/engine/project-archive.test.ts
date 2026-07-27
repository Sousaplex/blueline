import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Workspace } from "./workspace.ts";
import { Project } from "./project.ts";
import { exportBundle, exportDocument, importArchive } from "./project-archive.ts";

function seedProject(ws: Workspace, slug: string, meta: Record<string, unknown>): Project {
  const dir = join(ws.projectsDir, slug);
  mkdirSync(join(dir, "images", "hero"), { recursive: true });
  writeFileSync(join(dir, "brief.md"), `# ${slug}\n`);
  writeFileSync(join(dir, "page.html"), `<html><body><img data-image-id="hero" src="images/hero/v1.png"></body></html>`);
  writeFileSync(join(dir, "images", "hero", "v1.png"), Buffer.from([9, 9, 9]));
  const p = new Project(dir, ws);
  p.updateMeta(meta as any);
  return p;
}

test(".blueline round-trips one self-contained document", () => {
  const src = new Workspace(mkdtempSync(join(tmpdir(), "arc-src-"))).ensure();
  const root = seedProject(src, "flyer", { displayName: "Flyer" });
  const { filename, data } = exportDocument(root);
  assert.match(filename, /\.blueline$/);

  const dst = new Workspace(mkdtempSync(join(tmpdir(), "arc-dst-"))).ensure();
  const r = importArchive(dst, data);
  assert.equal(r.kind, "document");
  assert.ok(existsSync(join(dst.projectsDir, r.open, "page.html")));
  assert.ok(existsSync(join(dst.projectsDir, r.open, "images/hero/v1.png")), "images travel with the doc");
});

test(".blueproject bundles a family + brand and rewrites lineage on import", () => {
  const src = new Workspace(mkdtempSync(join(tmpdir(), "arc-src-"))).ensure();
  writeFileSync(join(src.brandDir, "logo.png"), Buffer.from([1, 2, 3]));
  seedProject(src, "set-root", { displayName: "Root", series: "the-set" });
  seedProject(src, "set-bold", { displayName: "Bold", series: "the-set", parent: "set-root" });
  const { filename, data } = exportBundle(src, "set-bold");
  assert.match(filename, /\.blueproject$/);

  // Import into a workspace that already has a "set-root" → forces a slug collision + remap.
  const dst = new Workspace(mkdtempSync(join(tmpdir(), "arc-dst-"))).ensure();
  seedProject(dst, "set-root", { displayName: "Pre-existing" });
  const r = importArchive(dst, data);
  assert.equal(r.kind, "project");
  assert.equal(r.imported.length, 2);
  assert.ok(existsSync(join(dst.brandDir, "logo.png")), "brand asset merged");

  const boldSlug = r.imported.find((d) => d.displayName === "Bold")!.slug;
  const rootSlug = r.imported.find((d) => d.displayName === "Root")!.slug;
  assert.notEqual(rootSlug, "set-root"); // collided → remapped
  const boldMeta = new Project(join(dst.projectsDir, boldSlug), dst).meta();
  assert.equal(boldMeta.parent, rootSlug, "child's parent points at the remapped root");
});
