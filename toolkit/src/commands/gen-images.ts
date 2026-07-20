// gen-images: reads projects/<slug>/images/prompts.json, generates variants via
// the configured image provider, writes images/<id>/v<N>.png.
// TODO(next slice): implement GeminiImageProvider in providers/gemini.ts.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ImagePromptSpec } from "../providers/types.js";

const projectDir = process.argv[2];
if (!projectDir) throw new Error("usage: npm run gen-images -- projects/<slug>");

const dir = resolve(process.cwd(), "..", projectDir);
const specs: ImagePromptSpec[] = JSON.parse(
  await readFile(`${dir}/images/prompts.json`, "utf8"),
);
console.log(`loaded ${specs.length} prompt specs from ${projectDir}`);
throw new Error("gen-images: provider not implemented yet — see providers/types.ts");
