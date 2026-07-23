import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GoogleGenAI } from "@google/genai";
import type { ImagePromptSpec } from "../providers/types.ts";
import type { BluelineConfig } from "./config.ts";
import { requireApiKey } from "./config.ts";
import { recordImages } from "./cost-ledger.ts";
import type { Project } from "./project.ts";

export interface GeneratedImageSummary {
  id: string;
  files: string[];
  errors: string[];
}

/** Real generateContent-capable image model ids (verified against ListModels 2026-07-22). */
export const KNOWN_IMAGE_MODELS = [
  "gemini-3.1-flash-image",
  "gemini-3.1-flash-lite-image",
  "gemini-3-pro-image",
  "gemini-2.5-flash-image",
];

// Marketing nicknames people naturally type into Settings — the API only knows
// the gemini-* ids, so "nano-banana-2" 404s verbatim. Map them to the real thing.
const MODEL_ALIASES: Record<string, string> = {
  "nano-banana-2": "gemini-3.1-flash-image",
  "nano banana 2": "gemini-3.1-flash-image",
  "nanobanana2": "gemini-3.1-flash-image",
  "nano-banana-pro": "gemini-3-pro-image",
  "nano banana pro": "gemini-3-pro-image",
  "nano-banana": "gemini-2.5-flash-image",
  "nano banana": "gemini-2.5-flash-image",
};

/** Translate friendly names to API model ids; real ids pass through untouched. */
export function resolveImageModel(model: string): string {
  return MODEL_ALIASES[model.trim().toLowerCase()] ?? model;
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
  config: BluelineConfig,
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
  const model = resolveImageModel(config.images.model);
  const styleNotes = project.brandGuide();

  const summaries: GeneratedImageSummary[] = [];
  for (const spec of selected) {
    const dir = join(project.imagesDir, spec.id);
    mkdirSync(dir, { recursive: true });
    const summary: GeneratedImageSummary = { id: spec.id, files: [], errors: [] };
    const variants = spec.variants ?? config.images.variantsPerPrompt;

    for (let i = 0; i < variants; i++) {
      try {
        const response = await ai.models.generateContent({
          model,
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
        let msg = err instanceof Error ? err.message : String(err);
        if (/NOT_FOUND|is not found/i.test(msg)) {
          msg += ` — "${model}" is not a valid model id. Known image models: ${KNOWN_IMAGE_MODELS.join(", ")}.`;
        }
        summary.errors.push(`variant ${i + 1}: ${msg}`);
      }
    }
    summaries.push(summary);
  }
  const totalImages = summaries.reduce((n, s) => n + s.files.length, 0);
  if (totalImages) recordImages(project.dir, model, totalImages); // `model` is already resolved
  return summaries;
}
