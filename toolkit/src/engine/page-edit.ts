// Structured edits to page.html driven by the viewer: inline copy changes
// (data-pc-id) and image variant selection (data-image-id). Uses linkedom so
// edits survive round-trips without hand-rolled regex surgery.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseHTML } from "linkedom";
import type { Project } from "./project.ts";

export interface EditableText {
  pcId: string;
  text: string;
}

export interface ImageSlot {
  id: string;
  variants: number[];
  current: number | null;
}

function loadDom(project: Project) {
  if (!existsSync(project.pageHtml)) throw new Error("page.html does not exist yet");
  const html = readFileSync(project.pageHtml, "utf8");
  return { html, dom: parseHTML(html) };
}

function save(project: Project, document: any): void {
  writeFileSync(project.pageHtml, String(document));
}

export function listEditable(project: Project): EditableText[] {
  if (!existsSync(project.pageHtml)) return [];
  const { dom } = loadDom(project);
  return [...dom.document.querySelectorAll("[data-pc-id]")].map((el: any) => ({
    pcId: el.getAttribute("data-pc-id"),
    text: el.textContent?.trim() ?? "",
  }));
}

export function updateCopy(project: Project, pcId: string, text: string): void {
  const { dom } = loadDom(project);
  const el = dom.document.querySelector(`[data-pc-id="${pcId}"]`);
  if (!el) throw new Error(`No element with data-pc-id="${pcId}"`);
  el.textContent = text;
  save(project, dom.document);
}

export function listImageSlots(project: Project): ImageSlot[] {
  const slots: ImageSlot[] = [];
  const domInfo = existsSync(project.pageHtml) ? loadDom(project) : undefined;
  if (!existsSync(project.imagesDir)) return slots;
  for (const entry of readdirSync(project.imagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const variants = readdirSync(join(project.imagesDir, entry.name))
      .map((f) => /^v(\d+)\.png$/.exec(f)?.[1])
      .filter(Boolean)
      .map(Number)
      .sort((a, b) => a - b);
    if (!variants.length) continue;
    let current: number | null = null;
    if (domInfo) {
      const img = domInfo.dom.document.querySelector(`img[data-image-id="${entry.name}"]`);
      const m = img && /v(\d+)\.png$/.exec(img.getAttribute("src") ?? "");
      current = m ? Number(m[1]) : null;
    }
    slots.push({ id: entry.name, variants, current });
  }
  return slots;
}

function mergeStyle(el: any, apply: (existing: Map<string, string>) => void): void {
  const existing = new Map<string, string>(
    (el.getAttribute("style") ?? "")
      .split(";")
      .map((s: string) => s.trim())
      .filter(Boolean)
      .map((s: string) => [s.slice(0, s.indexOf(":")).trim(), s.slice(s.indexOf(":") + 1).trim()] as [string, string]),
  );
  apply(existing);
  const css = [...existing.entries()].map(([k, v]) => `${k}: ${v}`).join("; ");
  if (css) el.setAttribute("style", css);
  else el.removeAttribute("style");
}

const NUDGE_LIMIT_MM = 150;

/** Nudge a layout block: translate offset (doesn't reflow siblings) and/or top margin. */
export function setElementStyle(
  project: Project,
  pcId: string,
  style: { translateX?: number; translateY?: number; marginTop?: number | null },
): void {
  const { dom } = loadDom(project);
  const el = dom.document.querySelector(`[data-pc-id="${pcId}"]`);
  if (!el) throw new Error(`No element with data-pc-id="${pcId}"`);
  mergeStyle(el, (existing) => {
    if (style.translateX !== undefined || style.translateY !== undefined) {
      const clamp = (v: number) => Math.max(-NUDGE_LIMIT_MM, Math.min(NUDGE_LIMIT_MM, Number(v) || 0));
      const x = clamp(style.translateX ?? 0);
      const y = clamp(style.translateY ?? 0);
      if (x === 0 && y === 0) existing.delete("transform");
      else existing.set("transform", `translate(${x.toFixed(1)}mm, ${y.toFixed(1)}mm)`);
    }
    if (style.marginTop !== undefined) {
      if (style.marginTop === null) existing.delete("margin-top");
      else {
        const m = Math.max(-50, Math.min(NUDGE_LIMIT_MM, Number(style.marginTop) || 0));
        existing.set("margin-top", `${m.toFixed(1)}mm`);
      }
    }
  });
  save(project, dom.document);
}

/** Current inline nudge state for an element (so the UI resumes from persisted values). */
export function getElementStyle(project: Project, pcId: string): { translateX: number; translateY: number; marginTop: number | null } {
  const { dom } = loadDom(project);
  const el = dom.document.querySelector(`[data-pc-id="${pcId}"]`);
  if (!el) throw new Error(`No element with data-pc-id="${pcId}"`);
  const styleAttr = el.getAttribute("style") ?? "";
  const t = /translate\((-?[\d.]+)mm,\s*(-?[\d.]+)mm\)/.exec(styleAttr);
  const m = /margin-top:\s*(-?[\d.]+)mm/.exec(styleAttr);
  return {
    translateX: t ? Number(t[1]) : 0,
    translateY: t ? Number(t[2]) : 0,
    marginTop: m ? Number(m[1]) : null,
  };
}

/** Persist pan/zoom for an image: object-position + scale, keeping object-fit cover. */
export function setImageStyle(
  project: Project,
  imageId: string,
  style: { objectPosition?: string; zoom?: number },
): void {
  const { dom } = loadDom(project);
  const img = dom.document.querySelector(`img[data-image-id="${imageId}"]`);
  if (!img) throw new Error(`page.html has no <img data-image-id="${imageId}">`);
  const existing = new Map<string, string>(
    (img.getAttribute("style") ?? "")
      .split(";")
      .map((s: string) => s.trim())
      .filter(Boolean)
      .map((s: string) => [s.slice(0, s.indexOf(":")).trim(), s.slice(s.indexOf(":") + 1).trim()] as [string, string]),
  );
  existing.set("object-fit", "cover");
  if (style.objectPosition) {
    if (!/^[\d.]+%\s+[\d.]+%$/.test(style.objectPosition)) throw new Error("objectPosition must be 'X% Y%'");
    existing.set("object-position", style.objectPosition);
  }
  if (style.zoom !== undefined) {
    const z = Math.min(Math.max(Number(style.zoom), 1), 3);
    if (z === 1) existing.delete("transform");
    else existing.set("transform", `scale(${z.toFixed(2)})`);
  }
  img.setAttribute("style", [...existing.entries()].map(([k, v]) => `${k}: ${v}`).join("; "));
  save(project, dom.document);
}

export function selectVariant(project: Project, imageId: string, variant: number): void {
  const file = join(project.imagesDir, imageId, `v${variant}.png`);
  if (!existsSync(file)) throw new Error(`No such variant: ${imageId}/v${variant}.png`);
  const { dom } = loadDom(project);
  const img = dom.document.querySelector(`img[data-image-id="${imageId}"]`);
  if (!img) throw new Error(`page.html has no <img data-image-id="${imageId}">`);
  img.setAttribute("src", `images/${imageId}/v${variant}.png`);
  save(project, dom.document);
}
