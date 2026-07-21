// review: rasterize out/proof.pdf and get a structured verdict from the vision reviewer.
import { loadConfig } from "../engine/config.ts";
import { Project } from "../engine/project.ts";
import { runReview } from "../engine/review.ts";

const projectDir = process.argv[2];
if (!projectDir) throw new Error("usage: npm run review -- projects/<slug>");

const project = new Project(projectDir);
const { round, result } = await runReview(project, loadConfig());
console.log(`round ${round}: ${result.verdict}`);
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.verdict === "pass" ? 0 : 2;
