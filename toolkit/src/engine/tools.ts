import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { BluelineConfig } from "./config.ts";
import { compilePage } from "./compile.ts";
import { generateImages } from "./images.ts";
import { pageDims, safeRelPath, type Project } from "./project.ts";
import { generateQr } from "./qr.ts";
import type { RenderBackend } from "./render.ts";
import { RoundLimitError, runReview } from "./review.ts";
import { runWebSearch } from "./search.ts";
import { moveWorkspaceFiles, writeWorkspaceDoc, type SourceMove, type WorkspaceArea } from "./sources.ts";
import { fetchAsset, fetchWeb } from "./web-fetch.ts";

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }], details: {} };
}

/** The four Blueline domain tools, bound to one project + render backend. */
export function buildPresscheckTools(project: Project, backend: RenderBackend, config: BluelineConfig) {
  const render = defineTool({
    name: "render",
    label: "Render PDF",
    description:
      "Render page.html to out/proof.pdf via headless Chromium print. Call after every meaningful edit to page.html, and always before review.",
    promptSnippet: "render: page.html -> out/proof.pdf (Chromium print)",
    parameters: Type.Object({}),
    async execute() {
      await backend.renderPdf(project.pageHtml, project.proofPdf, config.render);
      // Normalize images into directly-editable layer form (idempotent, non-fatal).
      await compilePage(project, backend).catch(() => {});
      return text(`Rendered ${project.pageHtml} -> ${project.proofPdf}`);
    },
  });

  const review = defineTool({
    name: "review",
    label: "Visual review",
    description:
      "Send the rendered proof.pdf to the visual reviewer. Returns a verdict (pass|revise) with per-page layout issues and suggested fixes. Requires a fresh render first.",
    promptSnippet: "review: proof.pdf -> verdict + issues (vision model)",
    parameters: Type.Object({}),
    async execute() {
      try {
        const { round, result, pageCount } = await runReview(project, config);
        return text(
          `Review round ${round}/${config.reviewer.maxRounds} (${pageCount} page(s)):\n` +
            JSON.stringify(result, null, 2),
        );
      } catch (err) {
        if (err instanceof RoundLimitError) return text(err.message);
        throw err;
      }
    },
  });

  const genImages = defineTool({
    name: "gen_images",
    label: "Generate images",
    description:
      "Generate image variants from images/prompts.json via the configured image model. Optionally pass ids to regenerate only specific specs (e.g. after reviewer feedback). Never overwrites existing variants.",
    promptSnippet: "gen_images: prompts.json -> images/<id>/vN.png variants",
    parameters: Type.Object({
      ids: Type.Optional(Type.Array(Type.String({ description: "prompt spec ids to (re)generate; omit for all" }))),
    }),
    async execute(_id, params) {
      const summaries = await generateImages(project, config, params.ids);
      const lines = summaries.map((s) => {
        const ok = s.files.map((f) => f.replace(`${project.dir}/`, "")).join(", ") || "none";
        const errs = s.errors.length ? ` | errors: ${s.errors.join("; ")}` : "";
        return `${s.id}: ${ok}${errs}`;
      });
      return text(`Generated variants:\n${lines.join("\n")}`);
    },
  });

  const useImage = defineTool({
    name: "use_image",
    label: "Use an existing image",
    description:
      "Place an EXISTING image from the workspace (context/ or brand/) into an image slot instead of generating a new one. Prefer this whenever a suitable real photo, logo, or graphic already exists — reused real photography beats synthetic imagery, and brand logos must be reused, never regenerated. After calling, reference it in page.html as an image slot.",
    promptSnippet: "use_image: copy a context/ or brand/ image into images/<id>/ (reuse, don't generate)",
    parameters: Type.Object({
      id: Type.String({ description: "image slot id to place it in, e.g. 'hero', 'logo', 'team'" }),
      source: Type.String({
        description: "path of an existing image relative to context/ or brand/, e.g. 'photos/team.jpg' or 'logos/acme.png'",
      }),
    }),
    async execute(_id, params) {
      const rel = safeRelPath(params.source);
      const src = [join(project.workspace.contextDir, rel), join(project.workspace.brandDir, rel)].find((p) => existsSync(p));
      if (!src) return text(`No such image in context/ or brand/: ${rel}. List available files with ls/read first.`);
      const ext = (rel.match(/\.[a-z0-9]+$/i)?.[0] ?? ".png").toLowerCase();
      const slot = safeRelPath(params.id).replace(/\//g, "-");
      const destDir = join(project.imagesDir, slot);
      mkdirSync(destDir, { recursive: true });
      const used = readdirSync(destDir)
        .map((f) => Number(/^v(\d+)\./.exec(f)?.[1]))
        .filter((n) => Number.isFinite(n));
      const n = used.length ? Math.max(...used) + 1 : 1;
      const destRel = `images/${slot}/v${n}${ext}`;
      cpSync(src, join(project.dir, destRel));
      return text(
        `Placed ${rel} into ${destRel}. Reference it as <img src="${destRel}" data-image-id="${slot}"> ` +
          `inside a crop frame. Do NOT gen_images for this slot.`,
      );
    },
  });

  const webFetch = defineTool({
    name: "web_fetch",
    label: "Fetch web page",
    description:
      "Fetch a public web page. mode=markdown returns readable page text; mode=brand extracts the visual identity (color palette, fonts, logo, theme color + homepage screenshot) — ALWAYS use brand mode on a company's site before designing for them; mode=screenshot saves a full-page PNG; mode=crawl reads the entry page plus a few short-path same-domain pages (about/pricing/etc.) in one call — use it to gather source material for write_source, not per-page fetching.",
    promptSnippet: "web_fetch: url -> markdown | brand identity | screenshot | crawl (page + a few same-site pages)",
    parameters: Type.Object({
      url: Type.String({ description: "http(s) URL to fetch" }),
      mode: Type.Optional(
        Type.Union(
          [Type.Literal("markdown"), Type.Literal("brand"), Type.Literal("screenshot"), Type.Literal("crawl")],
          { description: "markdown (default) for content, brand for visual identity, screenshot for a PNG, crawl for a small same-site sweep" },
        ),
      ),
    }),
    async execute(_id, params) {
      const result = await fetchWeb(project, backend, config, params.url, params.mode ?? "markdown");
      const cachedNote = result.cached ? " (cached)" : "";
      if (result.mode === "screenshot") {
        return text(`Screenshot saved${cachedNote}: ${result.value} — use the read tool to view it.`);
      }
      return text(`Fetched${cachedNote}:\n\n${result.value}`);
    },
  });

  const fetchImage = defineTool({
    name: "fetch_image",
    label: "Download image",
    description:
      "Download a REAL image from a URL (a company's actual logo, a product photo) and save it into the workspace — into='brand' for logos/marks, into='context' for photography. web_fetch mode=brand reports a page's logo URL; pass that URL here to grab the real file, then place it with use_image. ALWAYS prefer this over gen_images for a logo or a real product photo that exists on the web — never generate a fake logo when the real one is downloadable.",
    promptSnippet: "fetch_image: url + into(brand|context) -> saves the real image; then use_image to place it",
    parameters: Type.Object({
      url: Type.String({ description: "direct http(s) URL of the image file (e.g. a .png/.jpg/.svg logo)" }),
      into: Type.Optional(
        Type.Union([Type.Literal("brand"), Type.Literal("context")], {
          description: "brand (default) for logos/marks — reused across projects, never regenerated; context for photography",
        }),
      ),
      path: Type.Optional(Type.String({ description: "optional filename/subpath, e.g. 'logos/acme.png' (defaults to the URL's filename)" })),
    }),
    async execute(_id, params) {
      try {
        const into = params.into ?? "brand";
        const r = await fetchAsset(project, backend, config, params.url, into, params.path);
        const kb = Math.max(1, Math.round(r.bytes / 1024));
        return text(
          `Saved the real image to ${into}/${r.path} (${kb} KB, ${r.contentType}). ` +
            `Place it with use_image({ id: "<slot>", source: "${r.path}" })` +
            `${into === "context" ? ' (add kind if needed)' : ""}. Do NOT gen_images a substitute for this.`,
        );
      } catch (err) {
        return text(`Could not download that image: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  });

  const webSearch = defineTool({
    name: "web_search",
    label: "Web search",
    description:
      "Search the web (Google-grounded). Returns a factual answer plus source URLs — use web_fetch to read a promising source in full. Prefer this over fetching search-engine pages.",
    promptSnippet: "web_search: query -> grounded answer + source urls",
    parameters: Type.Object({
      query: Type.String({ description: "what to find out, phrased as a research question" }),
    }),
    async execute(_id, params) {
      return text(await runWebSearch(project, config, params.query));
    },
  });

  const genQr = defineTool({
    name: "gen_qr",
    label: "Generate QR code",
    description:
      "Generate a QR code (URL, plain text, vCard) as a print-ready file placed in an image slot. Default SVG (crisp vector for print). ONLY use this when the brief or the human EXPLICITLY asks for a scannable code or a real link to scan (e.g. 'add a QR to the signup page'). Do NOT invent a QR code or a scan-to-do-X call-to-action that the brief didn't request — most pieces (resumes, reports, letters) should have NO QR code.",
    promptSnippet: "gen_qr: data + id -> images/<id>/qr.svg (ONLY when the brief explicitly asks to scan a link)",
    parameters: Type.Object({
      id: Type.String({ description: "image slot id, e.g. 'signup-qr'" }),
      data: Type.String({ description: "the URL or text to encode" }),
      format: Type.Optional(Type.Union([Type.Literal("svg"), Type.Literal("png")])),
      size: Type.Optional(Type.Integer({ minimum: 64, maximum: 2048, description: "px (PNG only)" })),
      margin: Type.Optional(Type.Integer({ minimum: 0, maximum: 8, description: "quiet-zone modules (default 2)" })),
      ecc: Type.Optional(Type.Union([Type.Literal("L"), Type.Literal("M"), Type.Literal("Q"), Type.Literal("H")])),
    }),
    async execute(_id, params) {
      const rel = await generateQr(project, params);
      const slot = params.id.replace(/\//g, "-");
      return text(
        `QR code written to ${rel} (encodes: ${params.data}). Reference it as <img src="${rel}" data-image-id="${slot}">. ` +
          `A QR must NOT be cropped — size its container to fit and use object-fit: contain (not cover), on a white/light background with quiet-zone margin.`,
      );
    },
  });

  const setFormat = defineTool({
    name: "set_format",
    label: "Change document format",
    description:
      "Change the document's required format — page/slide count, page size, orientation, or document TYPE (one-pager, infographic, poster, deck, report, brochure, flyer). ONLY call this when the human explicitly asked ('add a third page', 'make it A5', 'make this an infographic'); the reviewer follows the updated settings. docType changes the LAYOUT doctrine, not the size. After calling, restructure page.html to match.",
    promptSnippet: "set_format: update required pages/size/orientation/docType (human-requested only)",
    parameters: Type.Object({
      pages: Type.Optional(Type.Integer({ minimum: 1, maximum: 24, description: "new required page/slide count (ignored when autoPages is true)" })),
      autoPages: Type.Optional(
        Type.Boolean({ description: "true = let the content decide the page count (the reviewer stops enforcing a fixed number); false = a fixed count. Turn on for flowing documents like a formatted letter, report, or article." }),
      ),
      pageSize: Type.Optional(
        Type.String({ description: 'e.g. "A4", "Letter", "Slide 16:9", "Square", "Custom" (with widthMm/heightMm)' }),
      ),
      orientation: Type.Optional(Type.Union([Type.Literal("portrait"), Type.Literal("landscape")])),
      docType: Type.Optional(
        Type.String({ description: 'document genre: "one-pager" | "infographic" | "poster" | "deck" | "report" | "brochure" | "flyer"' }),
      ),
      widthMm: Type.Optional(Type.Number({ description: "Custom size only" })),
      heightMm: Type.Optional(Type.Number({ description: "Custom size only" })),
    }),
    async execute(_id, params) {
      const patch: Record<string, unknown> = {};
      for (const key of ["pages", "autoPages", "pageSize", "orientation", "docType", "widthMm", "heightMm"] as const) {
        if (params[key] !== undefined) patch[key] = params[key];
      }
      if (!Object.keys(patch).length) return text("Nothing to change — pass pages, autoPages, pageSize, orientation, docType or custom dimensions.");
      const meta = project.updateMeta({ settings: patch as never });
      const dims = pageDims(meta.settings);
      const pageClause = meta.settings.autoPages
        ? "page count AUTO — use as many pages as the content needs (the reviewer no longer enforces a fixed count)"
        : `EXACTLY ${meta.settings.pages} page(s)`;
      const fillClause = meta.settings.autoPages
        ? "let the content flow across as many pages as it needs (repeat the letterhead/header on each page)"
        : `restructure page.html to fill exactly ${meta.settings.pages} page(s)`;
      return text(
        `Format updated. The binding contract is now: ${meta.settings.docType} · ${meta.settings.pageSize} ${meta.settings.orientation} ` +
          `(${dims.w}mm × ${dims.h}mm), ${pageClause}. This supersedes the format in your ` +
          `system prompt. Compose as a ${meta.settings.docType}, update @page { size: ... } and ${fillClause}, then render and review.`,
      );
    },
  });

  // Shared executor for write_source / write_brand — same contract, different area.
  const writeDoc = (area: WorkspaceArea, path: string, markdown: string) => {
    try {
      const { path: rel, updated } = writeWorkspaceDoc(project.workspace, area, path, markdown);
      const selectionNote =
        area === "context" && project.selectedSources() !== null
          ? ` This project pins its sources in sources.json — add "${rel}" to its "context" array if this doc should inform THIS project too.`
          : "";
      return text(`${updated ? "Updated" : "Created"} ${area}/${rel}.${selectionNote}`);
    } catch (err) {
      return text(String(err instanceof Error ? err.message : err));
    }
  };

  const writeSource = defineTool({
    name: "write_source",
    label: "Write source doc",
    description:
      "Write a markdown doc into the WORKSPACE context/ library (shared source material that outlives this project). Use when the human asks to capture research — e.g. 'read this site and put the key info in sources': web_fetch first, then distill into ONE structured doc (headline facts, copy-ready bullets) citing the source URL and date at the top; never dump raw page text. Creates or updates; .md/.txt only; kebab-case filenames, subfolders ok (e.g. 'acme/product-facts.md').",
    promptSnippet: "write_source: distilled markdown -> workspace context/<path> (human-requested curation)",
    parameters: Type.Object({
      path: Type.String({ description: "path relative to context/, e.g. 'acme/product-facts.md'" }),
      markdown: Type.String({ description: "the full doc content (markdown)" }),
    }),
    async execute(_id, params) {
      return writeDoc("context", params.path, params.markdown);
    },
  });

  const writeBrand = defineTool({
    name: "write_brand",
    label: "Write brand doc",
    description:
      "Author or update a brand guideline doc in the WORKSPACE brand/ dir (applies to EVERY project). Use when the human asks to write down the brand: voice & tone, palette (exact hexes), typography, logo usage, do/don'ts. Ground it in real evidence (brand/ assets, web_fetch mode=brand) — never invent an identity unprompted. .md/.txt only; binary assets (logos, fonts, photos) can never be overwritten from here.",
    promptSnippet: "write_brand: brand-guideline markdown -> workspace brand/<path> (human-requested curation)",
    parameters: Type.Object({
      path: Type.String({ description: "path relative to brand/, e.g. 'guidelines.md' or 'voice.md'" }),
      markdown: Type.String({ description: "the full doc content (markdown)" }),
    }),
    async execute(_id, params) {
      return writeDoc("brand", params.path, params.markdown);
    },
  });

  const organizeSources = defineTool({
    name: "organize_sources",
    label: "Organize sources",
    description:
      "Rename/move files in the WORKSPACE source library — within or between context/ and brand/ (any file kind, images included). Use when the human asks to tidy, rename, or restructure sources ('group the acme docs in a folder', 'that palette doc belongs in brand'). Both paths are area-prefixed, e.g. {from: 'context/notes.md', to: 'brand/voice.md'}. Never overwrites; all moves are checked before any file is touched.",
    promptSnippet: "organize_sources: moves[{from,to}] within/between context/ and brand/ (no overwrites)",
    parameters: Type.Object({
      moves: Type.Array(
        Type.Object({
          from: Type.String({ description: "existing file, area-prefixed: 'context/…' or 'brand/…'" }),
          to: Type.String({ description: "new area-prefixed path (must not exist)" }),
        }),
        { minItems: 1 },
      ),
    }),
    async execute(_id, params) {
      try {
        const moved = moveWorkspaceFiles(project.workspace, params.moves as SourceMove[]);
        return text(`Moved:\n${moved.join("\n")}`);
      } catch (err) {
        return text(String(err instanceof Error ? err.message : err));
      }
    },
  });

  return [render, review, genImages, useImage, genQr, webFetch, fetchImage, webSearch, setFormat, writeSource, writeBrand, organizeSources];
}
