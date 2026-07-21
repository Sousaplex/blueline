// render: projects/<slug>/page.html -> projects/<slug>/out/proof.pdf
// Thin CLI wrapper over the engine render backend.
import { loadConfig } from "../engine/config.ts";
import { Project } from "../engine/project.ts";
import { PlaywrightBackend } from "../engine/render.ts";

const projectDir = process.argv[2];
if (!projectDir) throw new Error("usage: npm run render -- projects/<slug>");

const project = new Project(projectDir);
const backend = new PlaywrightBackend();
try {
  await backend.renderPdf(project.pageHtml, project.proofPdf, loadConfig().render);
  console.log(`wrote ${project.proofPdf}`);
} finally {
  await backend.close();
}
