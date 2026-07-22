// What is currently selected in Live edit — drives the contextual Inspector.
export type SelectionInfo =
  | {
      kind: "text" | "block" | "image";
      id: string; // data-pc-id (text/block) or data-image-id (image)
      tag?: string; // element tag name, e.g. H1, SECTION
      text?: string; // current text content (text kind)
      styles?: Record<string, string>; // computed subset: fontSize, fontWeight, color, lineHeight…
      nudge?: { x: number; y: number; marginTop: number | null }; // block kind, mm
    }
  | {
      kind: "multi";
      ids: string[]; // every selected data-pc-id, primary first
    };

/** Alignment operations the Inspector can run on the selection (Figma-style).
 *  One element aligns to the page; two or more align within the selection box. */
export type AlignOp = "left" | "centerH" | "right" | "top" | "centerV" | "bottom" | "distH" | "distV";
