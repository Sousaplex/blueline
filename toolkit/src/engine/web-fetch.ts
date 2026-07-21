import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import type { PresscheckConfig } from "./config.ts";
import type { Project } from "./project.ts";
import type { RenderBackend } from "./render.ts";

export type FetchMode = "markdown" | "screenshot";

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

export async function fetchWeb(
  project: Project,
  backend: RenderBackend,
  config: PresscheckConfig,
  rawUrl: string,
  mode: FetchMode = "markdown",
): Promise<FetchResult> {
  const url = await assertSafeUrl(rawUrl);
  const hash = createHash("sha256").update(`${mode}:${url.href}`).digest("hex").slice(0, 16);
  const cachePath = join(project.fetchedDir, mode === "markdown" ? `${hash}.md` : `${hash}.png`);

  if (existsSync(cachePath)) {
    return {
      mode,
      value: mode === "markdown" ? readFileSync(cachePath, "utf8") : cachePath,
      cached: true,
    };
  }

  consumeBudget(project, config.webFetch.maxFetchesPerRun);

  if (mode === "screenshot") {
    await backend.screenshot(url.href, cachePath);
    return { mode, value: cachePath, cached: false };
  }

  const html = await backend.withPage(async (page) => {
    await page.goto(url.href, { waitUntil: "networkidle", timeout: 15_000 });
    return page.content();
  });
  const md = htmlToMarkdown(html, url.href, config.webFetch.maxContentChars);
  writeFileSync(cachePath, md);
  return { mode, value: md, cached: false };
}
