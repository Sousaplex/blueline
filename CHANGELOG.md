# Changelog

All notable user-facing changes to Blueline. Kept from v0.17.0 onward
(earlier history is intentionally not backfilled). Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); versions match `app/package.json`
and the GitHub release tags.

## [Unreleased] — 0.18.0

Batch of fixes and features from the first round of test-user feedback.

### Added
- **QR-code tool** — the agent can generate a scannable QR (URL, text, vCard) as a
  print-ready SVG (or PNG) and place it in the design (`gen_qr`).
- **Reuse existing images** — the agent can now place a real photo/logo from `context/` or
  `brand/` into a design (new `use_image` tool) instead of always generating one; the prompt
  lists what's available and prefers reuse (brand logos are never regenerated).
- **Floating image toolbar** in live edit: move the image, pan inside the crop, resize the
  box, zoom within the crop, and shuttle variants — all from a toolbar on the selected image.
- **Cancel a generation** — the Run button becomes Cancel while a run is active; aborts the agent.
- **Generation animation on the canvas** while the agent designs (prominent card on first
  render, subtle pill once a proof exists).
- **Document type / genre** (one-pager, infographic, poster, deck, report, brochure, flyer) —
  selectable at creation and changeable from chat ("make this an infographic"). Drives
  genre-appropriate layouts, distinct from page size.
- **Anti-slop guardrails** in the designer prompt and reviewer (no center-everything, no
  gradient-on-everything, no fake depth, no emoji icons, color/type discipline).
- **Find/replace in the code view** (Cmd+F).
- **Close/delete a document** from its tab (X, with confirm).

### Fixed
- **WebP images no longer drop out of the exported/proof PDF** (the renderer now waits for
  images to decode before printing). This also removes a class of phantom "box" artifacts
  that appeared in the proof but not in live edit.
- Image variant shuttle now updates the live canvas while an image is selected.

### Changed
- Document tabs restyled to look like real file tabs; the "processing" state is an animated
  spinner (queued stays a static amber dot).
- The reviewer judges composition by the document's genre, so an infographic's modular grid
  is no longer flagged as a hierarchy defect.

## [0.17.1] — notarization support

### Added
- Notarize + staple support in the packaged build (`@electron/notarize`, `afterSign` hook):
  set `APPLE_API_KEY` / `APPLE_API_KEY_ID` / `APPLE_API_ISSUER` to produce a notarized,
  staple-verified app so the first launch skips the Gatekeeper prompt.

## [0.17.0] — signing & auto-update

### Added
- **Code-signed** builds (Developer ID, hardened runtime) with correct entitlements for the
  bundled Node bridge and Playwright Chromium.
- **Auto-update from GitHub Releases** (`electron-updater`): the app checks the releases feed
  on launch and installs newer signed builds in the background. `npm run release:publish`
  publishes a release; see `app/RELEASING.md`.

### Changed
- Launch in **light (day) mode** by default; dark applies only if explicitly chosen.
