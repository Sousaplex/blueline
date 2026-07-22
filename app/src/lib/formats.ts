// Artboard formats shared by the New-project dialog and the Document section.
// Mirrors toolkit/src/engine/project.ts PAGE_DIMS — keep the two in sync.
export const PAGE_SIZES = ["A4", "A5", "A3", "Letter", "Legal", "Tabloid", "Slide 16:9", "Slide 4:3", "Square", "Custom"];

export const PAGE_DIMS: Record<string, { w: number; h: number }> = {
  A4: { w: 210, h: 297 },
  A5: { w: 148, h: 210 },
  A3: { w: 297, h: 420 },
  Letter: { w: 215.9, h: 279.4 },
  Legal: { w: 215.9, h: 355.6 },
  Tabloid: { w: 279.4, h: 431.8 },
  "Slide 16:9": { w: 338.7, h: 190.5 },
  "Slide 4:3": { w: 254, h: 190.5 },
  Square: { w: 210, h: 210 },
};

/** Resolved artboard in mm for the creation-dialog hint (engine recomputes authoritatively). */
export function previewDims(
  pageSize: string,
  orientation: "portrait" | "landscape",
  widthMm?: number | null,
  heightMm?: number | null,
): { w: number; h: number } {
  const base = pageSize === "Custom" && widthMm && heightMm ? { w: widthMm, h: heightMm } : (PAGE_DIMS[pageSize] ?? PAGE_DIMS.A4);
  if (pageSize === "Custom") return base;
  const landscape = orientation === "landscape";
  return (landscape && base.w < base.h) || (!landscape && base.w > base.h) ? { w: base.h, h: base.w } : base;
}
