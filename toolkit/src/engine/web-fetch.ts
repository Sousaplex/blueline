import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, join } from "node:path";
import type { BluelineConfig } from "./config.ts";
import { safeRelPath, type Project } from "./project.ts";
import type { RenderBackend } from "./render.ts";

export type FetchMode = "markdown" | "screenshot" | "brand" | "crawl";

/** Modest crawl: the entry page + a few short-path same-domain pages (about/pricing/etc.). */
const CRAWL_MAX_PAGES = 4;

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

/** Re-validate EVERY navigation (initial load AND each redirect hop) against the SSRF rules.
 *  assertSafeUrl is otherwise only a pre-flight check, so a public URL that 3xx-redirects to
 *  169.254.169.254 or 127.0.0.1 would slip through — Playwright re-resolves DNS and follows it.
 *  Subresources (images/css) are left alone: their bytes never reach the agent as content. */
async function guardNavigations(page: any): Promise<void> {
  await page.route("**/*", async (route: any) => {
    const req = route.request();
    if (!req.isNavigationRequest()) return route.continue();
    try {
      await assertSafeUrl(req.url());
      return route.continue();
    } catch {
      return route.abort("blockedbyclient");
    }
  });
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

/** Same-domain links from a page, shortest-path first (nav pages before deep ones), assets
 *  and off-domain links dropped. Used by crawl mode to pick which pages to follow. */
function sameDomainLinks(html: string, base: URL): string[] {
  const { parseHTML } = require_("linkedom");
  const { document } = parseHTML(html, { location: { href: base.href } });
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of [...document.querySelectorAll("a[href]")] as any[]) {
    let u: URL;
    try {
      u = new URL(a.getAttribute("href"), base.href);
    } catch {
      continue;
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") continue;
    if (u.hostname !== base.hostname) continue;
    u.hash = "";
    if (/\.(pdf|png|jpe?g|gif|svg|webp|zip|mp4|css|js|ico|woff2?|xml|rss)($|\?)/i.test(u.pathname)) continue;
    if (u.href === base.href || seen.has(u.href)) continue;
    seen.add(u.href);
    out.push(u.href);
  }
  return out.sort((a, b) => a.length - b.length);
}

async function fetchPageMarkdown(backend: RenderBackend, url: URL, cap: number): Promise<string> {
  const html = await backend.withPage(async (page) => {
    await guardNavigations(page);
    await page.goto(url.href, { waitUntil: "networkidle", timeout: 15_000 });
    return page.content();
  });
  return htmlToMarkdown(html, url.href, cap);
}

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
    await guardNavigations(page);
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
    raw.logo
      ? `Logo image URL: ${raw.logo}\n  → DOWNLOAD the real logo: fetch_image({ url: "${raw.logo}", into: "brand" }), then use_image it. Do NOT gen_images a logo.`
      : "Logo: not detected",
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
    // Guarded page (redirect-safe) rather than backend.screenshot, which does its own goto.
    await backend.withPage(async (page) => {
      await guardNavigations(page);
      await page.goto(url.href, { waitUntil: "networkidle", timeout: 15_000 });
      await page.screenshot({ path: cachePath, fullPage: true });
    });
    return { mode, value: cachePath, cached: false };
  }

  if (mode === "brand") {
    const report = await extractBrand(project, backend, url, join(project.fetchedDir, `${hash}-home.png`));
    writeFileSync(cachePath, report);
    return { mode, value: report, cached: false };
  }

  if (mode === "crawl") {
    // Entry page + up to CRAWL_MAX_PAGES-1 short-path same-domain pages, each budgeted and
    // re-validated through assertSafeUrl. Per-page cap is halved so the combined doc stays
    // manageable. Stops early when the per-run fetch budget is exhausted.
    const perCap = Math.max(2000, Math.floor(config.webFetch.maxContentChars / 2));
    consumeBudget(project, config.webFetch.maxFetchesPerRun);
    const entryHtml = await backend.withPage(async (page) => {
      await guardNavigations(page);
      await page.goto(url.href, { waitUntil: "networkidle", timeout: 15_000 });
      return page.content();
    });
    const parts = [`# Crawl of ${url.hostname}`, `\n## ${url.href}\n\n${htmlToMarkdown(entryHtml, url.href, perCap)}`];
    const followed: string[] = [];
    for (const link of sameDomainLinks(entryHtml, url).slice(0, CRAWL_MAX_PAGES - 1)) {
      try {
        const lu = await assertSafeUrl(link);
        consumeBudget(project, config.webFetch.maxFetchesPerRun);
        parts.push(`\n## ${lu.href}\n\n${await fetchPageMarkdown(backend, lu, perCap)}`);
        followed.push(lu.href);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/budget/.test(msg)) break; // out of fetches — stop, keep what we have
        parts.push(`\n## ${link}\n\n[skipped: ${msg}]`);
      }
    }
    const combined = `${parts.join("\n")}\n\n---\n_Crawled ${followed.length + 1} page(s) on ${url.hostname}._`;
    writeFileSync(cachePath, combined);
    return { mode, value: combined, cached: false };
  }

  const html = await backend.withPage(async (page) => {
    await guardNavigations(page);
    await page.goto(url.href, { waitUntil: "networkidle", timeout: 15_000 });
    return page.content();
  });
  const md = htmlToMarkdown(html, url.href, config.webFetch.maxContentChars);
  writeFileSync(cachePath, md);
  return { mode, value: md, cached: false };
}

const IMAGE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "image/avif": "avif",
};
const MAX_ASSET_BYTES = 20 * 1024 * 1024;

export interface AssetResult {
  /** Path relative to the destination area root (brand/ or context/). */
  path: string;
  bytes: number;
  contentType: string;
}

/**
 * Download a real image asset (logo, product photo) from a URL into the workspace — brand/ for
 * logos, context/ for photography — so the agent can PLACE the real image via use_image instead
 * of generating a fake one. Goes through the guarded backend page (same SSRF re-validation on
 * every redirect hop as the other fetch modes), verifies the response is actually an image, and
 * caps the size. Returns the saved relative path.
 */
export async function fetchAsset(
  project: Project,
  backend: RenderBackend,
  config: BluelineConfig,
  rawUrl: string,
  into: "brand" | "context",
  relPath?: string,
): Promise<AssetResult> {
  const url = await assertSafeUrl(rawUrl);
  consumeBudget(project, config.webFetch.maxFetchesPerRun);

  const { buf, contentType } = await backend.withPage(async (page) => {
    await guardNavigations(page); // re-checks every redirect hop against the SSRF rules
    const resp = await page.goto(url.href, { waitUntil: "commit", timeout: 20_000 });
    if (!resp) throw new Error(`No response from ${url.href}`);
    if (!resp.ok()) throw new Error(`Fetch failed: HTTP ${resp.status()} for ${url.href}`);
    const contentType = (resp.headers()["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    const body = await resp.body();
    return { buf: body, contentType };
  });

  const ext = IMAGE_EXT[contentType];
  if (!ext) {
    throw new Error(
      `That URL is not an image (content-type: ${contentType || "unknown"}). fetch_image only downloads ` +
        `images (png/jpeg/webp/gif/svg). For a page's text use web_fetch mode=markdown.`,
    );
  }
  if (buf.length > MAX_ASSET_BYTES) {
    throw new Error(`Image is too large (${(buf.length / 1e6).toFixed(1)}MB, limit 20MB).`);
  }

  // Name it from the caller's path or the URL basename; force a correct image extension.
  let name = (relPath && relPath.trim()) || decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() || "asset");
  if (!/\.(png|jpe?g|webp|gif|svg|avif)$/i.test(name)) name = `${name.replace(/\.[^./]*$/, "")}.${ext}`;
  const rel = safeRelPath(name); // throws on traversal / absolute paths
  const dir = into === "brand" ? project.workspace.brandDir : project.workspace.contextDir;
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, buf);
  return { path: rel, bytes: buf.length, contentType };
}
