import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { BluelineConfig } from "./config.ts";
import { generateImages } from "./images.ts";
import { pageDims, safeRelPath, type Project } from "./project.ts";
import { generateQr } from "./qr.ts";
import type { RenderBackend } from "./render.ts";
import { RoundLimitError, runReview } from "./review.ts";
import { runWebSearch } from "./search.ts";
import { fetchWeb } from "./web-fetch.ts";

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
      "Fetch a public web page. mode=markdown returns readable page text; mode=brand extracts the visual identity (color palette, fonts, logo, theme color + homepage screenshot) — ALWAYS use brand mode on a company's site before designing for them; mode=screenshot saves a full-page PNG.",
    promptSnippet: "web_fetch: url -> markdown | brand identity (palette/fonts/logo) | screenshot",
    parameters: Type.Object({
      url: Type.String({ description: "http(s) URL to fetch" }),
      mode: Type.Optional(
        Type.Union([Type.Literal("markdown"), Type.Literal("brand"), Type.Literal("screenshot")], {
          description: "markdown (default) for content, brand for visual identity, screenshot for a PNG",
        }),
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
      "Generate a QR code (URL, plain text, vCard) as a print-ready file placed in an image slot. Default SVG (crisp vector for print). Use when the brief calls for a scannable link/CTA.",
    promptSnippet: "gen_qr: data + id -> images/<id>/qr.svg (scannable code)",
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
      pages: Type.Optional(Type.Integer({ minimum: 1, maximum: 24, description: "new required page/slide count" })),
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
      for (const key of ["pages", "pageSize", "orientation", "docType", "widthMm", "heightMm"] as const) {
        if (params[key] !== undefined) patch[key] = params[key];
      }
      if (!Object.keys(patch).length) return text("Nothing to change — pass pages, pageSize, orientation, docType or custom dimensions.");
      const meta = project.updateMeta({ settings: patch as never });
      const dims = pageDims(meta.settings);
      return text(
        `Format updated. The binding contract is now: ${meta.settings.docType} · ${meta.settings.pageSize} ${meta.settings.orientation} ` +
          `(${dims.w}mm × ${dims.h}mm), EXACTLY ${meta.settings.pages} page(s). This supersedes the format in your ` +
          `system prompt. Compose as a ${meta.settings.docType}, update @page { size: ... } and restructure page.html to fill ` +
          `exactly ${meta.settings.pages} page(s), then render and review.`,
      );
    },
  });

  return [render, review, genImages, useImage, genQr, webFetch, webSearch, setFormat];
}
