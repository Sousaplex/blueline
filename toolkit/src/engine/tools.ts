import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { BluelineConfig } from "./config.ts";
import { generateImages } from "./images.ts";
import type { Project } from "./project.ts";
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

  return [render, review, genImages, webFetch, webSearch];
}
