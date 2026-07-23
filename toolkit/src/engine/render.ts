import type { Browser } from "playwright";

export interface RenderOptions {
  printBackground?: boolean;
  preferCSSPageSize?: boolean;
}

/** One implementation per host: Playwright (CLI/dev), Electron printToPDF (app, M3). */
export interface RenderBackend {
  renderPdf(htmlPath: string, outPath: string, opts?: RenderOptions): Promise<void>;
  screenshot(url: string, outPath: string): Promise<void>;
  /** Expose a page for web-fetch to reuse the same browser. */
  withPage<T>(fn: (page: import("playwright").Page) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export class PlaywrightBackend implements RenderBackend {
  private browser?: Browser;

  private async ensureBrowser(): Promise<Browser> {
    if (!this.browser) {
      const { chromium } = await import("playwright");
      this.browser = await chromium.launch();
    }
    return this.browser;
  }

  async withPage<T>(fn: (page: import("playwright").Page) => Promise<T>): Promise<T> {
    const browser = await this.ensureBrowser();
    const page = await browser.newPage();
    try {
      return await fn(page);
    } finally {
      await page.close();
    }
  }

  async renderPdf(htmlPath: string, outPath: string, opts: RenderOptions = {}): Promise<void> {
    await this.withPage(async (page) => {
      await page.goto(`file://${htmlPath}`, { waitUntil: "networkidle" });
      // `networkidle` fires ~500ms after load but does NOT wait for image *decoding*.
      // webp decodes lazily/heavier than png, so the print snapshot is frequently taken
      // before it's ready → the image drops out of the PDF (but shows in the on-screen
      // live iframe, which paints lazily). Force every image to finish decoding, and
      // fonts to load, before printing. Passed as a STRING so tsx's transpile can't
      // inject its __name helper into the serialized function (ReferenceError in-page).
      await page.evaluate(`(async () => {
        await Promise.all(Array.from(document.images).map((img) => img.decode().catch(() => {})));
        if (document.fonts && document.fonts.ready) await document.fonts.ready;
      })()`);
      await page.pdf({
        path: outPath,
        printBackground: opts.printBackground ?? true,
        preferCSSPageSize: opts.preferCSSPageSize ?? true,
      });
    });
  }

  async screenshot(url: string, outPath: string): Promise<void> {
    await this.withPage(async (page) => {
      await page.goto(url, { waitUntil: "networkidle", timeout: 15_000 });
      await page.screenshot({ path: outPath, fullPage: true });
    });
  }

  async close(): Promise<void> {
    await this.browser?.close();
    this.browser = undefined;
  }
}
