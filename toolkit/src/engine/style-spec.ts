// Measured design-system spec: real computed typography per element role and the
// actual vertical gaps between adjacent blocks, extracted from a rendered page.
// Saved with templates and series so sibling documents can't quietly drift —
// the numbers go into the designer prompt AND the reviewer's checklist.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Project } from "./project.ts";
import type { RenderBackend } from "./render.ts";

export interface TextStyle {
  role: string; // "h1", "h2", "p.eyebrow", or the data-pc-id when more specific
  sample: string; // first few words, so a human/agent can identify the element
  fontFamily: string;
  fontSizePx: number;
  fontWeight: string;
  lineHeight: string;
  letterSpacing: string;
  color: string;
  textTransform: string;
}

export interface BlockGap {
  above: string; // data-pc-id (or tag) of the upper block
  below: string;
  gapMm: number; // measured edge-to-edge vertical distance
}

export interface StyleSpec {
  text: TextStyle[];
  gaps: BlockGap[];
  pagePaddingMm?: { top: number; left: number };
}

const PX_TO_MM = 25.4 / 96;

export function styleSpecPath(dir: string): string {
  return join(dir, "style-spec.json");
}

// Plain-JS string, NOT a function: tsx's transpile injects a __name() helper into
// serialized callbacks which doesn't exist inside the page (Playwright evaluates
// the function's SOURCE). A string script sidesteps the whole class of bug.
const EXTRACT_SCRIPT = `(() => {
  const MM = 25.4 / 96;
  const round = (n) => Math.round(n * 10) / 10;
  const seen = new Set();
  const text = [];
  document.querySelectorAll("h1, h2, h3, h4, p, li, blockquote, [data-pc-id]").forEach((el) => {
    const direct = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent && n.textContent.trim());
    if (!direct) return;
    const cs = getComputedStyle(el);
    const cls = (el.className && typeof el.className === "string" ? el.className.split(/\\s+/)[0] : "") || "";
    const role = el.getAttribute("data-pc-id") || (cls ? el.tagName.toLowerCase() + "." + cls : el.tagName.toLowerCase());
    const key = [el.tagName, cs.fontSize, cs.fontWeight, cs.textTransform, cs.color].join("|");
    if (seen.has(key)) return;
    seen.add(key);
    text.push({
      role,
      sample: (el.textContent || "").trim().slice(0, 40),
      fontFamily: cs.fontFamily.split(",")[0].replace(/["']/g, "").trim(),
      fontSizePx: round(parseFloat(cs.fontSize)),
      fontWeight: cs.fontWeight,
      lineHeight: cs.lineHeight === "normal" ? "normal" : round(parseFloat(cs.lineHeight)) + "px",
      letterSpacing: cs.letterSpacing,
      color: cs.color,
      textTransform: cs.textTransform,
    });
  });

  const topBlocks = [...document.querySelectorAll("[data-pc-id]")]
    .filter((el) => !(el.parentElement && el.parentElement.closest("[data-pc-id]")))
    .map((el) => ({ el, rect: el.getBoundingClientRect() }))
    .filter((b) => b.rect.height > 0)
    .sort((a, b) => a.rect.top - b.rect.top);
  const gaps = [];
  for (let i = 1; i < topBlocks.length; i++) {
    const gap = topBlocks[i].rect.top - topBlocks[i - 1].rect.bottom;
    if (gap >= 0 && gap < 400) {
      gaps.push({
        above: topBlocks[i - 1].el.getAttribute("data-pc-id"),
        below: topBlocks[i].el.getAttribute("data-pc-id"),
        gapMm: round(gap * MM),
      });
    }
  }

  const first = topBlocks[0];
  const bodyCs = getComputedStyle(document.body);
  const pagePaddingMm = first
    ? { top: round(first.rect.top * MM), left: round((parseFloat(bodyCs.paddingLeft) + parseFloat(bodyCs.marginLeft)) * MM) }
    : undefined;

  return { text: text.slice(0, 24), gaps: gaps.slice(0, 24), pagePaddingMm };
})()`;

/** Load a rendered copy of page.html and measure what the design actually does. */
export async function extractStyleSpec(project: Project, backend: RenderBackend): Promise<StyleSpec> {
  return backend.withPage(async (page) => {
    await page.goto(`file://${project.pageHtml}`, { waitUntil: "networkidle" });
    return (await page.evaluate(EXTRACT_SCRIPT)) as StyleSpec;
  });
}

export function saveStyleSpec(dir: string, spec: StyleSpec): void {
  writeFileSync(styleSpecPath(dir), JSON.stringify(spec, null, 2) + "\n");
}

export function loadStyleSpec(dir: string): StyleSpec | null {
  const p = styleSpecPath(dir);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/** Compact human/agent-readable rendering of the spec for prompts and reviews. */
export function formatStyleSpec(spec: StyleSpec): string {
  const lines: string[] = [];
  if (spec.text.length) {
    lines.push("Type styles (measured — match EXACTLY):");
    for (const t of spec.text) {
      lines.push(
        `- ${t.role} ("${t.sample}"): ${t.fontFamily} ${t.fontSizePx}px/${t.lineHeight} weight ${t.fontWeight}` +
          `${t.letterSpacing !== "normal" ? ` tracking ${t.letterSpacing}` : ""}` +
          `${t.textTransform !== "none" ? ` ${t.textTransform}` : ""}, ${t.color}`,
      );
    }
  }
  if (spec.gaps.length) {
    lines.push("", "Vertical spacing between blocks (measured — match within 1mm):");
    for (const g of spec.gaps) lines.push(`- ${g.above} -> ${g.below}: ${g.gapMm}mm`);
  }
  if (spec.pagePaddingMm) {
    lines.push("", `First block starts ${spec.pagePaddingMm.top}mm from the page top; left padding ${spec.pagePaddingMm.left}mm.`);
  }
  return lines.join("\n");
}
