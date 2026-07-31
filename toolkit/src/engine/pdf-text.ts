// PDF text extraction for the agent. A PDF source read raw is binary garbage — so the agent used
// to embed the bytes and try to parse them in the page (which fails). Instead we extract the text
// to a plain `<name>.txt` sidecar the agent can actually read and design from.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Extract the text of a PDF (all pages) using pdfjs. Returns "" on failure — never throws. */
export async function extractPdfText(absPath: string): Promise<string> {
  try {
    const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const data = new Uint8Array(readFileSync(absPath));
    const doc = await pdfjs.getDocument({ data, useSystemFonts: true, isEvalSupported: false }).promise;
    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      pages.push(content.items.map((it: any) => ("str" in it ? it.str : "")).join(" "));
    }
    await doc.destroy();
    return pages.join("\n\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  } catch {
    return "";
  }
}

/**
 * For every `*.pdf` in `dir`, ensure a fresh `*.pdf.txt` sidecar with the extracted text exists, so
 * the agent reads the text instead of the raw file. Idempotent; re-extracts only when the PDF is
 * newer than its sidecar. Returns the sidecar paths written.
 */
export async function ensurePdfSidecars(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const written: string[] = [];
  const walk = (d: string): string[] =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) => {
      const p = join(d, e.name);
      if (e.isDirectory()) return walk(p);
      return e.isFile() && /\.pdf$/i.test(e.name) ? [p] : [];
    });
  for (const pdf of walk(dir)) {
    const txt = `${pdf}.txt`;
    const fresh = existsSync(txt) && statSync(txt).mtimeMs >= statSync(pdf).mtimeMs;
    if (fresh) continue;
    const text = await extractPdfText(pdf);
    writeFileSync(txt, text || "(no extractable text — this PDF may be scanned images)\n");
    written.push(txt);
  }
  return written;
}
