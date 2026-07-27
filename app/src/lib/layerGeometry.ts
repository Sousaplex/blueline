// The single source of truth for editor geometry math (see docs/layer-model.md).
//
// EVERYTHING here is a pure function of plain numbers — no DOM reads, no React, no
// side effects. That is deliberate: the anchor-drift and "can't scale horizontally"
// bugs that plagued the old inline handlers become one-line assertions here, provable
// without a browser. Handlers in PreviewPane measure the DOM ONCE per gesture to build a
// FrameCtx + a start geometry, then call these solvers; they never do their own rect math.
//
// Coordinate spaces:
//   • page-mm   — millimetres in the page's own coordinate system (origin = page top-left).
//                 This is what we persist to page.html (position:absolute; left/top/width in mm).
//   • frame-mm  — millimetres relative to an image FRAME's top-left. The inner photo layer
//                 lives here.
//   • screen-px — CSS pixels in the parent window (pointer clientX/clientY). The iframe has a
//                 CSS `zoom` factor, so 1mm = MM_TO_PX × zoom screen px.

export const MM_TO_PX = 96 / 25.4;
export const PX_TO_MM = 25.4 / 96;
/** Minimum frame/box edge — matches FRAME_MIN_MM in the engine so the UI can't ask for less. */
export const MIN_FRAME_MM = 5;

/** A page-mm rectangle: a text/shape layer, or an image's crop frame. */
export interface FrameGeom {
  leftMm: number;
  topMm: number;
  widthMm: number;
  heightMm: number;
}

/** The inner photo of an image, in FRAME-mm. Height is derived from width via aspect. */
export interface ImgLayerGeom {
  widthMm: number;
  leftMm: number;
  topMm: number;
}

/** Which edges a resize handle MOVES. A corner sets two flags; an edge sets one.
 *  The edge(s) NOT flagged stay anchored. */
export interface Handle {
  l?: boolean;
  r?: boolean;
  t?: boolean;
  b?: boolean;
}

export const isCorner = (h: Handle): boolean => Boolean((h.l || h.r) && (h.t || h.b));

// ---------------------------------------------------------------------------
// Screen ⇄ page-mm. Build the ctx ONCE at gesture start from a single DOM read.
// ---------------------------------------------------------------------------

export interface FrameCtx {
  /** Screen px of the page-mm origin (0,0) — the page root's top-left corner. */
  originX: number;
  originY: number;
  /** The iframe's CSS zoom factor. */
  zoom: number;
}

/** Screen px per millimetre under the current zoom. */
export const perMm = (ctx: FrameCtx): number => MM_TO_PX * ctx.zoom;

export function screenToPageMm(sx: number, sy: number, ctx: FrameCtx): { x: number; y: number } {
  const p = perMm(ctx);
  return { x: (sx - ctx.originX) / p, y: (sy - ctx.originY) / p };
}

export function pageMmToScreen(x: number, y: number, ctx: FrameCtx): { x: number; y: number } {
  const p = perMm(ctx);
  return { x: ctx.originX + x * p, y: ctx.originY + y * p };
}

/** A pointer delta in screen px → a delta in page-mm (zoom-corrected). */
export function screenDeltaToMm(dxPx: number, dyPx: number, ctx: FrameCtx): { dxMm: number; dyMm: number } {
  const p = perMm(ctx);
  return { dxMm: dxPx / p, dyMm: dyPx / p };
}

// ---------------------------------------------------------------------------
// Frame resize — corners and edges, with the OPPOSITE edge/corner held fixed.
// ---------------------------------------------------------------------------

/** The frame-local coordinate of the corner that stays fixed during this handle's drag. */
export function fixedCornerLocal(start: FrameGeom, h: Handle): { x: number; y: number } {
  return {
    x: h.l ? start.widthMm : 0, // dragging the left edge → right edge (x=width) is fixed
    y: h.t ? start.heightMm : 0, // dragging the top edge → bottom edge (y=height) is fixed
  };
}

/** Clamp a size to >= MIN while keeping the fixed edge put (adjusts origin for l/t handles). */
function clampEdge(originMm: number, sizeMm: number, min: number, movesOrigin: boolean): { origin: number; size: number } {
  if (sizeMm >= min) return { origin: originMm, size: sizeMm };
  // Too small: pin to min, and if this handle moves the origin edge, push the origin back so
  // the opposite (fixed) edge doesn't move.
  if (movesOrigin) return { origin: originMm + (sizeMm - min), size: min };
  return { origin: originMm, size: min };
}

/**
 * Resize a frame by dragging `handle`, with the opposite edge/corner anchored.
 *  - Edge handle (one flag): only that axis changes → for an image this is a CROP/reveal.
 *  - Corner handle (two flags): both axes; `aspectLock` scales UNIFORMLY about the fixed
 *    corner (proportional "make it bigger on the page"); without it, free stretch.
 * dxMm/dyMm are the pointer's total movement from gesture start, in page-mm.
 */
export function resizeFrame(
  start: FrameGeom,
  handle: Handle,
  dxMm: number,
  dyMm: number,
  opts: { aspectLock?: boolean } = {},
): FrameGeom {
  const right = start.leftMm + start.widthMm;
  const bottom = start.topMm + start.heightMm;

  // Free (per-axis) target first.
  let leftMm = start.leftMm;
  let topMm = start.topMm;
  let widthMm = start.widthMm;
  let heightMm = start.heightMm;

  if (handle.l) {
    leftMm = start.leftMm + dxMm;
    widthMm = right - leftMm;
  } else if (handle.r) {
    widthMm = start.widthMm + dxMm;
  }
  if (handle.t) {
    topMm = start.topMm + dyMm;
    heightMm = bottom - topMm;
  } else if (handle.b) {
    heightMm = start.heightMm + dyMm;
  }

  // Aspect-locked corner: reconcile to a single uniform scale about the fixed corner, driven
  // by whichever axis the pointer travelled further on (feels like the cursor "leads").
  if (opts.aspectLock && isCorner(handle)) {
    const sW = widthMm / start.widthMm;
    const sH = heightMm / start.heightMm;
    const s = Math.abs(dxMm) >= Math.abs(dyMm) ? sW : sH;
    widthMm = start.widthMm * s;
    heightMm = start.heightMm * s;
    if (handle.l) leftMm = right - widthMm;
    else leftMm = start.leftMm;
    if (handle.t) topMm = bottom - heightMm;
    else topMm = start.topMm;
  }

  // Min-size clamp that preserves the fixed edge.
  const cx = clampEdge(leftMm, widthMm, MIN_FRAME_MM, Boolean(handle.l));
  const cy = clampEdge(topMm, heightMm, MIN_FRAME_MM, Boolean(handle.t));
  return { leftMm: cx.origin, topMm: cy.origin, widthMm: cx.size, heightMm: cy.size };
}

// ---------------------------------------------------------------------------
// Inner-photo transforms (frame-mm). Frame stays fixed; the photo moves/scales inside it.
// ---------------------------------------------------------------------------

/** Scale a photo layer by `factor` about a pivot given in FRAME-mm. Height follows width. */
export function scaleAbout(layer: ImgLayerGeom, factor: number, pivotXMm: number, pivotYMm: number): ImgLayerGeom {
  return {
    widthMm: layer.widthMm * factor,
    leftMm: pivotXMm - (pivotXMm - layer.leftMm) * factor,
    topMm: pivotYMm - (pivotYMm - layer.topMm) * factor,
  };
}

/** Zoom the photo within a fixed frame, anchored on the frame's centre (double-click mode). */
export function scaleContent(layer: ImgLayerGeom, factor: number, frame: FrameGeom): ImgLayerGeom {
  return scaleAbout(layer, factor, frame.widthMm / 2, frame.heightMm / 2);
}

/** Pan the photo within a fixed frame. */
export function panContent(layer: ImgLayerGeom, dxMm: number, dyMm: number): ImgLayerGeom {
  return { widthMm: layer.widthMm, leftMm: layer.leftMm + dxMm, topMm: layer.topMm + dyMm };
}

/**
 * Scale frame + photo TOGETHER about the fixed corner (image corner-resize). Returns the new
 * inner layer so the photo keeps covering the frame exactly as before the drag.
 */
export function scaleLayerWithFrame(layer: ImgLayerGeom, start: FrameGeom, next: FrameGeom, handle: Handle): ImgLayerGeom {
  const s = next.widthMm / start.widthMm || 1;
  // Work in slot/page space (frame.left/top are the frame's position there) so the fixed
  // corner stays put for EVERY corner, not just the origin one.
  const fixed = fixedCornerLocal(start, handle); // frame-local coord of the fixed corner
  const px = start.leftMm + fixed.x;
  const py = start.topMm + fixed.y;
  const pageLeft = start.leftMm + layer.leftMm;
  const pageTop = start.topMm + layer.topMm;
  const newPageLeft = px + (pageLeft - px) * s;
  const newPageTop = py + (pageTop - py) * s;
  return { widthMm: layer.widthMm * s, leftMm: newPageLeft - next.leftMm, topMm: newPageTop - next.topMm };
}

/** Size a photo to COVER a frame (centred) given its natural aspect (w/h). Compiler + insert use this. */
export function coverLayer(frame: FrameGeom, aspect: number): ImgLayerGeom {
  const a = aspect > 0 && Number.isFinite(aspect) ? aspect : 1;
  const widthMm = Math.max(frame.widthMm, frame.heightMm * a);
  const heightMm = widthMm / a;
  return {
    widthMm,
    leftMm: (frame.widthMm - widthMm) / 2,
    topMm: (frame.heightMm - heightMm) / 2,
  };
}
