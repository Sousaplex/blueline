// Compile-stage tests: the PURE applyCompile transform (measurements hand-fed, no browser).
// The Chromium measurement path (measureImages) is validated by rendering a real project.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";

const { applyCompile } = await import("./compile.ts");

// A dedicated crop frame: parent's only child is the img (the prompt's convention).
const DEDICATED = `<!DOCTYPE html><html><body>
  <div class="col" style="display:flex">
    <div class="crop" style="width:64mm;height:48mm;overflow:hidden;border-radius:3mm">
      <img src="images/hero/v1.png" data-image-id="hero" style="width:100%;height:100%;object-fit:cover">
    </div>
    <div class="sibling">text</div>
  </div>
</body></html>`;

const measure = (over = {}) => ({
  id: "hero",
  widthMm: 64,
  heightMm: 48,
  aspect: 1.5, // 3:2 landscape photo
  frameOnlyImg: true,
  borderRadius: "11px",
  border: "0px none rgb(0,0,0)",
  background: "rgba(0, 0, 0, 0)",
  ...over,
});

test("dedicated crop frame → slot/frame/layer split", () => {
  const out = applyCompile(DEDICATED, [measure()]);
  const { document: d } = parseHTML(out) as any;

  const slot = d.querySelector('[data-img-slot="hero"]');
  const frame = d.querySelector('[data-img-frame="hero"]');
  const img = d.querySelector('img[data-image-id="hero"]');
  assert.ok(slot, "slot exists");
  assert.ok(frame, "inner frame exists");
  assert.ok(img, "img exists");

  // Slot keeps the box (holds the flex slot) but stops clipping.
  const slotStyle = slot.getAttribute("style");
  assert.match(slotStyle, /position:\s*relative/);
  assert.match(slotStyle, /overflow:\s*visible/);
  assert.match(slotStyle, /width:\s*64\.0mm/);

  // Frame is absolute, clips, and is the img's new parent.
  const frameStyle = frame.getAttribute("style");
  assert.match(frameStyle, /position:\s*absolute/);
  assert.match(frameStyle, /overflow:\s*hidden/);
  assert.match(frameStyle, /border-radius:\s*11px/);
  assert.equal(img.parentElement.getAttribute("data-img-frame"), "hero");

  // Img is a layered cover: absolute, no object-fit, width > frame (3:2 photo in 64×48 → 72mm).
  const imgStyle = img.getAttribute("style");
  assert.match(imgStyle, /position:\s*absolute/);
  assert.doesNotMatch(imgStyle, /object-fit/);
  assert.match(imgStyle, /width:\s*72\.0mm/); // max(64, 48*1.5)=72
  assert.match(imgStyle, /left:\s*-4\.0mm/); // (64-72)/2

  // The flex sibling is untouched — nothing reflowed.
  assert.ok(d.querySelector(".sibling"), "sibling preserved");
});

test("idempotent: compiling twice equals compiling once", () => {
  const once = applyCompile(DEDICATED, [measure()]);
  const twice = applyCompile(once, [measure()]);
  assert.equal(twice, once);
});

test("shared parent (frameOnlyImg=false) → wrap the img alone in place", () => {
  const shared = `<!DOCTYPE html><html><body>
    <figure style="margin:0">
      <img src="images/p/v1.png" data-image-id="p" style="width:100%;object-fit:cover">
      <figcaption data-pc-id="cap">A caption</figcaption>
    </figure>
  </body></html>`;
  const out = applyCompile(shared, [measure({ id: "p", frameOnlyImg: false, widthMm: 80, heightMm: 50, aspect: 1 })]);
  const { document: d } = parseHTML(out) as any;
  const slot = d.querySelector('[data-img-slot="p"]');
  assert.ok(slot, "img wrapped in a slot");
  assert.equal(slot.parentElement.tagName.toLowerCase(), "figure", "slot sits where the img was");
  assert.ok(d.querySelector('[data-pc-id="cap"]'), "caption sibling preserved");
  assert.equal(d.querySelector('img[data-image-id="p"]').parentElement.getAttribute("data-img-frame"), "p");
});

test("no measures → unchanged", () => {
  assert.equal(applyCompile(DEDICATED, []), DEDICATED);
});
