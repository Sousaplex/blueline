# Presscheck — dev notes for Claude Code sessions

> **The engine is authoritative, not this file.** Presscheck embeds the Pi coding agent
> (`toolkit/src/engine/`) as its production harness; the design-loop contract lives in
> [toolkit/src/engine/prompt.ts](toolkit/src/engine/prompt.ts). This file only orients
> dev sessions working ON presscheck.

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
