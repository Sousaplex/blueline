# Changelog

All notable user-facing changes to Blueline. Kept from v0.17.0 onward
(earlier history is intentionally not backfilled). Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); versions match `app/package.json`
and the GitHub release tags.

## [0.30.0]

Sync heals older workspaces, and adds a gated force-overwrite escape hatch.

### Fixed
- **"refusing to merge unrelated histories" on sync.** A workspace connected before adopt-on-connect
  (0.28) had a git history unrelated to the remote's, so the new merge-based sync refused it. Sync now
  heals that automatically the first time — it reconciles the two histories instead of erroring.

### Added
- **Force overwrite (with a warning).** For a sync too tangled to merge document-by-document, the Git
  panel now has a gated **Force overwrite…** with two clearly-warned choices: *Push mine over remote*
  (the repo becomes exactly your workspace) or *Reset mine to remote* (your workspace becomes exactly
  the repo). Both are destructive by design and spell out what's lost before you commit to it.

## [0.29.0]

Real multi-person collaboration: unique document ids + a merge-conflict resolver with fork.

### Added
- **Merge-conflict resolution with "Keep both".** If a teammate edited the *same* document while
  you did, Sync no longer fails silently — it pauses and shows each conflicted document with three
  choices: **Keep both** (default), **Keep mine**, or **Keep theirs**. *Keep both* saves your
  version as a brand-new document credited to you (from your git name), and keeps theirs — so no
  one's work is ever lost. Resolve and it pushes.

### Changed
- **Every new document gets a unique folder id** (a readable slug plus a short random suffix,
  e.g. `acme-flyer-x7k2p9qm`). Two people who independently create documents with the *same
  name* in a shared repo no longer clobber each other — both coexist. The display name is free to
  repeat. Existing documents keep their current folders unchanged.
- Workspace sync now integrates remote changes with a merge (was rebase), which makes the
  keep-mine / keep-theirs choices unambiguous during a conflict.

## [0.28.0]

Workspace git sync now works with team repos that already have content.

### Fixed
- **Connecting to a non-empty repo pulls it in.** Previously, connecting a workspace to a repo
  that already had commits started a fresh, unrelated history — so the first sync was rejected
  with a confusing `non-fast-forward` error. Now connecting **adopts** the repo: its files and
  history come into your workspace (your local files are kept), so sync just works.
- **Concurrent edits merge automatically.** When a teammate pushes while you're syncing, Blueline
  now integrates their changes and retries the push. Edits to *different* documents merge with no
  intervention; only a true same-file overlap needs manual resolution.

## [0.27.0]

Shareable project files, and a fix for silent update failures.

### Added
- **Two new file types for sharing and backup.** Export a **`.blueline`** file (one finished
  document, self-contained with its images — hand someone the deliverable) or a **`.blueproject`**
  (the whole family of variants/series plus the brand assets and sources they use — hand off the
  working set). Both are in the "+" menu next to the document tabs. **Import** either one from the
  Home screen — it expands back into your workspace, merging shared brand/sources and reconnecting
  variant lineage. Each file is stamped with the Blueline version that made it.

### Fixed
- **Updates no longer fail silently.** If an update can't install, you now see *why* instead of the
  app just closing. The most common cause — running Blueline from the DMG or Downloads instead of
  **Applications** — is now detected and explained, and the app reliably relaunches itself after a
  successful update.

## [0.26.0]

The agent can download real logos and photos now — no more generated stand-ins.

### Added
- **Download real images.** The agent has a new `fetch_image` ability: when a company's real
  logo or product photo lives on their website, it downloads the actual file (into the brand
  library for logos, sources for photos) and places that, instead of generating a look-alike.
  `web_fetch mode=brand` now hands the agent the logo's URL and tells it to grab the real file.

### Fixed
- **Conversation export now captures tool calls.** The export introduced in 0.24.0 was recording
  runs but showing zero tool calls (it read an older internal message shape). It now captures
  every tool call, its arguments, and results — so an exported `.json` actually shows what the
  agent did.

## [0.25.0]

Let the content decide the page count — ideal for formatting a document or letter.

### Added
- **Auto page count.** Next to the page-count field (in a project and in the New-project dialog)
  there's now an **Auto** toggle. With it on, you don't pick a number — the agent uses as many
  pages as the content needs and the reviewer stops enforcing a fixed count. Perfect for "take
  this markdown and format it nicely on our letterhead": the text flows across however many
  pages it takes, with the letterhead/header repeated on each page and clean breaks (no stranded
  headings, no split tables). You can also just ask in chat ("make it fit the content" / "as many
  pages as it needs") and the agent flips it on. Slide decks stay fixed-count.

## [0.24.0]

See what the agent actually did — export a project's full conversation and watch context usage.

### Added
- **Export conversation** (download icon in the Agent panel). Downloads the project's complete
  agent history across every run — every prompt, tool call **with its arguments**, tool result,
  and the model's reasoning — plus the system prompt, as one JSON file you can hand off for
  analysis (e.g. to see exactly which pages a brandbook fetch reached and what came back). In
  the desktop app it opens a Save dialog; in the browser it downloads directly.
- **Context-usage meter** in the Agent panel header. While the agent works it shows how full the
  model's context window is (percent + tokens), so you can tell when a long run is nearing the
  limit and a compaction is coming.

## [0.23.0]

Smaller/faster app, deeper agent sandboxing, and an end-to-end test net.

### Changed
- **Leaner, faster app.** The download and disk footprint drop substantially (build-time-only
  dependencies are no longer shipped, app resources are packed into an archive), and launch is
  quicker — the Chromium check is skipped once it's cached and no longer re-transpiles the
  engine on every start path. An offline first launch no longer hangs.

### Security
- **The agent can only write inside its own project folder.** Its file-write/edit tools are
  now hard-confined, so a prompt-injection hidden in fetched web content can't make it write
  outside the project (e.g. into your home or login items).
- **Web fetches are re-checked on every redirect hop**, not just the first URL — a public link
  that redirects to a private/internal address is now blocked mid-chain.

### Tests
- **End-to-end harness** (`npm run test:e2e`): boots the real app on a real engine over a
  fixture project in headless Chromium and verifies the live-edit surface — compile stage,
  click-to-select (text + image), the Layers panel, and adding an element — the interaction
  layer that unit tests can't reach.

## [0.22.1]

Reliability pass — editor performance and engine race conditions.

### Fixed
- **Dragging elements is smoother.** A block drag now updates only the canvas during the
  gesture and syncs the rest once on release, instead of re-rendering the whole app on every
  mouse move.
- **Undo is safe around agent runs.** Undo/redo are refused while the agent is generating (they
  would have clobbered its in-progress edits), and a stale-measurement race that could bake an
  out-of-date image layout over a fresh edit is now guarded.
- **No more duplicate agent sessions or double-starts.** Rapid Run clicks or a chat-and-run in
  quick succession can no longer spin up two sessions (duplicate feed events) or two runs.
- **Compile failures are surfaced** in the System tab instead of being silently swallowed.
- **Esc deselects** even when keyboard focus is on the app chrome (not just the canvas).

### Security
- Request bodies are size-capped; uploaded source files are served with `nosniff` and forced
  to download unless they're a known-safe image/text/pdf (an uploaded `.html`/`.svg` can no
  longer execute on the bridge origin).

## [0.22.0]

Agent source/brand curation, web crawl, a security-hardening pass, and live-edit fixes.

### Added
- **The agent can now curate your source library and brand home.** Three new design-agent
  tools (also driven by chat, e.g. "read this website and put the key info in sources"):
  - `write_source` — distill research (typically after `web_fetch`) into a structured
    markdown doc in the workspace `context/` library, with source URL + date cited.
  - `write_brand` — author or update brand guideline docs in `brand/` (voice & tone,
    palette hexes, typography, logo usage, do/don'ts). Text docs only — logos, fonts and
    photos can never be overwritten.
  - `organize_sources` — rename/move library files within or between `context/` and
    `brand/` (`context/notes.md` → `context/acme/product-notes.md`). Never overwrites; a
    batch is validated in full before any file moves.
  The Sources and Brand panels update live as the agent writes. MCP gains a matching
  `organize_sources` tool (new bridge endpoint `/api/sources/move`); outside these tools
  the workspace dirs remain read-only to the agent.
- **`web_fetch` crawl mode.** One call reads a page plus a few short-path same-domain pages
  (about/pricing/etc.) — pairs with `write_source` for "read this site and summarize it."
  Same-domain only, budget-capped, each hop re-validated against the SSRF guard.

### Fixed
- **Inspector position edits show up immediately.** Typing an X/Y value or hitting "Reset
  position" now moves the element on the canvas at once (it used to persist silently and only
  appear after you deselected).
- **Edits no longer silently vanish on a save hiccup.** If the engine can't save a change it
  now surfaces an error toast instead of dropping it (the change used to revert on next reload).
- **Undo can't be corrupted by a just-finished drag.** A pending debounced move-save is now
  cancelled when you deselect, undo, or delete — so an undo right after a drag stays undone.
- **Uploading an image variant is undoable** (⌘Z), like every other page change.
- **Reordering from the Inspector's ↑↓** now takes effect immediately (it deselects first, the
  same way the Layers panel already did).

### Security (internal hardening)
- **The local engine bridge is now loopback-only and same-origin-gated.** It binds
  `127.0.0.1` (not all interfaces), drops the wildcard CORS header, and rejects any request
  whose Origin/Host isn't local — so a website you visit or another device on your network
  can no longer read your workspace, start runs, or drive git.
- **Generated pages can't run scripts.** The live-edit iframe is sandboxed (no script
  execution) and `page.html` is served with a `script-src 'none'` CSP; the print/export
  window renders with JavaScript disabled and OS sandboxing. A malicious snippet in an
  AI-authored page can no longer reach the app or the network.
- **`git clone` URL hardening** — rejects `ext::`/option-injection URLs and pins transports.
- **Opening a project by absolute path is confined** to the workspace's projects folder;
  `open-path` (from the UI) only opens documents/folders, never launches apps.

## [0.21.1]

### Fixed
- **"Preparing image for editing…" no longer loops.** Projects made before 0.21 now get their
  images normalized once, automatically, when you open Live edit — instead of a re-render
  firing on every gesture (which never landed because the selected image froze the canvas).
- **Images can be deleted.** Select an image and press Delete/Backspace, or use the new trash
  button on the image toolbar (⌘Z restores it).
- **Layer reordering works for images**, and **⌘] / ⌘[** now bring the selected element
  forward / send it backward (image or text/box) — matching the Layers panel arrows.

## [0.21.0]

Image editing, rebuilt from the foundation up (see `docs/layer-model.md`).

### Changed
- **Images are now real, directly-editable objects.** Every image is normalized once, up
  front, from the browser's true measurements into a stable *frame + photo layer* — instead
  of the old approach that guessed geometry mid-drag and fought the page's flex/grid layout
  (the reason resize/move kept breaking). One coherent gesture model, no Move/Crop toggle:
  - **Drag** the image to move it on the page.
  - **Corner** handle resizes it proportionally (bigger/smaller on the page).
  - **Edge** handle crops/reveals that one side — so you can finally size an image
    horizontally or vertically on its own.
  - **⌥/⌘ + corner** stretches it freely (non-proportional).
  - **Double-click** to adjust the photo inside the frame (drag to pan, corners to zoom),
    Esc to finish.

### Added
- **Contextual property panel.** Selecting any text/box element shows editable properties —
  font family, size, bold/italic, alignment, text + fill color, corner radius, box width,
  and exact position — with a **mm ⇄ px** toggle. Changes apply live and persist.
- **Layers panel.** The right rail lists every element in the document (with its z-index);
  click to select it on the canvas, and reorder with the ↑/↓ controls.
- **Chat moved to a floating button.** The agent chat is now a bottom-right button that opens
  on demand, freeing the rail for the property + layers panels.
- A `compile` step after every render bakes images into the editable layer form (idempotent,
  pixel-identical to the rendered proof). Existing projects convert automatically on their
  next render.

### Changed
- **Added elements are cleaner.** A new box is a real sharp-cornered box (no forced rounded
  corners), and new text is plain text — restyle either from the property panel.

### Tests
- New pure-geometry unit suite (anchor invariants, edge-crop, aspect-lock, zoom round-trips)
  and compiler tests (layout variants + idempotency) — the interaction layer that kept
  silently regressing is now covered.

## [0.20.3]

### Fixed
- **Image resize anchors correctly.** Dragging a corner handle now pins the opposite corner
  even on layouts where the frame reflows, and the handles have a bigger grab target so you
  hit the handle (resize) instead of the body (move).
- **Nudge works again.** Arrow-key nudging is now handled at the app level too, so it fires
  whether keyboard focus is on the canvas or the app chrome (it was iframe-focus-only).
- **No delete confirmation.** Deleting an element happens immediately — ⌘Z restores it.

### Tests
- Engine coverage for the add-element and layered-image ops (part of hardening against the
  live-edit regressions).

## [0.20.2]

### Fixed
- **Image drag no longer sticks.** Releasing the mouse over the live-edit canvas could leave a
  drag "stuck" to the cursor (moves then freezes) because the release landed on the iframe and
  the parent never saw it. All image drags now use pointer capture, so release always ends them.
- **Added elements are visible.** Inserted text/headings were dark-on-dark on some designs
  (looked like nothing happened). They now get a legible chip and sit on top.
- **Image editing responsiveness.** The move/pan drag was bound to iframe-internal events, so
  it broke the moment the cursor left the image, and it re-rendered React on every frame
  (laggy). Rewrote all image manipulation — move, pan, resize, scale — to drag in the parent
  window with direct-DOM updates.

### Changed
- **Figma-style image model.** The image is now a free layer inside a crop-window container,
  decoupled: **Move** — drag moves the box, corner handles resize the **crop window** (the photo
  stays put, you reveal more/less — a true crop, no rescale). **Crop** (toolbar) — drag pans the
  photo, corner handles scale the photo inside the window. Replaces the old `object-fit`/zoom
  approach that rescaled the photo whenever you resized the box.
- Removed the persistent bottom variant strip (shuttling stays on the image toolbar + Inspector).

## [0.20.0]

Canvas-editing overhaul.

### Added
- **Direct-manipulation image controls** — a selected image shows a selection frame with
  8 resize handles. **Move** mode: drag to reposition, drag a corner to resize the box.
  **Crop** mode (toolbar toggle): drag to pan the photo, drag a corner to zoom it inside
  the box. Replaces the old competing move/crop buttons and ± Size/Zoom controls.
- **Add elements** in live edit — text box, heading, rectangle/tint block, divider — from
  the canvas tool palette. New elements are freely positioned and edit/drag like any other.

### Fixed
- Restored the **all-images variant shuttle** (cycle every generated image's variants at a
  glance), now in Live edit where the change is immediately visible.

### Changed
- First automated **regression tests** for the live-edit Inspector (alignment strip, variant
  shuttle), so those controls can't silently disappear again.

## [0.19.0]

### Added
- **Configurable run concurrency** — the number of projects that generate at once is now a
  setting (Settings → Runs), default raised from 2 to **3**, adjustable 1–10. Raising it lets
  queued runs start immediately.
- **About dialog** — click the app logo (or version) to see the version and the full changelog.
- **Frameless window chrome** — the OS title bar is hidden; the app's top bar carries the
  window (Spotify/VS Code style) with the traffic lights inset over it.

### Changed
- **Updates now ask before downloading.** Instead of silently downloading in the background,
  the app notifies you that a new version is available and downloads only when you click
  **Download**, then installs only when you click **Restart**.

## [0.18.1]

Batch of fixes and features from the first round of test-user feedback.
(Supersedes the internal 0.18.0 test build; the box-shadow PDF fix below is
the change on top of it.)

### Added
- **Estimated cost per run** — after each generation the agent feed shows a "Run cost ~$X"
  chip (designer tokens + images + review + search), estimated from Google's Gemini prices.
- **Git sync: change repo / disconnect** — repoint a workspace to a different git remote or
  disconnect entirely (keep local history, or optionally erase it) from Settings → Git.
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
- **No more "solid square" artifacts in the PDF.** Chromium's PDF renderer draws CSS
  `box-shadow` blur as a hard solid rectangle behind the element — showing up as phantom
  colored squares in the proof/export but not in the (correctly-blurred) live preview.
  Shadows are now stripped from the print output (and from live edit, to stay WYSIWYG),
  and the designer is told to use borders/tints/offset blocks for depth instead.
- **WebP images no longer drop out of the exported/proof PDF** (the renderer now waits for
  images to decode before printing).
- Image variant shuttle now updates the live canvas while an image is selected.
- Library panel: "Close project" no longer overflows the sheet, and the project list
  scrolls again.
- Undo/redo no longer yanks the canvas to the changed element — it flashes in place instead.
- The variant-shuttle strip no longer appears in Proof mode (where it couldn't take effect
  without a re-render); variant switching stays on the live-edit image toolbar.

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
