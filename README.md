# Presscheck

AI art-director sidecar: an agent (Claude Code today, anything tomorrow) iteratively
designs print marketing material — HTML → PDF → visual review → fix — until a vision
model says the proof matches the brief, then a human polishes it in a live viewer.

## Architecture

Two halves, deliberately decoupled:

**1. The brain (swappable).** Any agentic harness that can read files, edit files, and run
CLI commands. Today that is a Claude Code session opened in this directory — `CLAUDE.md`
is its operating manual. The harness is *not* load-bearing: every capability the agent
uses is a plain CLI command in `toolkit/`, so the same loop can later be driven by the
Claude Agent SDK embedded in an app (see "Standalone later" below).

**2. The toolkit (this repo's actual code).** Deterministic tools the agent shells out to:

| command | what it does |
|---|---|
| `npm run gen-images -- projects/<slug>` | reads `images/prompts.json`, calls the configured image provider (default: Gemini Nano Banana 2), writes variants |
| `npm run render -- projects/<slug>` | headless-Chromium print of `page.html` → `out/proof.pdf` |
| `npm run review -- projects/<slug>` | rasterizes the PDF, sends pages + brief + style guide to the vision reviewer (default: Gemini Flash 3.5), writes structured feedback |
| `npm run viewer -- projects/<slug>` | localhost editor: inline copy editing, image-variant shuffling, export (PDF/PNG/print-ready) |

Providers are behind one interface (`toolkit/src/providers/`) configured in
`config/providers.json` — adding DALL·E/Flux/etc. is one file.

## Why not Tauri (yet)

The end-user surface is the **viewer**, and the viewer is a web page. A localhost web app
gets you the whole product loop with zero packaging friction, and the agent can drive and
verify it directly. Tauri buys native menus, file associations, and a .dmg — none of which
change the loop. **Standalone later:** when it's time to ship this without Claude Code,
wrap the toolkit + Claude Agent SDK (the same loop, programmatic) in a Tauri shell. The
repo layout already assumes that split, so nothing gets rewritten.

## Getting started

```bash
cd toolkit && npm install
cp config/providers.example.json config/providers.json  # add GEMINI_API_KEY
# drop source material in context/, brand assets in styles/
# open Claude Code here and say: "new one-pager for <thing>"
```
