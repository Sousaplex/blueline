// gen-images: generate image variants from projects/<slug>/images/prompts.json.
import { loadConfig } from "../engine/config.ts";
import { generateImages } from "../engine/images.ts";
import { Project } from "../engine/project.ts";

const projectDir = process.argv[2];
if (!projectDir) throw new Error("usage: npm run gen-images -- projects/<slug> [id ...]");

const project = new Project(projectDir);
const onlyIds = process.argv.slice(3);
const summaries = await generateImages(project, loadConfig(), onlyIds.length ? onlyIds : undefined);
for (const s of summaries) {
  console.log(`${s.id}: ${s.files.length} file(s)${s.errors.length ? ` — errors: ${s.errors.join("; ")}` : ""}`);
}
