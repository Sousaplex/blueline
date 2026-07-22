// Design-direction variants: propose N clearly distinct directions for a brief,
// then fan them out as sibling projects that run through the parallel queue.
import { GoogleGenAI, Type as GType } from "@google/genai";
import type { BluelineConfig } from "./config.ts";
import { requireApiKey } from "./config.ts";
import type { Project } from "./project.ts";

export interface Direction {
  label: string;
  direction: string;
}

const DIRECTIONS_SCHEMA = {
  type: GType.ARRAY,
  items: {
    type: GType.OBJECT,
    properties: {
      label: { type: GType.STRING, description: "2-3 word kebab-case label, e.g. bold-editorial" },
      direction: { type: GType.STRING, description: "3-5 sentences describing the visual direction" },
    },
    required: ["label", "direction"],
  },
};

export async function suggestDirections(
  project: Project,
  config: BluelineConfig,
  count: number,
): Promise<Direction[]> {
  const apiKey = requireApiKey(config.reviewer.apiKeyEnv ?? "GEMINI_API_KEY", "variant suggestions");
  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model: config.reviewer.model,
    contents: [
      {
        role: "user",
        parts: [
          {
            text: [
              `Propose ${count} CLEARLY DISTINCT design directions for this print piece.`,
              "Each direction must stay within the brand style guide but differ meaningfully in",
              "layout structure, imagery mood, typographic emphasis, and use of the brand palette.",
              "Directions should be actionable instructions for a layout designer, not vibes.",
              "",
              `# Brief\n${project.brief()}`,
              "",
              `# Brand guidelines\n${project.brandGuide() || "(none)"}`,
            ].join("\n"),
          },
        ],
      },
    ],
    config: { responseMimeType: "application/json", responseSchema: DIRECTIONS_SCHEMA },
  });
  const parsed = JSON.parse(response.text ?? "[]") as Direction[];
  if (!Array.isArray(parsed) || !parsed.length) throw new Error("Direction suggestion returned nothing usable");
  return parsed.slice(0, count).map((d) => ({
    label: d.label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24),
    direction: d.direction,
  }));
}

export function variantBrief(baseBrief: string, direction: Direction): string {
  return `${baseBrief.trimEnd()}

## Design direction (variant: ${direction.label})
${direction.direction}
Follow this direction decisively — this variant exists to explore it, not to hedge toward a middle ground.
`;
}
