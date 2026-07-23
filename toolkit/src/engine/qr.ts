// QR-code generation for the design agent. Writes into the project's image slots so
// the piece can embed a scannable code (URL, text, vCard). SVG by default — vector
// scales crisply for print; PNG available when a raster is needed.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import QRCode from "qrcode";
import { safeRelPath, type Project } from "./project.ts";

export interface QrOptions {
  id: string;
  data: string;
  format?: "svg" | "png";
  size?: number; // px, PNG only
  margin?: number; // quiet-zone modules
  ecc?: "L" | "M" | "Q" | "H"; // error correction
}

/** Generate a QR file into images/<id>/ and return its project-relative path. */
export async function generateQr(project: Project, opts: QrOptions): Promise<string> {
  const slot = safeRelPath(opts.id).replace(/\//g, "-");
  const destDir = join(project.imagesDir, slot);
  mkdirSync(destDir, { recursive: true });
  const format = opts.format === "png" ? "png" : "svg";
  const errorCorrectionLevel = opts.ecc ?? "M";
  const margin = Math.max(0, Math.min(8, opts.margin ?? 2));
  const destRel = `images/${slot}/qr.${format}`;
  const dest = join(project.dir, destRel);
  if (format === "svg") {
    writeFileSync(dest, await QRCode.toString(opts.data, { type: "svg", errorCorrectionLevel, margin }));
  } else {
    await QRCode.toFile(dest, opts.data, { width: Math.max(64, Math.min(2048, opts.size ?? 512)), errorCorrectionLevel, margin });
  }
  return destRel;
}
