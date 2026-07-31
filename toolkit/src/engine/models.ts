// Live model discovery + diagnostics. The hardcoded model lists went stale (Google renames/retires
// models), which silently broke generation on fresh installs. Listing from the API keeps the
// picker current and — when it fails — surfaces the real reason (bad key, region, quota) instead
// of a silent stall.
import { GoogleGenAI } from "@google/genai";

export interface AvailableModels {
  /** Model ids that support text generation (generateContent), e.g. "gemini-3.5-flash". */
  generate: string[];
  /** Model ids for image generation. */
  image: string[];
  /** Present when listing failed — the real API error (the key diagnostic). */
  error?: string;
}

const stripPrefix = (name: string) => name.replace(/^models\//, "");

/** Ask Google which models this API key can actually use. Never throws — errors come back in `error`. */
export async function listGoogleModels(apiKey: string | undefined): Promise<AvailableModels> {
  if (!apiKey) return { generate: [], image: [], error: "No GEMINI_API_KEY set." };
  try {
    const ai = new GoogleGenAI({ apiKey });
    const pager = await ai.models.list();
    const all: { name: string; actions: string[] }[] = [];
    for await (const m of pager) {
      if (m.name) all.push({ name: stripPrefix(m.name), actions: m.supportedActions ?? [] });
      if (all.length >= 500) break; // safety cap
    }
    const genMethods = new Set(["generateContent", "bidiGenerateContent"]);
    const generate = all
      .filter((m) => !/embedding|aqa|imagen/i.test(m.name) && (m.actions.some((a) => genMethods.has(a)) || /gemini/i.test(m.name)))
      .filter((m) => !/image/i.test(m.name))
      .map((m) => m.name);
    const image = all.filter((m) => /image|imagen/i.test(m.name)).map((m) => m.name);
    const dedupeSort = (xs: string[]) => [...new Set(xs)].sort();
    return { generate: dedupeSort(generate), image: dedupeSort(image) };
  } catch (err: any) {
    return { generate: [], image: [], error: err?.message ? String(err.message) : String(err) };
  }
}
