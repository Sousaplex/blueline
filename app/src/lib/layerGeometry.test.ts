import { describe, expect, it } from "vitest";
import {
  coverLayer,
  fixedCornerLocal,
  type FrameCtx,
  type FrameGeom,
  type Handle,
  MIN_FRAME_MM,
  pageMmToScreen,
  panContent,
  perMm,
  resizeFrame,
  scaleContent,
  scaleLayerWithFrame,
  screenDeltaToMm,
  screenToPageMm,
} from "./layerGeometry";

const HANDLES = {
  nw: { l: true, t: true } as Handle,
  ne: { r: true, t: true } as Handle,
  se: { r: true, b: true } as Handle,
  sw: { l: true, b: true } as Handle,
  e: { r: true } as Handle,
  w: { l: true } as Handle,
  n: { t: true } as Handle,
  s: { b: true } as Handle,
};

const box = (leftMm: number, topMm: number, widthMm: number, heightMm: number): FrameGeom => ({ leftMm, topMm, widthMm, heightMm });
const right = (f: FrameGeom) => f.leftMm + f.widthMm;
const bottom = (f: FrameGeom) => f.topMm + f.heightMm;

describe("screen ⇄ page-mm", () => {
  for (const zoom of [0.5, 0.713, 1, 2]) {
    it(`round-trips at zoom ${zoom}`, () => {
      const ctx: FrameCtx = { originX: 120, originY: 64, zoom };
      for (const [x, y] of [[0, 0], [10, 20], [210, 297], [-5, 33.3]]) {
        const s = pageMmToScreen(x, y, ctx);
        const back = screenToPageMm(s.x, s.y, ctx);
        expect(back.x).toBeCloseTo(x, 6);
        expect(back.y).toBeCloseTo(y, 6);
      }
    });
  }

  it("scales pointer deltas by zoom", () => {
    const ctx: FrameCtx = { originX: 0, originY: 0, zoom: 0.5 };
    const { dxMm } = screenDeltaToMm(perMm(ctx) * 10, 0, ctx); // 10mm worth of screen px
    expect(dxMm).toBeCloseTo(10, 6);
  });
});

describe("resizeFrame — anchor invariants", () => {
  const start = box(20, 30, 100, 60);

  it("SE corner (free) holds the top-left corner fixed", () => {
    const next = resizeFrame(start, HANDLES.se, 25, -10, {});
    expect(next.leftMm).toBeCloseTo(20, 6);
    expect(next.topMm).toBeCloseTo(30, 6);
    expect(next.widthMm).toBeCloseTo(125, 6);
    expect(next.heightMm).toBeCloseTo(50, 6);
  });

  it("NW corner (free) holds the bottom-right corner fixed", () => {
    const next = resizeFrame(start, HANDLES.nw, 15, 10, {});
    expect(right(next)).toBeCloseTo(right(start), 6);
    expect(bottom(next)).toBeCloseTo(bottom(start), 6);
  });

  it("NE corner holds the bottom-left corner fixed", () => {
    const next = resizeFrame(start, HANDLES.ne, 12, 8, {});
    expect(next.leftMm).toBeCloseTo(start.leftMm, 6); // left fixed
    expect(bottom(next)).toBeCloseTo(bottom(start), 6); // bottom fixed
  });

  it("SW corner holds the top-right corner fixed", () => {
    const next = resizeFrame(start, HANDLES.sw, -7, 9, {});
    expect(right(next)).toBeCloseTo(right(start), 6);
    expect(next.topMm).toBeCloseTo(start.topMm, 6);
  });
});

describe("resizeFrame — edges change ONE axis (the missing 'scale horizontally')", () => {
  const start = box(20, 30, 100, 60);

  it("E edge changes width only, height + top + left untouched", () => {
    const next = resizeFrame(start, HANDLES.e, 40, 999 /* ignored: no vertical flag */, {});
    expect(next.widthMm).toBeCloseTo(140, 6);
    expect(next.heightMm).toBeCloseTo(60, 6);
    expect(next.leftMm).toBeCloseTo(20, 6);
    expect(next.topMm).toBeCloseTo(30, 6);
  });

  it("W edge changes width and left, holds the right edge", () => {
    const next = resizeFrame(start, HANDLES.w, -20, 0, {});
    expect(next.widthMm).toBeCloseTo(120, 6);
    expect(right(next)).toBeCloseTo(right(start), 6);
    expect(next.heightMm).toBeCloseTo(60, 6);
  });

  it("S edge changes height only", () => {
    const next = resizeFrame(start, HANDLES.s, 0, 15, {});
    expect(next.heightMm).toBeCloseTo(75, 6);
    expect(next.widthMm).toBeCloseTo(100, 6);
  });
});

describe("resizeFrame — aspect lock scales uniformly about the fixed corner", () => {
  const start = box(0, 0, 100, 50); // aspect 2:1

  it("keeps the 2:1 ratio on an SE corner drag", () => {
    const next = resizeFrame(start, HANDLES.se, 50, 5, { aspectLock: true });
    expect(next.widthMm / next.heightMm).toBeCloseTo(2, 6);
    expect(next.leftMm).toBeCloseTo(0, 6);
    expect(next.topMm).toBeCloseTo(0, 6);
    // pointer travelled further in x (50 vs 5) → width leads: 150 wide, 75 tall
    expect(next.widthMm).toBeCloseTo(150, 6);
    expect(next.heightMm).toBeCloseTo(75, 6);
  });

  it("keeps ratio AND the fixed corner on an NW aspect drag", () => {
    const next = resizeFrame(start, HANDLES.nw, -40, -5, { aspectLock: true });
    expect(next.widthMm / next.heightMm).toBeCloseTo(2, 6);
    expect(right(next)).toBeCloseTo(right(start), 6);
    expect(bottom(next)).toBeCloseTo(bottom(start), 6);
  });
});

describe("resizeFrame — min-size clamp preserves the fixed edge", () => {
  const start = box(20, 30, 100, 60);
  it("W edge dragged past collapse pins width to MIN and holds the right edge", () => {
    const next = resizeFrame(start, HANDLES.w, 200, 0, {}); // absurd inward drag
    expect(next.widthMm).toBeCloseTo(MIN_FRAME_MM, 6);
    expect(right(next)).toBeCloseTo(right(start), 6);
  });
});

describe("photo transforms inside a fixed frame", () => {
  const frame = box(0, 0, 100, 60);
  const layer = { widthMm: 120, leftMm: -10, topMm: -5 }; // covers the frame

  it("panContent shifts the photo, keeps its size", () => {
    const next = panContent(layer, 8, -3);
    expect(next.widthMm).toBe(120);
    expect(next.leftMm).toBeCloseTo(-2, 6);
    expect(next.topMm).toBeCloseTo(-8, 6);
  });

  it("scaleContent zooms about the frame centre (centre stays put)", () => {
    const next = scaleContent(layer, 2, frame);
    expect(next.widthMm).toBeCloseTo(240, 6);
    // the photo point under the frame centre (50,30) must map to the same place after scaling
    const centreBefore = { x: (50 - layer.leftMm) / layer.widthMm };
    const centreAfter = { x: (50 - next.leftMm) / next.widthMm };
    expect(centreAfter.x).toBeCloseTo(centreBefore.x, 6);
  });
});

describe("scaleLayerWithFrame — frame+photo scale together, photo keeps covering", () => {
  it("doubling the frame from SE doubles the photo about the fixed corner", () => {
    const start = box(0, 0, 100, 60);
    const next = box(0, 0, 200, 120);
    const layer = { widthMm: 100, leftMm: 0, topMm: 0 };
    const out = scaleLayerWithFrame(layer, start, next, HANDLES.se);
    expect(out.widthMm).toBeCloseTo(200, 6);
    expect(out.leftMm).toBeCloseTo(0, 6);
    expect(out.topMm).toBeCloseTo(0, 6);
  });

  it("doubling from NW keeps the photo covering (fixed bottom-right page corner)", () => {
    // Frame at (20,10) size 100×60, photo covers it exactly. Aspect-lock NW scale ×2 →
    // frame origin moves so its bottom-right (page 120,70) stays fixed. The photo's
    // bottom-right must stay at (120,70) too, and its width doubles.
    const start = box(20, 10, 100, 60);
    const next = box(-80, -50, 200, 120); // right=120, bottom=70 preserved
    const layer = { widthMm: 100, leftMm: 0, topMm: 0 }; // photo page rect (20,10)-(120,70)
    const out = scaleLayerWithFrame(layer, start, next, HANDLES.nw);
    expect(out.widthMm).toBeCloseTo(200, 6);
    // photo page-right = next.left + out.left + 200 should stay 120
    expect(next.leftMm + out.leftMm + out.widthMm).toBeCloseTo(120, 6);
    expect(next.topMm + out.topMm + out.widthMm * (60 / 100)).toBeCloseTo(70, 6);
  });
});

describe("coverLayer", () => {
  it("covers a wide frame with a square photo (fills width, overflows height)", () => {
    const out = coverLayer(box(0, 0, 100, 50), 1); // square photo
    expect(out.widthMm).toBeCloseTo(100, 6);
    expect(out.leftMm).toBeCloseTo(0, 6);
    expect(out.topMm).toBeCloseTo((50 - 100) / 2, 6); // centred vertically, overflows
  });

  it("covers a tall frame with a wide photo (fills height)", () => {
    const out = coverLayer(box(0, 0, 40, 100), 2); // 2:1 photo
    expect(out.widthMm / 2).toBeCloseTo(100, 6); // derived height fills the frame
    expect(out.widthMm).toBeCloseTo(200, 6);
  });

  it("falls back to square on a bad aspect", () => {
    const out = coverLayer(box(0, 0, 30, 30), NaN);
    expect(out.widthMm).toBeCloseTo(30, 6);
  });
});

describe("fixedCornerLocal", () => {
  it("returns the frame-local corner opposite the handle", () => {
    const f = box(0, 0, 100, 60);
    expect(fixedCornerLocal(f, HANDLES.se)).toEqual({ x: 0, y: 0 });
    expect(fixedCornerLocal(f, HANDLES.nw)).toEqual({ x: 100, y: 60 });
    expect(fixedCornerLocal(f, HANDLES.ne)).toEqual({ x: 0, y: 60 });
    expect(fixedCornerLocal(f, HANDLES.sw)).toEqual({ x: 100, y: 0 });
  });
});
