# Blueline — The Layer Model (B2)

Deterministic, directly-manipulable geometry on an HTML/Chromium substrate.

Status: **spec / in progress.** This document is the authoritative design for how
Blueline documents are structured for editing and export. It supersedes the ad-hoc
image-editing code in `PreviewPane.tsx` and the dual-model `setImageStyle` in
`page-edit.ts`.

---

## 1. Why — the audit

Direct manipulation (move / resize / crop / align / snap / layers) requires every
editable element to have **explicit geometry**: an `x, y, width` you can read and write.
AI-generated HTML has **emergent geometry** — position falls out of flow/flex/grid
layout, so there is no coordinate anywhere. The old editor tried to *reverse-engineer
geometry at drag time*, and that is the root cause of every image-editing failure:

1. **The "frame" was a guess.** Handlers assumed `img.parentElement` is the crop window.
   For `<figure>`+caption, a flex row, or a grid cell that is false, and writing
   `width/height/overflow/transform` onto it fought the parent layout — "measure-and-pin"
   was patching that fight, not fixing it.
2. **No gesture could stretch an image.** Crop-mode resize scaled the photo *radially*
   from center (`hypot(dx,dy)`); Move-mode resize changed the crop window, photo fixed.
   Independent width was impossible **by construction**.
3. **Coordinate soup.** Screen px ⇄ iframe-internal px ⇄ CSS `zoom` factor ⇄ mm, converted
   in every handler. CSS `zoom` reports inconsistently through `getBoundingClientRect`.
4. **Two geometry models coexisted** (coupled `object-fit`/`object-position`/`scale` vs a
   decoupled layer), converted lazily on first touch via `naturalWidth` — which is `0`
   before decode. Hence "works sometimes."
5. **A Move/Crop mode toggle** with handles meaning different things in each — not how any
   real tool works, and the direct source of the churn.

**The fix is to make geometry explicit once, up front — a deterministic compile stage —
instead of guessing it per gesture.** Images are just the first element type to go through
it; text boxes and shapes follow the identical path.

Not chosen: a literal `<canvas>`/scene-graph renderer. It would give explicit geometry but
throw away the three things that make Blueline work — CSS text layout, Chromium's
vector-PDF print fidelity, and the LLM's fluency at writing HTML/CSS (the whole
render→review→fix loop depends on a real rendered artifact).

---

## 2. The model

**A page is a fixed-size frame. Every top-level composition block is an absolutely-
positioned _layer_ with explicit mm geometry. Content flows normally _inside_ a layer.**

This is correct for the domain: print collateral has exact fixed dimensions, so there is
nothing to reflow — absolute positioning costs nothing and buys explicit geometry for
text, shapes, and images alike.

### Layer types

| Type    | Geometry persisted                              | Height |
|---------|-------------------------------------------------|--------|
| `text`  | `left, top, width`                              | `auto` (grows downward as copy changes — like a Canva/Figma text box) |
| `shape` | `left, top, width, height`                      | fixed  |
| `image` | frame `left, top, width, height` + inner layer `width, left, top` | fixed frame, aspect-locked photo |

An **image** is a two-part primitive — the canonical form the old `ensureImgLayered` was
groping toward, now produced deterministically by the compiler:

```html
<div data-img-frame="ID" style="position:absolute; left:Lmm; top:Tmm;
     width:Wmm; height:Hmm; overflow:hidden">
  <img data-image-id="ID" style="position:absolute; width:IWmm; left:ILmm; top:ITmm; height:auto">
</div>
```

- **frame** = the crop window (what shows on the page). Resizing it crops/reveals or scales.
- **inner img** = a free photo layer. `width` is the photo's scale; `left/top` pan it;
  `height:auto` keeps aspect. The photo covers the frame by default.

Everything reduces to a small fixed set of numbers per element. No branches, no lazy
conversion, no `naturalWidth` race, no `object-fit`.

### One coordinate space

All geometry is stored and reasoned about in **frame-local millimetres** (the page's own
coordinate system, origin at the page top-left). The only place screen pixels and the CSS
`zoom` factor enter is a single conversion utility (§4), read **once per gesture**.

---

## 3. The compile stage

### Where it hooks

A new engine function `compilePage(project, backend)` runs as a post-processing pass right
after `renderPdf`, at all three render sites:

- `toolkit/src/engine/tools.ts` — the agent's `render` tool
- `toolkit/src/engine/server.ts` — the bridge re-render endpoint
- `toolkit/src/commands/render.ts` — the CLI

It reuses `RenderBackend.withPage()` to load `page.html` in Chromium and read **real
computed layout** — the same engine that prints the PDF, so measured geometry is exact.

### What it does (algorithm) — IMPLEMENTED for images (slot/frame/layer split)

The generated image lives in a crop frame that is itself a flex/grid CHILD, so it can't be
moved or resized without fighting the parent layout. The compiler splits the crop frame's
two roles into three nodes:

- **SLOT** — the original crop-frame element. Keeps its exact measured box, so it holds the
  flex/flow slot and nothing around it reflows. Stops clipping (`overflow:visible`) and
  hands its visual styling to the frame, so its child can grow past it.
- **FRAME** — a new inner `position:absolute` div carrying the crop (`overflow:hidden`) plus
  the migrated visual styling (border-radius / border / background, measured from Chromium).
  This is what the user moves / resizes — freely, because it's absolute in a fixed-size
  relative slot.
- **LAYER** — the `<img>`, `position:absolute` inside the frame, sized to COVER it.

Steps:
1. Load `page.html` in a Chromium page sized to the artboard (`pageDims(settings)`).
2. Wait for images to `decode()` so `naturalWidth/Height` are real (the old drag-time bug).
3. For each `<img data-image-id>`: measure the dedicated crop frame's border-box (or the
   img's own box for a shared parent), its natural aspect, and the frame's computed
   border-radius / border / background.
4. Apply the slot/frame/layer split via linkedom — deterministic, server-side, testable
   without a browser (`applyCompile` takes hand-fed measurements). When the parent is a
   shared container (`<figure>`+caption, etc.), wrap the img alone in a fresh slot in place.

A dedicated crop frame with only the `<img>` inside is the common case (the designer prompt
mandates "every image sits in a crop frame: a container with fixed dimensions and
overflow:hidden"), so the split reuses that element as the slot.

**Deferred (§8):** flattening text/shape composition blocks into absolute layers. Slice 2
normalizes images only — the actual fire — and is validated pixel-identical on a real page.

### Idempotency

Compile is a **fixpoint**: a page already in layer form is left byte-identical (every
layer already has `position:absolute` + explicit mm + the `data-img-frame` shape → skip).
This is asserted by a test that runs compile twice and diffs. Idempotency is what lets it
run after *every* render safely.

### Interaction with the agent loop

The generation + review loop is unchanged — the agent authors natural flow HTML, renders,
gets a vision critique, fixes. Compile runs after the render inside that loop, so from the
first proof onward `page.html` is already in layer form; the agent's later chat-edits
operate on positioned HTML (still fluent — it just sets `font-size` on a positioned div).
Regeneration (a fresh round) re-authors flow HTML → compiled again. Because compile is a
fixpoint, repeated passes never drift.

---

## 4. The geometry module

`app/src/lib/imageGeometry.ts` (rename → `layerGeometry.ts`) — **pure functions, no DOM
mutation, no React.** This is the single home for all coordinate math; no handler does its
own rect arithmetic.

```ts
// One context, captured once at gesture start.
interface FrameCtx { iframeRect: DOMRect; zoom: number; }   // MM_TO_PX = 96/25.4

screenToPageMm(clientX, clientY, ctx): { x: number; y: number }
pageMmToScreen(x, y, ctx): { x: number; y: number }

// Solvers — take a start geometry + a pointer delta, return the new geometry.
// Each keeps the correct invariant, and each is unit-tested in isolation.
resizeFrameCorner(start, handle, dxMm, dyMm, { aspectLock }): FrameGeom  // opposite corner fixed
resizeFrameEdge(start, edge, dMm): FrameGeom                             // one axis, opposite edge fixed
scaleContent(start, factor): ImgLayerGeom                                // photo zoom within frame, centered
panContent(start, dxMm, dyMm): ImgLayerGeom                             // photo pan within frame
```

Because these are pure and take/return plain numbers, the anchor-invariant bugs
("opposite corner drifts") become one-line assertions in `layerGeometry.test.ts` with no
browser.

---

## 5. The gesture contract (CONFIRMED — implemented in slice 3)

One selection state per layer. **No Move/Crop mode toggle.** Figma-exact:

- **Drag the body** → move the layer on the page (write frame `left/top`). Always.
- **Corner handle** → resize the layer; for images the frame + photo scale **together,
  aspect-locked** (composition preserved — "make the picture bigger on the page"). For
  text, corner changes `width` (height stays auto). For shapes, both axes.
- **Edge handle (N/E/S/W)** → resize that **one axis only**:
  - image: **crop/reveal** that side (frame changes, photo stays) → this is what gives
    independent horizontal/vertical sizing, the thing that was impossible before.
  - text: change `width` (E/W); N/S are no-ops for auto-height text.
  - shape: change that axis.
- **Double-click an image** → enter **content mode**: drag pans the photo inside the frame,
  corner handles zoom the photo within the frame. `Esc`/click-out exits. (We may label this
  "Adjust photo" rather than "Crop.")
- **⌘/Alt + corner (image)** → free, non-proportional stretch of the photo (rare, but
  possible — the explicit answer to "scale horizontally").

Handles render in a parent-window overlay (as today), but their math is entirely the §4
solvers, and they persist via §6 on drag-end only.

---

## 6. Engine API

Retire the dual-model `setImageStyle`. Two focused, explicit setters:

```ts
// Whole-image geometry in one atomic write (frame + inner layer).
setImageGeometry(project, id, {
  frame: { leftMm, topMm, widthMm, heightMm },
  layer: { widthMm, leftMm, topMm },     // inner photo; height derived from aspect
}): void

// Text / shape layer geometry.
setLayerGeometry(project, id, { leftMm, topMm, widthMm, heightMm? }): void
```

Both are pure linkedom edits under the existing `mergeStyle` helper, snapshotted for undo
by the bridge exactly like the current edit routes. The client wrappers in
`engine-client.ts` mirror them; the old `imgWidthMm/imgLeftMm/...` params are deleted.

`insertElement` (§ `page-edit.ts`) is updated to emit layers in canonical form: a new
`text` element is an absolute `text` layer (no forced rounded corners, no chip background —
transparent, `height:auto`); `rect` is a `shape` layer; images placed by `use_image` land
as the `data-img-frame` primitive.

---

## 7. Migration & back-compat

- Existing projects are flow-HTML. The **first render after upgrade compiles them** to layer
  form automatically — nothing to regenerate.
- Archived round HTML (`round-N.html`) stays as authored; branching from a round re-renders
  (and thus re-compiles) it.
- `page.html` remains the single source of truth and the export input — export parity is
  preserved because the compiled HTML *is* what Chromium prints.

---

## 8. Open question — nesting granularity (defines the phase boundary)

Phase 1 compiles the **top-level composition** into layers. Deeply nested atoms (one stat
number inside a 3-up card) are not individually absolute until the user manipulates them —
at which point the existing `autoTag` path **promotes** that element to a layer using the
same compiler primitive (measure its computed box → absolute mm in place). This keeps
Phase 1 bounded and testable while preserving deep-edit granularity on demand.

Deferred to a later phase: nested layer *groups* (move a card and have its children ride
along) and a true layer tree in the Layers panel. Phase 1's Layers panel lists the
top-level layers with z-order.

---

## 9. Testing strategy (the "beef up regression testing" mandate)

- **Compiler unit tests** (`compile.test.ts`, linkedom + a stub geometry oracle): feed ~6
  synthetic AI layouts — `object-fit:cover` box, flex child, grid cell, `<figure>`+caption,
  already-layered, no explicit size — assert each yields the canonical layer/frame form
  with sane mm. Plus the **idempotency** diff test (compile∘compile == compile).
- **Geometry unit tests** (`layerGeometry.test.ts`, pure, no DOM): screen⇄page mm
  round-trips at zoom ∈ {0.5, 0.713, 1, 2}; `resizeFrameCorner` holds the opposite corner
  fixed; `resizeFrameEdge` moves one axis only; `scaleContent` keeps the frame fixed and
  centered; aspect-lock invariants.
- **Engine setter tests** (extend `guards.test.ts`): `setImageGeometry` / `setLayerGeometry`
  produce exact style strings, clamp out-of-range, and round-trip through a re-parse.
- **Component test** (`PreviewPane.test.tsx`): a synthetic corner-drag on a fixture image
  calls `setImageGeometry` with the opposite corner held (guards the wiring, not the math).
- **E2E (Playwright, deferred to after slice 3)**: real drags over the live iframe for
  select/move/resize/crop/add — the one layer only a browser can prove.

---

## 10. Build sequence (slices)

1. **Geometry module** — pure `layerGeometry.ts` + its full unit suite. No UI wiring yet.
   *(does not depend on the gesture contract; safe to build immediately)*
2. **Compiler** — `compilePage` + hook at the three render sites + compiler/idempotency
   tests. After this, every rendered page is in layer form. *(also contract-independent)*
3. **Gesture layer** — rebuild the image overlay handlers on the §4 solvers + §6 setters;
   delete the Move/Crop toggle, `ensureImgLayered`, and dual `setImageStyle`.
   *(needs the §5 contract confirmed)*
4. **Text/shape layers** — extend selection + handles to text (width + auto-height) and
   shapes; update `insertElement`; wire the mm⇄px toggle.
5. **Layers panel + FAB** — chat → bottom-right FAB; rail hosts the property panel + a
   Layers list with z-order reordering.

Each slice ships with its tests green and bumps the version (distinct build per hand-off).
```
