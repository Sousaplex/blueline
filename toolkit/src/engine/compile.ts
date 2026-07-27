// The compile stage (see docs/layer-model.md §3). Runs after every render: it gives each
// image EXPLICIT, directly-manipulable geometry by normalizing it into a canonical
// slot / frame / layer shape — deterministically, from Chromium's real computed layout,
// not from browser-side naturalWidth guesses at drag time (the old bug).
//
// The problem it solves: a generated image sits in a crop frame that is itself a flex/grid
// CHILD. You cannot move or resize a flex child freely — the parent layout fights you. So we
// SPLIT the two roles the crop frame was playing:
//
//   SLOT   — the original crop-frame element. Keeps its exact box, so it holds the flex/flow
//            slot and NOTHING around it reflows. Stops clipping (overflow:visible) so its
//            child can grow past it.
//   FRAME  — a new inner div, position:absolute inside the slot, carrying the crop
//            (overflow:hidden) + the frame's visual styling (radius/border/background,
//            measured from Chromium). This is what the user moves/resizes — freely, because
//            it's absolutely positioned in a fixed-size relative slot.
//   LAYER  — the <img>, position:absolute inside the frame, sized to COVER it. Pan/zoom/crop
//            happen here without touching the frame box.
//
// The result: move = frame left/top; resize/crop = frame width/height; pan/zoom = layer.
// None of them reflow the page. Idempotent: an already-compiled image is left untouched.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { pageDims, type Project } from "./project.ts";
import type { RenderBackend } from "./render.ts";

const MM_TO_PX = 96 / 25.4;

/** One image's measured geometry + the crop-frame styling to migrate. */
export interface ImgMeasure {
  id: string;
  widthMm: number; // rendered crop box
  heightMm: number;
  aspect: number; // natural w/h (1 if unknown)
  /** True when the img's parent is a dedicated crop frame (only child = the img). */
  frameOnlyImg: boolean;
  borderRadius: string; // computed, migrated onto the inner frame
  border: string;
  background: string;
}

/** Size a photo to COVER a w×h frame (centred), given natural aspect. */
function cover(wMm: number, hMm: number, aspect: number): { widthMm: number; leftMm: number; topMm: number } {
  const a = aspect > 0 && Number.isFinite(aspect) ? aspect : 1;
  const widthMm = Math.max(wMm, hMm * a);
  const heightMm = widthMm / a;
  return { widthMm, leftMm: (wMm - widthMm) / 2, topMm: (hMm - heightMm) / 2 };
}

const mm = (n: number) => `${n.toFixed(1)}mm`;

/**
 * Pure transform: apply measured image geometry to page HTML, producing the canonical
 * slot/frame/layer shape. Testable with hand-written measurements — no browser needed.
 */
export function applyCompile(html: string, measures: ImgMeasure[]): string {
  if (!measures.length) return html; // nothing to normalize — don't reserialize
  const { document: doc } = parseHTML(html);
  for (const m of measures) {
    const img: any = doc.querySelector(`img[data-image-id="${m.id}"]`);
    if (!img) continue;
    const frame: any = img.parentElement;
    if (!frame) continue;
    // Idempotent: already compiled (the img sits inside a data-img-frame).
    if (frame.getAttribute?.("data-img-frame") === m.id) continue;

    const c = cover(m.widthMm, m.heightMm, m.aspect);
    const inner: any = doc.createElement("div");
    inner.setAttribute("data-img-frame", m.id);
    const visual = [
      m.borderRadius && m.borderRadius !== "0px" ? `border-radius:${m.borderRadius}` : "",
      m.border && !/(^|\s)0px/.test(m.border) && m.border !== "none" ? `border:${m.border}` : "",
      m.background && m.background !== "rgba(0, 0, 0, 0)" && m.background !== "transparent" ? `background:${m.background}` : "",
    ]
      .filter(Boolean)
      .join(";");
    inner.setAttribute(
      "style",
      `position:absolute;left:0;top:0;width:${mm(m.widthMm)};height:${mm(m.heightMm)};overflow:hidden;${visual}`,
    );
    img.setAttribute(
      "style",
      `position:absolute;left:${mm(c.leftMm)};top:${mm(c.topMm)};width:${mm(c.widthMm)};height:auto;max-width:none`,
    );

    if (m.frameOnlyImg) {
      // Reuse the dedicated crop frame as the SLOT: keep its box (holds the flex slot), but
      // stop it clipping/painting so the inner frame can grow past it and own the visuals.
      inner.appendChild(img); // moves the img into the inner frame
      frame.appendChild(inner);
      frame.setAttribute("data-img-slot", m.id);
      mergeInline(frame, {
        position: "relative",
        width: mm(m.widthMm),
        height: mm(m.heightMm),
        overflow: "visible",
        "border-radius": "0",
        border: "0",
        "box-shadow": "none",
        padding: "0",
      });
    } else {
      // Parent is a shared container — wrap the img alone in a fresh slot in place.
      const slot: any = doc.createElement("div");
      slot.setAttribute("data-img-slot", m.id);
      slot.setAttribute("style", `position:relative;display:inline-block;width:${mm(m.widthMm)};height:${mm(m.heightMm)}`);
      img.replaceWith(slot);
      inner.appendChild(img);
      slot.appendChild(inner);
    }
  }
  return `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`;
}

/** Merge inline style props onto an element (later wins), preserving the rest. */
function mergeInline(el: any, props: Record<string, string>): void {
  const existing = new Map<string, string>(
    (el.getAttribute("style") ?? "")
      .split(";")
      .map((s: string) => s.trim())
      .filter(Boolean)
      .map((s: string) => [s.slice(0, s.indexOf(":")).trim(), s.slice(s.indexOf(":") + 1).trim()] as [string, string]),
  );
  for (const [k, v] of Object.entries(props)) existing.set(k, v);
  el.setAttribute("style", [...existing].map(([k, v]) => `${k}: ${v}`).join("; "));
}

/** Measure every image in Chromium (real computed layout) via the shared render backend. */
export async function measureImages(backend: RenderBackend, htmlPath: string, dims: { w: number; h: number }): Promise<ImgMeasure[]> {
  return backend.withPage(async (page) => {
    await page.setViewportSize({ width: Math.ceil(dims.w * MM_TO_PX), height: Math.ceil(dims.h * MM_TO_PX) }).catch(() => {});
    await page.goto(`file://${htmlPath}`, { waitUntil: "networkidle" });
    // Wait for decode so naturalWidth/height are real (string form dodges tsx __name injection).
    await page.evaluate(`(async()=>{await Promise.all(Array.from(document.images).map(i=>i.decode().catch(()=>{})));})()`);
    const raw = await page.evaluate(`(() => {
      const MM = 96/25.4;
      return Array.from(document.querySelectorAll('img[data-image-id]')).map((img) => {
        const frame = img.parentElement;
        const dedicated = !!frame && frame.children.length === 1;
        // Dedicated crop frame → measure ITS border-box (the inner frame will carry the same
        // border, so it renders identically). Shared parent → measure the img's own box.
        const r = (dedicated ? frame : img).getBoundingClientRect();
        const cs = frame ? getComputedStyle(frame) : null;
        return {
          id: img.getAttribute('data-image-id'),
          widthMm: r.width / MM,
          heightMm: r.height / MM,
          aspect: (img.naturalWidth && img.naturalHeight) ? img.naturalWidth / img.naturalHeight : 1,
          frameOnlyImg: dedicated,
          borderRadius: cs ? cs.borderTopLeftRadius : '0px',
          border: cs ? cs.borderTopWidth + ' ' + cs.borderTopStyle + ' ' + cs.borderTopColor : 'none',
          background: cs ? cs.backgroundColor : 'transparent',
        };
      });
    })()`);
    return raw as ImgMeasure[];
  });
}

/**
 * Compile page.html into canonical layer form. Safe to call after every render — idempotent,
 * and a no-op when there are no images. Never throws on a page that has no page.html yet.
 */
export async function compilePage(project: Project, backend: RenderBackend): Promise<void> {
  if (!existsSync(project.pageHtml)) return;
  const dims = pageDims(project.meta().settings);
  // Measuring loads page.html into Chromium (seconds). If an agent edit or a human drag
  // writes page.html during that window, the measurements are stale — baking them would
  // clobber the newer state. Fingerprint before measuring; if the file changed by the time
  // we're ready to write, skip: the write that changed it will trigger its own compile.
  const before = createHash("sha1").update(readFileSync(project.pageHtml)).digest("hex");
  const measures = await measureImages(backend, project.pageHtml, dims);
  if (!measures.length) return;
  const html = readFileSync(project.pageHtml, "utf8");
  if (createHash("sha1").update(html).digest("hex") !== before) return; // changed mid-measure — bail
  const next = applyCompile(html, measures);
  if (next !== html) writeFileSync(project.pageHtml, next);
}
