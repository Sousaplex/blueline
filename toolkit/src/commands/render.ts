// render: projects/<slug>/page.html -> projects/<slug>/out/proof.pdf
// Headless Chromium print via Playwright. This is the one fully deterministic
// step in the loop — no model calls.
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const projectDir = process.argv[2];
if (!projectDir) throw new Error("usage: npm run render -- projects/<slug>");

const dir = resolve(process.cwd(), "..", projectDir);
await mkdir(`${dir}/out`, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`file://${dir}/page.html`, { waitUntil: "networkidle" });
await page.pdf({
  path: `${dir}/out/proof.pdf`,
  printBackground: true,
  preferCSSPageSize: true,
});
await browser.close();
console.log(`wrote ${dir}/out/proof.pdf`);
