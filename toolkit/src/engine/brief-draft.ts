// AI brief drafting: expand a rough one-liner ("one pager for the eISF feature")
// into a structured brief the form can load — the human tweaks from there.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GoogleGenAI, Type as GType } from "@google/genai";
import type { BluelineConfig } from "./config.ts";
import { requireApiKey } from "./config.ts";
import { listSourceFiles } from "./project.ts";
import type { Workspace } from "./workspace.ts";

export interface DraftedBrief {
  title: string;
  audience: string;
  goal: string;
  messages: string[];
  mustInclude: string[];
  tone: string;
}

const BRIEF_SCHEMA = {
  type: GType.OBJECT,
  properties: {
    title: { type: GType.STRING, description: 'what the piece is, e.g. "Trade-show one-pager for Clincove eISF"' },
    audience: { type: GType.STRING, description: "one specific reader, not a demographic" },
    goal: { type: GType.STRING, description: "the action the reader should take" },
    messages: { type: GType.ARRAY, items: { type: GType.STRING }, description: "max 3 key messages, most important first" },
    mustInclude: { type: GType.ARRAY, items: { type: GType.STRING }, description: "hard requirements only: logo, CTA, legal line…" },
    tone: { type: GType.STRING, description: "2-3 adjectives" },
  },
  required: ["title", "audience", "goal", "messages", "mustInclude", "tone"],
};

export async function draftBrief(
  workspace: Workspace,
  config: BluelineConfig,
  idea: string,
  format?: string,
): Promise<DraftedBrief> {
  const apiKey = requireApiKey(config.reviewer.apiKeyEnv ?? "GEMINI_API_KEY", "brief drafting");
  const ai = new GoogleGenAI({ apiKey });
  const brand = listSourceFiles(workspace.brandDir)
    .filter((f) => f.kind === "text")
    .map((f) => readFileSync(join(workspace.brandDir, f.path), "utf8"))
    .join("\n\n")
    .slice(0, 4000);
  const response = await ai.models.generateContent({
    model: config.reviewer.model,
    contents: [
      {
        role: "user",
        parts: [
          {
            text: [
              "Write a structured creative brief for a piece of print marketing collateral from the",
              "rough idea below. Be concrete and specific — real claims a designer can set in type,",
              "never lorem or placeholders. Key messages: at most 3, ordered by importance (the first",
              "becomes headline territory). Must-include: hard requirements only. Do NOT include",
              "layout instructions — layout is the designer's job.",
              "",
              `# Idea\n${idea}`,
              format ? `\n# Format\n${format}` : "",
              brand ? `\n# Brand guidelines (match their voice and tone)\n${brand}` : "",
            ].join("\n"),
          },
        ],
      },
    ],
    config: { responseMimeType: "application/json", responseSchema: BRIEF_SCHEMA },
  });
  const parsed = JSON.parse(response.text ?? "{}") as DraftedBrief;
  if (!parsed.title?.trim()) throw new Error("Brief drafting returned nothing usable — try rephrasing the idea");
  return {
    title: parsed.title.trim(),
    audience: parsed.audience?.trim() ?? "",
    goal: parsed.goal?.trim() ?? "",
    messages: (parsed.messages ?? []).map((m) => m.trim()).filter(Boolean).slice(0, 3),
    mustInclude: (parsed.mustInclude ?? []).map((m) => m.trim()).filter(Boolean),
    tone: parsed.tone?.trim() ?? "",
  };
}
