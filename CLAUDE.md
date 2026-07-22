# Presscheck — dev notes for Claude Code sessions

> **The engine is authoritative, not this file.** Presscheck embeds the Pi coding agent
> (`toolkit/src/engine/`) as its production harness; the design-loop contract lives in
> [toolkit/src/engine/prompt.ts](toolkit/src/engine/prompt.ts). This file only orients
> dev sessions working ON Blueline.

## What this is
An "AI Photoshop for print collateral": an embedded agent iteratively designs HTML →
renders PDF (Chromium) → gets vision-model review → fixes → repeats; a human then
polishes in a live viewer and exports. See README.md for architecture, and the approved
plan for milestones (M1 engine ✓, M2 viewer, M3 Electron shell, M4 export/variants).

## Layout
- `toolkit/src/engine/` — the product core: Pi session (`session.ts`), system prompt
  (`prompt.ts`), domain tools (`tools.ts` → render/review/gen_images/web_fetch),
  CLI runner (`run.ts`). Tool logic lives in plain modules (`render.ts`, `review.ts`,
  `images.ts`, `web-fetch.ts`) so the harness stays swappable.
- `toolkit/src/commands/` — thin CLI wrappers over engine modules.
- `config/providers.json` — designer/reviewer/images model config (gitignored;
  see providers.example.json). Designer targets Kimi K3 via `moonshotai` once
  MOONSHOT_API_KEY exists; smoke-test config uses Gemini.
- `projects/<slug>/` — one dir per deliverable (brief.md, page.html, images/, out/,
  review/, fetched/). `projects/demo/` is the e2e test project.
- `context/`, `styles/` — repo-level source material and brand guides (agent-read-only).

## Dev commands (run from toolkit/)
- `npm run agent -- projects/demo [--model provider/model]` — full loop
- `npm run render|review|gen-images -- projects/<slug>` — individual steps
- `npm test` — guard tests (web_fetch SSRF/budget, review round cap)
- `npm run typecheck`

## Gotchas
- Pi APIs: verify against `node_modules/@earendil-works/pi-coding-agent/dist/*.d.ts`,
  not memory — the package moves fast. TypeBox import is `typebox` (v1), not `@sinclair/typebox`.
- `review` needs GEMINI_API_KEY; rasterization is pdf-to-img (pure JS).
- Never overwrite generated image variants; `nextVariant()` handles numbering.
- Keep bash OUT of the agent's tool allowlist (`session.ts` BUILTIN_TOOLS).

## Versioning & releases (MANDATORY)
Every batch of user-facing changes bumps `app/package.json` `version` BEFORE
`npm run package` — minor (0.X.0) for features, patch (0.0.X) for fixes. Never
ship two different builds under the same version.

Why this is load-bearing: the dmg filename (`blueline-<version>-arm64.dmg`) and
the version badge in the app topbar (stamped with build time via vite `define`
in `app/vite.config.ts` — hover it for the exact timestamp) are how the user
confirms they're running the latest build. A stale version number silently
breaks that trust.

Release checklist: bump version → `cd app && npm run package` → smoke the
packaged .app (`BLUELINE_SMOKE=1`, expect exit 0) → verify the smoke capture
shows the NEW version badge → commit with the version in the message → push.

Smoke isolation trap: if a blueline instance is already running, it holds
port 7717 and the smoke instance silently attaches to the OLD app's bridge —
the capture then shows the old version/UI and proves nothing. Always smoke with
`BLUELINE_PORT=<free port>` (and ideally `BLUELINE_HOME=<scratch dir>` whose
workspace has a project with a page open) so the packaged app boots its own
bridge and serves its own bundled dist.
