# Blueline Import (Figma plugin)

Rebuilds a Blueline document inside Figma as **real, editable layers** — text stays text,
images stay images, geometry matches the print layout to the sub-pixel.

## Install (one minute, no build step)

1. In Blueline: **Export → Figma scene**. Save the `.json` somewhere you can find it.
2. In the Figma **desktop app**: menu → **Plugins → Development → Import plugin from
   manifest…**, and pick `figma-plugin/manifest.json` from this repo.
3. Run **Plugins → Development → Blueline Import**, then drop the JSON onto the window.

The plugin is plain JavaScript with no dependencies — there is nothing to compile, and it
makes no network requests (`networkAccess: none`). Everything it needs is in the file you drop.

## What you get

One Figma frame per printed page, laid out side by side inside a wrapper frame:

| Blueline | Figma |
|---|---|
| Text element | `TEXT` node — real characters, font size, weight, colour, line-height, letter-spacing, alignment, and text-case |
| Background / border box | `RECTANGLE` — fill, per-corner radius, inside stroke |
| Image | Clipping `FRAME` + inner `RECTANGLE` with an image fill — reproduces Blueline's crop model exactly, so pan/zoom survives |

Geometry is emitted in CSS pixels at 96 dpi — the space Chromium actually laid the page out
in — so an A4 page arrives as a 794 × 1123 frame. `pxPerMm` is recorded in the scene file if
you need to convert back to millimetres.

## Fonts

Figma can only use fonts it has. The plugin resolves each `(family, weight, italic)` triple
against the fonts available in your file, trying the real family first across Figma's various
style spellings (`Semi Bold` / `SemiBold` / `Demi Bold`, …), then falling back to **Inter** at
the matching weight, and finally Inter Regular.

Any substitution is reported in the plugin window when the import finishes — so a document set
in a webfont Figma doesn't have will still come in with the right structure and weights, and
you'll be told which family to install if you want an exact match.

## Known boundaries (v1)

These are deliberate, not silent — the exporter records what it skipped in the scene's
`warnings`, and the plugin surfaces them after import:

- **Paint order follows DOM order.** Explicit `z-index` stacking is not resolved.
- **Gradients, box-shadows and pseudo-element (`::before` / `::after`) content are not
  emitted.** Print collateral rarely relies on them, and Blueline's own export strips shadows
  anyway (Chromium's PDF path renders them wrong).
- **CSS transforms are ignored** — the axis-aligned bounding box is used.
- **One text node per element.** An inline `<span>` with its own styling is flattened into its
  parent's style rather than becoming a styled range.
- **Pages without explicit page containers are split by artboard height.** Multi-page documents
  authored as `<section class="page">` split exactly; auto-paginated ones are approximated, and
  the scene carries a warning saying so.

## Why a plugin rather than a `.fig` file

Figma's own file format is undocumented, binary (Kiwi-serialized) and changes without notice,
and the REST API is read-only where node creation is concerned. The Plugin API is the only
supported way to create Figma layers, so Blueline emits a plain JSON scene graph and lets this
plugin do the construction. That also means the scene format is yours to consume — nothing
stops another tool reading the same JSON.
