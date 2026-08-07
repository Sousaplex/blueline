// Figma export: turn a rendered page.html into a flat scene graph Figma can rebuild.
//
// Why a scene graph and not a .fig file: Figma's own format is undocumented, binary
// (Kiwi-serialized) and changes without notice, and the REST API is read-only for node
// creation. The ONLY sanctioned way to create Figma layers is the Plugin API — so we emit a
// plain JSON scene here and let a small plugin (figma-plugin/) build real nodes from it.
//
// The measurement approach is the one already proven by compile.ts and style-spec.ts: load
// the page in the same Chromium that prints the PDF and read real computed layout. Nothing
// is inferred from the HTML source, so what Figma receives matches what the press gets.
//
// Known v1 boundaries (documented, not silently dropped — see exportFigmaScene's warnings):
//   - paint order follows DOM order; explicit z-index is not resolved
//   - gradients, box-shadows and pseudo-element content are not emitted
//   - transforms (rotate/skew) are ignored; the axis-aligned box is used
//   - each text element becomes ONE text node; inline spans with their own styling are
//     flattened into the parent's style
import { readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pageDims, type Project } from "./project.ts";
import type { RenderBackend } from "./render.ts";

export const MM_TO_PX = 96 / 25.4;

export interface SceneRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RectNode extends SceneRect {
  kind: "rect";
  id: string;
  fill: string | null; // "rgba(r, g, b, a)" or null when transparent
  cornerRadii: [number, number, number, number]; // TL, TR, BR, BL
  stroke: { color: string; weight: number } | null;
  opacity: number;
}

export interface TextNode extends SceneRect {
  kind: "text";
  id: string;
  characters: string;
  fontFamily: string;
  fontWeight: number;
  italic: boolean;
  fontSize: number;
  lineHeightPx: number | null; // null = "normal", let Figma decide
  letterSpacingPx: number;
  color: string;
  textAlign: "left" | "center" | "right" | "justified";
  textTransform: string;
  opacity: number;
}

export interface ImageNode extends SceneRect {
  kind: "image";
  id: string;
  /** The photo's box RELATIVE TO the frame box above — reproduces the crop exactly. */
  inner: SceneRect;
  /** base64 payload so scene.json is self-contained (a plugin cannot read local disk). */
  dataBase64: string;
  mimeType: string;
  cornerRadii: [number, number, number, number];
  opacity: number;
}

export type SceneNode = RectNode | TextNode | ImageNode;

export interface ScenePage {
  index: number;
  width: number;
  height: number;
  background: string | null;
  nodes: SceneNode[];
}

export interface FigmaScene {
  version: 1;
  name: string;
  /** CSS px per millimetre, so a consumer can convert back to print units. */
  pxPerMm: number;
  pageWidthMm: number;
  pageHeightMm: number;
  /** Distinct font families used, so the plugin can preload before creating text. */
  fonts: { family: string; weight: number; italic: boolean }[];
  pages: ScenePage[];
  warnings: string[];
}

/** Raw measurement handed back by the in-page script, before image bytes are attached. */
interface RawExtract {
  docWidth: number;
  docHeight: number;
  pageBoxes: SceneRect[];
  pageBackground: string | null;
  nodes: (
    | Omit<RectNode, "kind"> & { kind: "rect" }
    | Omit<TextNode, "kind"> & { kind: "text" }
    | (Omit<ImageNode, "kind" | "dataBase64" | "mimeType"> & { kind: "image"; src: string })
  )[];
}

// Plain-JS STRING, not a function: tsx's transpile injects a __name() helper into serialized
// callbacks which does not exist inside the page (ReferenceError). style-spec.ts hit this
// exact trap — see its note. Keep this as a string.
const EXTRACT_SCRIPT = `(() => {
  const TRANSPARENT = /^rgba?\\(0,\\s*0,\\s*0,\\s*0\\)$|^transparent$/;
  const round = (n) => Math.round(n * 100) / 100;
  const nodes = [];
  let seq = 0;

  const boxOf = (el) => {
    const r = el.getBoundingClientRect();
    return { x: round(r.left + window.scrollX), y: round(r.top + window.scrollY), width: round(r.width), height: round(r.height) };
  };

  const radii = (cs) => [
    parseFloat(cs.borderTopLeftRadius) || 0,
    parseFloat(cs.borderTopRightRadius) || 0,
    parseFloat(cs.borderBottomRightRadius) || 0,
    parseFloat(cs.borderBottomLeftRadius) || 0,
  ];

  // A page container is an element sized to the artboard. The designer prompt tells the agent
  // to emit <section class="page"> for multi-page docs; auto-paginated docs have none, and we
  // fall back to slicing by artboard height on the Node side.
  const pageBoxes = [];
  const PW = window.__BL_PAGE_W, PH = window.__BL_PAGE_H;
  const near = (a, b) => Math.abs(a - b) / b < 0.03;
  document.querySelectorAll("*").forEach((el) => {
    const r = el.getBoundingClientRect();
    if (!near(r.width, PW) || !near(r.height, PH)) return;
    if (el.closest("[data-bl-page]") && el.closest("[data-bl-page]") !== el) return;
    el.setAttribute("data-bl-page", "1");
    pageBoxes.push(boxOf(el));
  });

  const bodyBg = getComputedStyle(document.body).backgroundColor;

  const walk = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return;
    const opacity = parseFloat(cs.opacity);
    if (opacity === 0) return;
    const box = boxOf(el);
    const tag = el.tagName.toLowerCase();

    if (tag === "img" && el.getAttribute("src")) {
      // The compile stage produces frame(overflow:hidden) + absolutely-positioned img. Find
      // that frame so the crop survives; otherwise the image is its own frame.
      let frameEl = el.closest("[data-img-frame]");
      if (!frameEl) {
        const p = el.parentElement;
        if (p && getComputedStyle(p).overflow === "hidden") frameEl = p;
      }
      const frame = frameEl ? boxOf(frameEl) : box;
      const fcs = frameEl ? getComputedStyle(frameEl) : cs;
      nodes.push({
        kind: "image",
        id: "n" + seq++,
        x: frame.x, y: frame.y, width: frame.width, height: frame.height,
        inner: { x: round(box.x - frame.x), y: round(box.y - frame.y), width: box.width, height: box.height },
        src: el.currentSrc || el.src,
        cornerRadii: radii(fcs),
        opacity: opacity,
      });
      return; // do not also emit the img's own background
    }

    // Background / border box. Emitted before children so DOM order == paint order.
    const hasFill = !TRANSPARENT.test(cs.backgroundColor);
    const bw = parseFloat(cs.borderTopWidth) || 0;
    const hasStroke = bw > 0 && !TRANSPARENT.test(cs.borderTopColor);
    if ((hasFill || hasStroke) && box.width > 0 && box.height > 0 && tag !== "html" && tag !== "body") {
      nodes.push({
        kind: "rect",
        id: "n" + seq++,
        x: box.x, y: box.y, width: box.width, height: box.height,
        fill: hasFill ? cs.backgroundColor : null,
        cornerRadii: radii(cs),
        stroke: hasStroke ? { color: cs.borderTopColor, weight: bw } : null,
        opacity: opacity,
      });
    }

    // Direct text content -> one text node, positioned on the CONTENT box (padding excluded)
    // so Figma's text frame lands where the glyphs actually are.
    const direct = Array.from(el.childNodes)
      .filter((n) => n.nodeType === 3 && n.textContent.trim())
      .map((n) => n.textContent.replace(/\\s+/g, " ").trim())
      .join(" ");
    if (direct) {
      const padL = parseFloat(cs.paddingLeft) || 0, padR = parseFloat(cs.paddingRight) || 0;
      const padT = parseFloat(cs.paddingTop) || 0, padB = parseFloat(cs.paddingBottom) || 0;
      const bL = parseFloat(cs.borderLeftWidth) || 0, bR = parseFloat(cs.borderRightWidth) || 0;
      const bT = parseFloat(cs.borderTopWidth) || 0, bB = parseFloat(cs.borderBottomWidth) || 0;
      const align = cs.textAlign === "center" ? "center" : cs.textAlign === "right" || cs.textAlign === "end" ? "right" : cs.textAlign === "justify" ? "justified" : "left";
      const lh = cs.lineHeight === "normal" ? null : (parseFloat(cs.lineHeight) || null);
      const family = (cs.fontFamily.split(",")[0] || "").replace(/^\\s*["']|["']\\s*$/g, "").trim();
      nodes.push({
        kind: "text",
        id: "n" + seq++,
        x: round(box.x + bL + padL),
        y: round(box.y + bT + padT),
        width: round(Math.max(1, box.width - bL - bR - padL - padR)),
        height: round(Math.max(1, box.height - bT - bB - padT - padB)),
        characters: direct,
        fontFamily: family || "Inter",
        fontWeight: parseInt(cs.fontWeight, 10) || 400,
        italic: cs.fontStyle === "italic" || cs.fontStyle === "oblique",
        fontSize: parseFloat(cs.fontSize) || 16,
        lineHeightPx: lh,
        letterSpacingPx: cs.letterSpacing === "normal" ? 0 : (parseFloat(cs.letterSpacing) || 0),
        color: cs.color,
        textAlign: align,
        textTransform: cs.textTransform || "none",
        opacity: opacity,
      });
    }

    for (const child of el.children) walk(child);
  };

  for (const child of document.body.children) walk(child);

  return {
    docWidth: round(document.documentElement.scrollWidth),
    docHeight: round(Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)),
    pageBoxes: pageBoxes,
    pageBackground: TRANSPARENT.test(bodyBg) ? null : bodyBg,
    nodes: nodes,
  };
})()`;

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

/** Read an image the page referenced, from disk or from an inline data: URI. */
function loadImage(src: string, projectDir: string): { dataBase64: string; mimeType: string } | null {
  try {
    if (src.startsWith("data:")) {
      const m = /^data:([^;,]+)[^,]*,(.*)$/s.exec(src);
      if (!m) return null;
      const isBase64 = /;base64/i.test(src.slice(0, src.indexOf(",")));
      return {
        mimeType: m[1],
        dataBase64: isBase64 ? m[2] : Buffer.from(decodeURIComponent(m[2]), "utf8").toString("base64"),
      };
    }
    const path = src.startsWith("file://") ? fileURLToPath(src) : resolve(projectDir, src);
    return {
      dataBase64: readFileSync(path).toString("base64"),
      mimeType: MIME_BY_EXT[extname(path).toLowerCase()] ?? "image/png",
    };
  } catch {
    return null; // a missing asset must not sink the whole export
  }
}

/** Which page a node belongs to, by its vertical centre. Pure — unit-tested. */
export function assignPage(node: SceneRect, pageBoxes: SceneRect[]): number {
  const centreY = node.y + node.height / 2;
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < pageBoxes.length; i++) {
    const p = pageBoxes[i];
    if (centreY >= p.y && centreY < p.y + p.height) return i;
    const dist = centreY < p.y ? p.y - centreY : centreY - (p.y + p.height);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

/** Even slices of the document, used when the page has no explicit page containers. */
export function slicePages(docHeight: number, pageWidthPx: number, pageHeightPx: number): SceneRect[] {
  const count = Math.max(1, Math.ceil(docHeight / pageHeightPx - 0.02)); // 2% tolerance for a hairline overflow
  return Array.from({ length: count }, (_, i) => ({ x: 0, y: i * pageHeightPx, width: pageWidthPx, height: pageHeightPx }));
}

/** Distinct (family, weight, italic) triples the plugin must preload before creating text. */
export function collectFonts(pages: ScenePage[]): FigmaScene["fonts"] {
  const seen = new Map<string, FigmaScene["fonts"][number]>();
  for (const page of pages) {
    for (const node of page.nodes) {
      if (node.kind !== "text") continue;
      const key = `${node.fontFamily}|${node.fontWeight}|${node.italic}`;
      if (!seen.has(key)) seen.set(key, { family: node.fontFamily, weight: node.fontWeight, italic: node.italic });
    }
  }
  return [...seen.values()];
}

/**
 * Measure a project's page.html in Chromium and build the Figma scene.
 * Runs against the SAME browser the proof is printed with, so geometry is exact.
 */
export async function exportFigmaScene(project: Project, backend: RenderBackend): Promise<FigmaScene> {
  const meta = project.meta();
  const dims = pageDims(meta.settings);
  const pageWidthPx = dims.w * MM_TO_PX;
  const pageHeightPx = dims.h * MM_TO_PX;
  const warnings: string[] = [];

  const raw = await backend.withPage(async (page) => {
    await page.setViewportSize({ width: Math.round(pageWidthPx), height: Math.round(pageHeightPx) });
    await page.goto(`file://${project.pageHtml}`, { waitUntil: "networkidle" });
    // Same decode/font barrier the PDF path uses — without it, images report 0×0 and text
    // measures against a fallback face.
    await page.evaluate(`(async () => {
      await Promise.all(Array.from(document.images).map((img) => img.decode().catch(() => {})));
      if (document.fonts && document.fonts.ready) await document.fonts.ready;
    })()`);
    await page.evaluate(`window.__BL_PAGE_W = ${pageWidthPx}; window.__BL_PAGE_H = ${pageHeightPx};`);
    return (await page.evaluate(EXTRACT_SCRIPT)) as RawExtract;
  });

  const pageBoxes = raw.pageBoxes.length ? raw.pageBoxes : slicePages(raw.docHeight, pageWidthPx, pageHeightPx);
  if (!raw.pageBoxes.length && pageBoxes.length > 1) {
    warnings.push(
      `No explicit page containers found — split into ${pageBoxes.length} pages by artboard height. Check the page breaks.`,
    );
  }

  const pages: ScenePage[] = pageBoxes.map((box, index) => ({
    index,
    width: Math.round(box.width),
    height: Math.round(box.height),
    background: raw.pageBackground,
    nodes: [],
  }));

  let droppedImages = 0;
  for (const node of raw.nodes) {
    const pageIndex = assignPage(node, pageBoxes);
    const origin = pageBoxes[pageIndex];
    // Re-base onto the page it landed on: Figma frames have their own coordinate space.
    const local = { x: node.x - origin.x, y: node.y - origin.y };

    if (node.kind === "image") {
      const loaded = loadImage(node.src, project.dir);
      if (!loaded) {
        droppedImages++;
        continue;
      }
      const { src: _src, ...rest } = node;
      pages[pageIndex].nodes.push({ ...rest, ...local, ...loaded });
    } else {
      pages[pageIndex].nodes.push({ ...node, ...local });
    }
  }

  if (droppedImages) warnings.push(`${droppedImages} image(s) could not be read and were skipped.`);

  return {
    version: 1,
    name: meta.displayName || project.slug,
    pxPerMm: MM_TO_PX,
    pageWidthMm: dims.w,
    pageHeightMm: dims.h,
    fonts: collectFonts(pages),
    pages,
    warnings,
  };
}
