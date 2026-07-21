import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GoogleGenAI, Type as GType } from "@google/genai";
import type { ReviewResult } from "../providers/types.ts";
import type { PresscheckConfig } from "./config.ts";
import { requireApiKey } from "./config.ts";
import type { Project } from "./project.ts";
import { analyzePage, catastrophicBands, describeWhitespace } from "./whitespace.ts";

export class RoundLimitError extends Error {
  constructor(maxRounds: number) {
    super(
      `Review round limit reached (${maxRounds}). Stop iterating: summarize the remaining issues from the latest review for the human instead.`,
    );
  }
}

/** The round cap is per RUN, not per project lifetime — this marks where a run started. */
export function markRunStart(project: Project): void {
  writeFileSync(join(project.dir, ".run-start.json"), JSON.stringify({ startRound: project.completedRounds() }));
}

function runStartRound(project: Project): number {
  const p = join(project.dir, ".run-start.json");
  if (!existsSync(p)) return 0;
  try {
    return Number(JSON.parse(readFileSync(p, "utf8")).startRound) || 0;
  } catch {
    return 0;
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
  const thisRun = completed - runStartRound(project);
  if (thisRun >= config.reviewer.maxRounds) throw new RoundLimitError(config.reviewer.maxRounds);
  if (!existsSync(project.proofPdf)) {
    throw new Error(`No proof.pdf found — call the render tool before requesting a review.`);
  }

  const pages = await rasterizePdf(project.proofPdf);
  const whitespace = pages.map((p, i) => analyzePage(p, i + 1));
  const settings = project.meta().settings;
  const apiKey = requireApiKey(config.reviewer.apiKeyEnv ?? "GEMINI_API_KEY", "reviewer");
  const ai = new GoogleGenAI({ apiKey });

  const priorRounds = completed > 0 ? JSON.stringify(project.latestReview()?.result) : "none";
  const instruction = [
    "You are a meticulous print-production reviewer AND art director (a press check).",
    "You are shown the rendered PDF pages of a marketing piece, its brief, and the brand style guide.",
    "Judge ONLY what is visible: layout, pagination breaks, clipping, overflow,",
    "font fallbacks, image placement/sizing, contrast, brand adherence, and fit to the brief's format.",
    "Web-to-PDF rendering is messy — look specifically for clipped edges, orphaned elements, and broken pagination.",
    "",
    "Composition checks you MUST apply on every round:",
    "- Dead space: flag any empty region larger than ~10% of the page that is not deliberate",
    "  breathing room around a focal element. Name the region (e.g. 'left column, between",
    "  sections 2 and 3') and the fix (rebalance columns, scale an element, tighten the grid).",
    "- Rhythm: uneven vertical gaps between equivalent sections are a defect.",
    "- Balance: assess visual weight left/right and top/bottom; a text-dense side facing a",
    "  sparse side without a counterweight is a defect.",
    "- Hierarchy: there must be ONE dominant focal element; a wall of equal-weight blocks is a defect.",
    "- Justified body text with visible rivers/gaps in narrow columns is a defect.",
    "A piece exhibiting two or more composition defects can NEVER be a pass, even if technically clean.",
    "",
    "Be strict but terminating: if the piece is close enough that a demanding human art director",
    "would sign off, verdict is `pass`.",
    "",
    "MEASURED whitespace facts (computed from the rendered pixels — trust these over your own estimate):",
    describeWhitespace(whitespace),
    "Any measured interior empty band taller than ~12% of the page is dead space unless it is",
    "unmistakably deliberate framing; name it in issues with a concrete layout fix.",
    "",
    `Required format: ${settings.pageSize} ${settings.orientation}, EXACTLY ${settings.pages} page(s).`,
    `The rendered proof has ${pages.length} page(s) — a wrong page count is an automatic revise.`,
    `This is review round ${thisRun + 1} of at most ${config.reviewer.maxRounds} for this run (round ${completed + 1} in the project's history).`,
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

  // Hard gate: the wrong page count can never pass, no matter what the model says.
  if (result.verdict === "pass" && pages.length !== settings.pages) {
    result.verdict = "revise";
    result.issues = [
      ...(result.issues ?? []),
      {
        page: pages.length,
        region: "document",
        problem: `Page count is ${pages.length} but the project requires exactly ${settings.pages} (mechanical check).`,
        fix:
          pages.length > settings.pages
            ? "Content overflows the target length: tighten spacing, cut copy, or scale elements down so nothing spills onto an extra page."
            : "The piece is shorter than the required length: expand the layout to fill the specified number of pages.",
      },
    ];
    result.notes = `${result.notes ?? ""} [auto] Verdict downgraded to revise: page count mismatch.`.trim();
  }

  // Hard gate: a giant interior dead band can never pass, no matter what the model says.
  const catastrophic = catastrophicBands(whitespace);
  if (result.verdict === "pass" && catastrophic.length) {
    result.verdict = "revise";
    result.issues = [
      ...(result.issues ?? []),
      ...catastrophic.map(({ page, band }) => ({
        page,
        region: `full-width band ${band.fromPct}%–${band.toPct}% of page height`,
        problem: `Measured dead space: this band is ${band.toPct - band.fromPct}% of the page and completely empty (mechanical check — not a matter of taste).`,
        fix: "Restructure the layout so content composes the full canvas: rebalance columns, enlarge the hero/type, or tighten the page grid. Do not just stretch margins.",
      })),
    ];
    result.notes = `${result.notes ?? ""} [auto] Verdict downgraded to revise: measured interior dead space exceeded the hard threshold.`.trim();
  }

  const round = completed + 1;
  project.writeReview(round, result);
  // Archive the exact proof AND page.html this verdict was issued against — makes rounds
  // navigable in the viewer and branchable later (page.html is self-contained by contract;
  // image variants are append-only, so relative image refs stay valid forever).
  copyFileSync(project.proofPdf, join(project.reviewDir, `round-${round}.pdf`));
  if (existsSync(project.pageHtml)) copyFileSync(project.pageHtml, project.roundHtml(round));
  return { round, result, pageCount: pages.length };
}
