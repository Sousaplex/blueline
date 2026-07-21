// web_search: Gemini with Google-Search grounding — a real search without an
// extra API key. Returns a synthesized answer plus the grounded source URLs,
// which the agent can then web_fetch for detail.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GoogleGenAI } from "@google/genai";
import type { PresscheckConfig } from "./config.ts";
import { requireApiKey } from "./config.ts";
import type { Project } from "./project.ts";

function budgetFile(project: Project): string {
  return join(project.fetchedDir, ".search-budget.json");
}

export function resetSearchBudget(project: Project): void {
  writeFileSync(budgetFile(project), JSON.stringify({ used: 0 }));
}

function consumeSearchBudget(project: Project, max: number): void {
  const file = budgetFile(project);
  const used: number = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).used : 0;
  if (used >= max) {
    throw new Error(`Web search budget exhausted (${max} per run). Work with what you already found.`);
  }
  writeFileSync(file, JSON.stringify({ used: used + 1 }));
}

export async function runWebSearch(project: Project, config: PresscheckConfig, query: string): Promise<string> {
  consumeSearchBudget(project, config.webSearch.maxSearchesPerRun);
  const apiKey = requireApiKey(config.webSearch.apiKeyEnv ?? "GEMINI_API_KEY", "web search");
  const ai = new GoogleGenAI({ apiKey });

  const response = await ai.models.generateContent({
    model: config.webSearch.model,
    contents: [
      {
        role: "user",
        parts: [
          {
            text:
              `Research this and answer factually with specifics (names, numbers, dates): ${query}\n` +
              `Keep it under 300 words.`,
          },
        ],
      },
    ],
    config: { tools: [{ googleSearch: {} }] },
  });

  const answer = response.text ?? "(no answer)";
  const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
  const sources = chunks
    .map((c: any) => c.web)
    .filter(Boolean)
    .map((w: any, i: number) => `${i + 1}. ${w.title ?? w.uri} — ${w.uri}`)
    .slice(0, 8);

  return sources.length
    ? `${answer}\n\nSources (use web_fetch to read any of these):\n${sources.join("\n")}`
    : answer;
}
