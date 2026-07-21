import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GoogleGenAI } from "@google/genai";
import type { ImagePromptSpec } from "../providers/types.ts";
import type { PresscheckConfig } from "./config.ts";
import { requireApiKey } from "./config.ts";
import type { Project } from "./project.ts";

export interface GeneratedImageSummary {
  id: string;
  files: string[];
  errors: string[];
}

/** Next free variant number so re-generation never overwrites existing variants. */
function nextVariant(dir: string): number {
  if (!existsSync(dir)) return 1;
  const nums = readdirSync(dir)
    .map((f) => /^v(\d+)\.png$/.exec(f)?.[1])
    .filter(Boolean)
    .map(Number);
  return nums.length ? Math.max(...nums) + 1 : 1;
}

export async function generateImages(
  project: Project,
  config: PresscheckConfig,
  onlyIds?: string[],
): Promise<GeneratedImageSummary[]> {
  if (!existsSync(project.promptsJson)) {
    throw new Error(`No images/prompts.json — write the image prompt specs first.`);
  }
  const specs: ImagePromptSpec[] = JSON.parse(readFileSync(project.promptsJson, "utf8"));
  const selected = onlyIds?.length ? specs.filter((s) => onlyIds.includes(s.id)) : specs;
  if (!selected.length) throw new Error(`No matching prompt specs (requested: ${onlyIds?.join(", ")})`);

  const apiKey = requireApiKey(config.images.apiKeyEnv ?? "GEMINI_API_KEY", "image generation");
  const ai = new GoogleGenAI({ apiKey });
  const styleNotes = project.styleGuide();

  const summaries: GeneratedImageSummary[] = [];
  for (const spec of selected) {
    const dir = join(project.imagesDir, spec.id);
    mkdirSync(dir, { recursive: true });
    const summary: GeneratedImageSummary = { id: spec.id, files: [], errors: [] };
    const variants = spec.variants ?? config.images.variantsPerPrompt;

    for (let i = 0; i < variants; i++) {
      try {
        const response = await ai.models.generateContent({
          model: config.images.model,
          contents: [
            {
              role: "user",
              parts: [
                {
                  text:
                    `${spec.prompt}\n\nAspect ratio: ${spec.aspect}. ` +
                    `This image is for a printed marketing piece — high resolution, no text or lettering in the image.` +
                    (styleNotes ? `\nBrand style notes:\n${styleNotes.slice(0, 2000)}` : ""),
                },
              ],
            },
          ],
        });
        const parts = response.candidates?.[0]?.content?.parts ?? [];
        const image = parts.find((p: any) => p.inlineData?.data);
        if (!image?.inlineData?.data) {
          summary.errors.push(`variant ${i + 1}: model returned no image data`);
          continue;
        }
        const file = join(dir, `v${nextVariant(dir)}.png`);
        writeFileSync(file, Buffer.from(image.inlineData.data, "base64"));
        summary.files.push(file);
      } catch (err) {
        summary.errors.push(`variant ${i + 1}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    summaries.push(summary);
  }
  return summaries;
}
