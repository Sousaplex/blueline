import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import type { BluelineConfig } from "./config.ts";
import type { Project } from "./project.ts";
import type { RenderBackend } from "./render.ts";

export type FetchMode = "markdown" | "screenshot" | "brand";

export interface FetchResult {
  mode: FetchMode;
  /** markdown text, or the saved screenshot path */
  value: string;
  cached: boolean;
}

function isPrivateAddress(addr: string): boolean {
  return (
    /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(addr) ||
    addr === "::1" ||
    /^f[cd]/i.test(addr) || // fc00::/7 unique local
    /^fe80/i.test(addr)     // link-local
  );
}

async function assertSafeUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid URL: ${raw}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Only http(s) URLs are allowed, got ${url.protocol}`);
  }
  if (url.hostname === "localhost" || url.hostname.endsWith(".local")) {
    throw new Error(`Refusing to fetch local address: ${url.hostname}`);
  }
  const addrs = isIP(url.hostname)
    ? [{ address: url.hostname }]
    : await lookup(url.hostname, { all: true }).catch(() => {
        throw new Error(`Could not resolve host: ${url.hostname}`);
      });
  for (const { address } of addrs) {
    if (isPrivateAddress(address)) throw new Error(`Refusing to fetch private/internal address: ${url.hostname}`);
  }
  return url;
}

function budgetFile(project: Project): string {
  return join(project.fetchedDir, ".budget.json");
}

function consumeBudget(project: Project, max: number): void {
  const file = budgetFile(project);
  const used: number = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).used : 0;
  if (used >= max) {
    throw new Error(`Web fetch budget exhausted (${max} per run). Work with what you have already fetched.`);
  }
  writeFileSync(file, JSON.stringify({ used: used + 1 }));
}

export function resetFetchBudget(project: Project): void {
  writeFileSync(budgetFile(project), JSON.stringify({ used: 0 }));
}

function htmlToMarkdown(html: string, baseUrl: string, cap: number): string {
  // linkedom gives us a DOM; Readability extracts the article; Turndown converts to md.
  // Imported lazily — these are only needed in markdown mode.
  const { parseHTML } = require_("linkedom");
  const { Readability } = require_("@mozilla/readability");
  const TurndownService = require_("turndown");
  const { document } = parseHTML(html, { location: { href: baseUrl } });
  const article = new Readability(document, { charThreshold: 100 }).parse();
  const source = article?.content ?? html;
  const turndown = new (TurndownService.default ?? TurndownService)({ headingStyle: "atx" });
  const md: string = turndown.turndown(source);
  const titled = article?.title ? `# ${article.title}\n\n${md}` : md;
  return titled.length > cap ? `${titled.slice(0, cap)}\n\n[truncated at ${cap} chars]` : titled;
}

// CJS/ESM interop shim for deps with mixed module formats.
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);

function rgbToHex(rgb: string): string | null {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(rgb);
  if (!m) return null;
  if (m[4] !== undefined && Number(m[4]) === 0) return null;
  return "#" + [m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, "0")).join("");
}

/** Extract the visual identity of a page: palette, fonts, logo, plus a screenshot. */
async function extractBrand(
  project: Project,
  backend: RenderBackend,
  url: URL,
  screenshotPath: string,
): Promise<string> {
  const raw = await backend.withPage(async (page) => {
    await page.goto(url.href, { waitUntil: "networkidle", timeout: 20_000 });
    const data = await page.evaluate(() => {
      const colorCount = new Map<string, number>();
      const fontCount = new Map<string, number>();
      const sample = [...document.querySelectorAll("body *")].slice(0, 1000);
      for (const el of sample) {
        const cs = getComputedStyle(el);
        for (const c of [cs.color, cs.backgroundColor, cs.borderTopColor]) {
          if (c && c !== "rgba(0, 0, 0, 0)" && c !== "transparent") {
            colorCount.set(c, (colorCount.get(c) ?? 0) + 1);
          }
        }
        if (cs.fontFamily) fontCount.set(cs.fontFamily, (fontCount.get(cs.fontFamily) ?? 0) + 1);
      }
      const logoEl = document.querySelector<HTMLImageElement>(
        'img[src*="logo" i], img[alt*="logo" i], img[class*="logo" i], header img, nav img',
      );
      return {
        title: document.title,
        colors: [...colorCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 16),
        fonts: [...fontCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([f]) => f),
        logo: logoEl?.src ?? null,
        ogImage: document.querySelector<HTMLMetaElement>('meta[property="og:image"]')?.content ?? null,
        themeColor: document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content ?? null,
      };
    });
    await page.screenshot({ path: screenshotPath, fullPage: false });
    return data;
  });

  const palette = raw.colors
    .map(([c, n]) => ({ hex: rgbToHex(c), n }))
    .filter((e): e is { hex: string; n: number } => !!e.hex)
    .filter((e, i, arr) => arr.findIndex((x) => x.hex === e.hex) === i)
    .slice(0, 10);

  return [
    `# Visual identity: ${raw.title} (${url.hostname})`,
    "",
    `Dominant palette (by computed-style frequency):`,
    ...palette.map((p) => `- ${p.hex}  (weight ${p.n})`),
    "",
    `Font stacks: ${raw.fonts.join(" | ") || "(none detected)"}`,
    raw.themeColor ? `Theme color: ${raw.themeColor}` : "",
    raw.logo ? `Logo image: ${raw.logo} (web_fetch mode=screenshot it, or reference its style)` : "Logo: not detected",
    raw.ogImage ? `Social/og image: ${raw.ogImage}` : "",
    "",
    `Homepage screenshot saved to: ${screenshotPath} — use the read tool to view it for layout/mood.`,
  ]
    .filter(Boolean)
    .join("\n");
}

export async function fetchWeb(
  project: Project,
  backend: RenderBackend,
  config: BluelineConfig,
  rawUrl: string,
  mode: FetchMode = "markdown",
): Promise<FetchResult> {
  const url = await assertSafeUrl(rawUrl);
  const hash = createHash("sha256").update(`${mode}:${url.href}`).digest("hex").slice(0, 16);
  const cachePath = join(project.fetchedDir, mode === "screenshot" ? `${hash}.png` : `${hash}.md`);

  if (existsSync(cachePath)) {
    return {
      mode,
      value: mode === "screenshot" ? cachePath : readFileSync(cachePath, "utf8"),
      cached: true,
    };
  }

  consumeBudget(project, config.webFetch.maxFetchesPerRun);

  if (mode === "screenshot") {
    await backend.screenshot(url.href, cachePath);
    return { mode, value: cachePath, cached: false };
  }

  if (mode === "brand") {
    const report = await extractBrand(project, backend, url, join(project.fetchedDir, `${hash}-home.png`));
    writeFileSync(cachePath, report);
    return { mode, value: report, cached: false };
  }

  const html = await backend.withPage(async (page) => {
    await page.goto(url.href, { waitUntil: "networkidle", timeout: 15_000 });
    return page.content();
  });
  const md = htmlToMarkdown(html, url.href, config.webFetch.maxContentChars);
  writeFileSync(cachePath, md);
  return { mode, value: md, cached: false };
}
