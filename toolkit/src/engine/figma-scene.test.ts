// Figma-scene tests: the PURE page-assignment / slicing / font-collection helpers.
// The Chromium measurement path (exportFigmaScene) is validated by exporting a real project.
import assert from "node:assert/strict";
import { test } from "node:test";

const { assignPage, slicePages, collectFonts } = await import("./figma-scene.ts");

const A4_W = 793.7;
const A4_H = 1122.5;

test("slicePages: a single-page document yields exactly one page", () => {
  assert.equal(slicePages(1122.5, A4_W, A4_H).length, 1);
});

test("slicePages: a hairline overflow does NOT invent a second page", () => {
  // Sub-pixel layout rounding routinely pushes scrollHeight a fraction past the artboard.
  assert.equal(slicePages(1124, A4_W, A4_H).length, 1);
});

test("slicePages: real overflow does paginate", () => {
  assert.equal(slicePages(2245, A4_W, A4_H).length, 2);
  assert.equal(slicePages(2300, A4_W, A4_H).length, 3);
});

test("slicePages: pages stack vertically at the artboard height", () => {
  const pages = slicePages(2245, A4_W, A4_H);
  assert.deepEqual(
    pages.map((p) => p.y),
    [0, A4_H],
  );
});

test("assignPage: a node lands on the page containing its vertical centre", () => {
  const pages = slicePages(2245, A4_W, A4_H);
  assert.equal(assignPage({ x: 0, y: 10, width: 100, height: 40 }, pages), 0);
  assert.equal(assignPage({ x: 0, y: A4_H + 10, width: 100, height: 40 }, pages), 1);
});

test("assignPage: a block straddling the boundary goes where its bulk is", () => {
  const pages = slicePages(2245, A4_W, A4_H);
  // Starts 20px before the break but is 200 tall -> centre is on page 2.
  assert.equal(assignPage({ x: 0, y: A4_H - 20, width: 100, height: 200 }, pages), 1);
});

test("assignPage: content beyond the last page clamps to the nearest page, never -1", () => {
  const pages = slicePages(1122.5, A4_W, A4_H);
  assert.equal(assignPage({ x: 0, y: 5000, width: 10, height: 10 }, pages), 0);
  assert.equal(assignPage({ x: 0, y: -500, width: 10, height: 10 }, pages), 0);
});

const textNode = (over: Record<string, unknown> = {}) => ({
  kind: "text" as const,
  id: "n1",
  x: 0,
  y: 0,
  width: 100,
  height: 20,
  characters: "Hello",
  fontFamily: "Inter",
  fontWeight: 400,
  italic: false,
  fontSize: 16,
  lineHeightPx: null,
  letterSpacingPx: 0,
  color: "rgb(0, 0, 0)",
  textAlign: "left" as const,
  textTransform: "none",
  opacity: 1,
  ...over,
});

test("collectFonts: dedupes by family + weight + italic", () => {
  const fonts = collectFonts([
    {
      index: 0,
      width: 794,
      height: 1123,
      background: null,
      nodes: [
        textNode(),
        textNode({ id: "n2" }), // identical -> one entry
        textNode({ id: "n3", fontWeight: 700 }),
        textNode({ id: "n4", italic: true }),
        textNode({ id: "n5", fontFamily: "Georgia" }),
      ],
    },
  ]);
  assert.equal(fonts.length, 4);
  assert.deepEqual(fonts[0], { family: "Inter", weight: 400, italic: false });
});

test("collectFonts: ignores non-text nodes", () => {
  const fonts = collectFonts([
    {
      index: 0,
      width: 794,
      height: 1123,
      background: null,
      nodes: [
        { kind: "rect", id: "r1", x: 0, y: 0, width: 10, height: 10, fill: "rgb(0,0,0)", cornerRadii: [0, 0, 0, 0], stroke: null, opacity: 1 },
      ],
    },
  ]);
  assert.equal(fonts.length, 0);
});
