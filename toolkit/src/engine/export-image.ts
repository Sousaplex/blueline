// Export the rendered proof as image(s). Rasterizes the canonical proof.pdf (faithful to the
// print output, unlike a screen screenshot) to PNG; converts to JPEG via the render backend when
// asked. One page → a single image; multiple pages → a zip of per-page images.
import { zipSync } from "fflate";
import type { RenderBackend } from "./render.ts";

async function rasterize(pdfPath: string): Promise<Buffer[]> {
  const { pdf } = await import("pdf-to-img");
  const doc = await pdf(pdfPath, { scale: 2 }); // 2× for crisp sharing
  const pages: Buffer[] = [];
  for await (const page of doc) pages.push(Buffer.from(page));
  return pages;
}

/** Convert PNG buffers to JPEG by re-encoding through the browser (no extra image dependency). */
async function toJpeg(backend: RenderBackend, pngs: Buffer[]): Promise<Buffer[]> {
  return backend.withPage(async (page) => {
    const out: Buffer[] = [];
    for (const png of pngs) {
      await page.setContent(
        `<body style="margin:0"><img id="i" style="display:block" src="data:image/png;base64,${png.toString("base64")}"></body>`,
      );
      out.push(await page.locator("#i").screenshot({ type: "jpeg", quality: 92 }));
    }
    return out;
  });
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "export";

export async function exportProofImages(
  pdfPath: string,
  format: "png" | "jpeg",
  backend: RenderBackend,
  baseName: string,
): Promise<{ filename: string; data: Uint8Array; contentType: string }> {
  let pages = await rasterize(pdfPath);
  if (!pages.length) throw new Error("No rendered proof to export — render the piece first.");
  if (format === "jpeg") pages = await toJpeg(backend, pages);
  const ext = format === "jpeg" ? "jpg" : "png";
  const name = slug(baseName);
  if (pages.length === 1) {
    return { filename: `${name}.${ext}`, data: new Uint8Array(pages[0]!), contentType: format === "jpeg" ? "image/jpeg" : "image/png" };
  }
  const files: Record<string, Uint8Array> = {};
  pages.forEach((p, i) => (files[`${name}-page-${i + 1}.${ext}`] = new Uint8Array(p)));
  return { filename: `${name}-pages.zip`, data: zipSync(files), contentType: "application/zip" };
}
