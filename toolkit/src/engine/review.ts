import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { GoogleGenAI, Type as GType } from "@google/genai";
import type { ReviewResult } from "../providers/types.ts";
import type { PresscheckConfig } from "./config.ts";
import { requireApiKey } from "./config.ts";
import type { Project } from "./project.ts";

export class RoundLimitError extends Error {
  constructor(maxRounds: number) {
    super(
      `Review round limit reached (${maxRounds}). Stop iterating: summarize the remaining issues from the latest review for the human instead.`,
    );
  }
}

const REVIEW_SCHEMA = {
  type: GType.OBJECT,
  properties: {
    verdict: { type: GType.STRING, enum: ["pass", "revise"] },
    issues: {
      type: GType.ARRAY,
      items: {
        type: GType.OBJECT,
        properties: {
          page: { type: GType.INTEGER },
          region: { type: GType.STRING },
          problem: { type: GType.STRING },
          fix: { type: GType.STRING },
        },
        required: ["page", "region", "problem", "fix"],
      },
    },
    notes: { type: GType.STRING },
  },
  required: ["verdict", "issues"],
};

async function rasterizePdf(pdfPath: string): Promise<Buffer[]> {
  const { pdf } = await import("pdf-to-img");
  const doc = await pdf(pdfPath, { scale: 2 });
  const pages: Buffer[] = [];
  for await (const page of doc) pages.push(Buffer.from(page));
  return pages;
}

/** Rasterize the proof, ask the vision reviewer, persist review/round-N.json. */
export async function runReview(
  project: Project,
  config: PresscheckConfig,
): Promise<{ round: number; result: ReviewResult; pageCount: number }> {
  const completed = project.completedRounds();
  if (completed >= config.reviewer.maxRounds) throw new RoundLimitError(config.reviewer.maxRounds);
  if (!existsSync(project.proofPdf)) {
    throw new Error(`No proof.pdf found — call the render tool before requesting a review.`);
  }

  const pages = await rasterizePdf(project.proofPdf);
  const apiKey = requireApiKey(config.reviewer.apiKeyEnv ?? "GEMINI_API_KEY", "reviewer");
  const ai = new GoogleGenAI({ apiKey });

  const priorRounds = completed > 0 ? JSON.stringify(project.latestReview()?.result) : "none";
  const instruction = [
    "You are a meticulous print-production reviewer (a press check).",
    "You are shown the rendered PDF pages of a marketing piece, its brief, and the brand style guide.",
    "Judge ONLY what is visible: layout, pagination breaks, clipping, overflow, whitespace balance,",
    "font fallbacks, image placement/sizing, contrast, brand adherence, and fit to the brief's format.",
    "Web-to-PDF rendering is messy — look specifically for clipped edges, orphaned elements, and broken pagination.",
    "Be strict but terminating: if the piece is close enough that a human would sign off, verdict is `pass`.",
    `This is review round ${completed + 1} of at most ${config.reviewer.maxRounds}.`,
    "",
    `# Brief\n${project.brief()}`,
    "",
    `# Style guide\n${project.styleGuide() || "(none provided)"}`,
    "",
    `# Previous review round\n${priorRounds}`,
  ].join("\n");

  const response = await ai.models.generateContent({
    model: config.reviewer.model,
    contents: [
      {
        role: "user",
        parts: [
          { text: instruction },
          ...pages.map((p) => ({ inlineData: { mimeType: "image/png", data: p.toString("base64") } })),
        ],
      },
    ],
    config: {
      responseMimeType: "application/json",
      responseSchema: REVIEW_SCHEMA,
    },
  });

  const result = JSON.parse(response.text ?? "{}") as ReviewResult;
  if (result.verdict !== "pass" && result.verdict !== "revise") {
    throw new Error(`Reviewer returned malformed result: ${response.text?.slice(0, 300)}`);
  }
  const round = completed + 1;
  project.writeReview(round, result);
  // Archive the exact proof this verdict was issued against — makes rounds navigable in the viewer.
  copyFileSync(project.proofPdf, join(project.reviewDir, `round-${round}.pdf`));
  return { round, result, pageCount: pages.length };
}
