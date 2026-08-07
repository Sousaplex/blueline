// export-figma: projects/<slug>/page.html -> projects/<slug>/out/scene.json
// The JSON is consumed by figma-plugin/ (see its README) — Figma's own file format is
// undocumented and its REST API can't create nodes, so a plugin is the supported route.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { exportFigmaScene } from "../engine/figma-scene.ts";
import { Project } from "../engine/project.ts";
import { PlaywrightBackend } from "../engine/render.ts";

const projectDir = process.argv[2];
if (!projectDir) throw new Error("usage: npm run export-figma -- projects/<slug> [out.json]");

const project = new Project(projectDir);
const outPath = process.argv[3] ?? join(project.dir, "out", "scene.json");
const backend = new PlaywrightBackend();
try {
  const scene = await exportFigmaScene(project, backend);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(scene));
  const nodes = scene.pages.reduce((n, p) => n + p.nodes.length, 0);
  console.log(`wrote ${outPath} — ${scene.pages.length} page(s), ${nodes} node(s), ${scene.fonts.length} font(s)`);
  for (const warning of scene.warnings) console.log(`  warning: ${warning}`);
} finally {
  await backend.close();
}
