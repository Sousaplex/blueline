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

/** Tags that are pure inline formatting — safe to lose when text is replaced. */
const INLINE_TAGS = new Set(["B", "I", "EM", "STRONG", "SPAN", "A", "BR", "SMALL", "SUP", "SUB", "CODE", "U", "MARK", "WBR", "TIME", "ABBR"]);

/** True if replacing this element's content with flat text would destroy page structure:
 *  any non-inline child element (h1-h6, p, div, li, …) or any tagged element inside. */
function isStructural(el: any): boolean {
  if (el.querySelector("[data-pc-id], [data-image-id], img")) return true;
  return [...el.children].some((child: any) => !INLINE_TAGS.has(String(child.tagName).toUpperCase()));
}

export function updateCopy(project: Project, pcId: string, text: string): void {
  const { dom } = loadDom(project);
  const el = dom.document.querySelector(`[data-pc-id="${pcId}"]`);
  if (!el) throw new Error(`No element with data-pc-id="${pcId}"`);
  // Guard: setting textContent on a container would obliterate every child element
  // (this once flattened an entire page when a click bubbled to the root container).
  if (isStructural(el)) {
    throw new Error(`"${pcId}" is a layout container — edit the text blocks inside it instead`);
  }
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

/** Give an untagged element a data-pc-id so the human editor can work with it.
 *  The element is addressed by a strict child-index path from <body> — the only
 *  selector grammar accepted here, so arbitrary CSS can't be smuggled in. */
export function tagElement(project: Project, cssPath: string, pcId: string): void {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(pcId)) throw new Error(`Invalid pc-id: ${pcId}`);
  if (!/^body(\s*>\s*\*:nth-child\(\d{1,3}\))+$/.test(cssPath)) throw new Error("Invalid element path");
  const { dom } = loadDom(project);
  if (dom.document.querySelector(`[data-pc-id="${pcId}"]`)) throw new Error(`pc-id "${pcId}" is already in use`);
  const el = dom.document.querySelector(cssPath);
  if (!el) throw new Error("No element at that path (page changed since it was picked?)");
  if (el.getAttribute("data-pc-id")) throw new Error("Element is already tagged");
  el.setAttribute("data-pc-id", pcId);
  save(project, dom.document);
}

/** Remove an element from the page entirely (viewer confirms before calling). */
export function deleteElement(project: Project, pcId: string): void {
  const { dom } = loadDom(project);
  const el = dom.document.querySelector(`[data-pc-id="${pcId}"]`);
  if (!el) throw new Error(`No element with data-pc-id="${pcId}"`);
  if (el.tagName === "BODY" || el.tagName === "HTML") throw new Error("Cannot delete the page root");
  el.remove();
  save(project, dom.document);
}

export type InsertKind = "text" | "heading" | "rect" | "divider";

/** Insert a new, freely-positioned element the generation didn't create, and return its
 *  data-pc-id so the editor can select it. It's appended (position:absolute) to the page
 *  root — which is anchored position:relative — so left/top mm are relative to the page in
 *  both the live preview and the print PDF. The human then drags/edits it like any element. */
export function insertElement(project: Project, kind: InsertKind, xMm = 15, yMm = 15): string {
  const { dom } = loadDom(project);
  const doc = dom.document;
  let n = 1;
  let id = `${kind}-${n}`;
  while (doc.querySelector(`[data-pc-id="${id}"]`)) id = `${kind}-${++n}`;
  const el: any = doc.createElement("div");
  el.setAttribute("data-pc-id", id);
  // z-index keeps the new element on TOP of existing content, and text/heading get a
  // translucent light chip so they're legible on ANY background (a dark #111 label on a
  // dark panel was invisible — read as "add didn't work"). The user restyles from there.
  // No forced rounded corners and no chip background: text is plain text, a rect is a real
  // sharp box. The user restyles (color, fill, corners) from the contextual property panel —
  // which is why these defaults are deliberately minimal.
  const base = `position:absolute;left:${xMm}mm;top:${yMm}mm;z-index:50;`;
  if (kind === "text") {
    el.setAttribute("style", `${base}font-size:11pt;line-height:1.4;color:#111827;width:80mm;`);
    el.textContent = "Text";
  } else if (kind === "heading") {
    el.setAttribute("style", `${base}font-size:22pt;font-weight:700;line-height:1.15;color:#111827;width:120mm;`);
    el.textContent = "Heading";
  } else if (kind === "rect") {
    el.setAttribute("style", `${base}width:40mm;height:25mm;background:#e5e7eb;border:1px solid #94a3b8;`);
  } else {
    // divider
    el.setAttribute("style", `${base}width:60mm;height:0;border-top:2px solid #64748b;`);
  }
  const root: any = doc.querySelector("[data-pc-id]") ?? doc.body;
  // Guarantee a positioning context so left/top are relative to the page root.
  if (root.tagName !== "BODY" && !/position\s*:/i.test(root.getAttribute("style") || "")) {
    root.setAttribute("style", `position:relative;${root.getAttribute("style") || ""}`);
  }
  root.appendChild(el);
  save(project, doc);
  return id;
}

/** Resolve a movable/deletable element by data-pc-id OR data-image-id (→ its slot/frame). */
function resolveElement(doc: any, id: string): any {
  const byPc = doc.querySelector(`[data-pc-id="${id}"]`);
  if (byPc) return byPc;
  const slot = doc.querySelector(`[data-img-slot="${id}"]`);
  if (slot) return slot;
  const img = doc.querySelector(`img[data-image-id="${id}"]`);
  if (!img) return null;
  // Walk up to a compiled slot wrapper; else use the img's immediate parent (crop frame).
  let cur: any = img;
  while (cur && cur.tagName !== "BODY") {
    if (cur.getAttribute?.("data-img-slot")) return cur;
    cur = cur.parentElement;
  }
  return img.parentElement && img.parentElement.children.length === 1 ? img.parentElement : img;
}

/** Delete an image (its compiled slot/frame/img block, or the bare img on legacy pages). */
export function deleteImage(project: Project, imageId: string): void {
  const { dom } = loadDom(project);
  const el = resolveElement(dom.document, imageId);
  if (!el) throw new Error(`No image with data-image-id="${imageId}"`);
  if (el.tagName === "BODY" || el.tagName === "HTML") throw new Error("Cannot delete the page root");
  el.remove();
  save(project, dom.document);
}

/** Swap an element with its previous/next sibling in document flow (works for images too). */
export function moveElement(project: Project, pcId: string, direction: "up" | "down"): void {
  const { dom } = loadDom(project);
  const el = resolveElement(dom.document, pcId);
  if (!el) throw new Error(`No element for id="${pcId}"`);
  const parent = el.parentElement;
  if (!parent) throw new Error("Element has no parent");
  const sibling = direction === "up" ? el.previousElementSibling : el.nextElementSibling;
  if (!sibling) return; // already at the edge — no-op
  if (direction === "up") parent.insertBefore(el, sibling);
  else parent.insertBefore(sibling, el);
  save(project, dom.document);
}

/** Reorder by drag: move `pcId` to sit before `beforePcId` (or append to that parent when after=true). */
export function moveElementBefore(project: Project, pcId: string, beforePcId: string, after = false): void {
  const { dom } = loadDom(project);
  const el = dom.document.querySelector(`[data-pc-id="${pcId}"]`);
  const target = dom.document.querySelector(`[data-pc-id="${beforePcId}"]`);
  if (!el) throw new Error(`No element with data-pc-id="${pcId}"`);
  if (!target) throw new Error(`No element with data-pc-id="${beforePcId}"`);
  if (el === target || el.contains(target)) throw new Error("Cannot move an element into itself");
  const parent = target.parentElement;
  if (!parent) throw new Error("Target has no parent");
  parent.insertBefore(el, after ? target.nextSibling : target);
  save(project, dom.document);
}

/** Raw page source for the Code view. */
export function pageSource(project: Project): string {
  if (!existsSync(project.pageHtml)) throw new Error("page.html does not exist yet");
  return readFileSync(project.pageHtml, "utf8");
}

/** Replace page.html from the Code view — sanity-checked, not schema-validated. */
export function writePageSource(project: Project, html: string): void {
  const s = String(html);
  if (s.length < 100 || !/<body[\s>]/i.test(s) || !/<\/html>/i.test(s)) {
    throw new Error("That does not look like a complete HTML document (needs <body> and </html>)");
  }
  writeFileSync(project.pageHtml, s);
}

const FRAME_MIN_MM = 5;
const FRAME_MAX_MM = 400;


/** CSS properties the human property panel may set inline on an element (safe subset). */
const PROP_WHITELIST = new Set([
  "font-size",
  "font-family",
  "font-weight",
  "font-style",
  "color",
  "text-align",
  "text-transform",
  "line-height",
  "letter-spacing",
  "background",
  "background-color",
  "border",
  "border-width",
  "border-style",
  "border-color",
  "border-radius",
  "width",
  "height",
  "padding",
  "opacity",
]);

/** A CSS value is safe if it can't break out of the style attribute or smuggle a URL. */
function safeCssValue(v: string): boolean {
  return !/[;{}<>]/.test(v) && !/url\s*\(/i.test(v) && !/expression\s*\(/i.test(v) && v.length <= 120;
}

/**
 * Set whitelisted inline style properties on a tagged element (the contextual property
 * panel: font, color, weight, align, background, border, corners, width…). An empty-string
 * value removes that property (revert to the stylesheet default).
 */
export function setElementProps(project: Project, pcId: string, props: Record<string, string>): void {
  const { dom } = loadDom(project);
  const el = dom.document.querySelector(`[data-pc-id="${pcId}"]`);
  if (!el) throw new Error(`No element with data-pc-id="${pcId}"`);
  mergeStyle(el, (existing) => {
    for (const [rawKey, rawVal] of Object.entries(props)) {
      const key = rawKey.trim().toLowerCase();
      if (!PROP_WHITELIST.has(key)) throw new Error(`Property not allowed: ${key}`);
      const val = String(rawVal).trim();
      if (!val) {
        existing.delete(key);
        continue;
      }
      if (!safeCssValue(val)) throw new Error(`Unsafe value for ${key}`);
      existing.set(key, val);
    }
  });
  save(project, dom.document);
}

export interface ImageGeometry {
  frame?: { leftMm: number; topMm: number; widthMm: number; heightMm: number };
  layer?: { widthMm: number; leftMm: number; topMm: number };
}

/**
 * Atomic geometry write for a compiled image (data-img-frame + inner data-image-id layer;
 * see docs/layer-model.md). `frame` positions/sizes the crop window; `layer` positions/sizes
 * the photo inside it (height stays auto = aspect-locked). Either may be omitted.
 */
export function setImageGeometry(project: Project, imageId: string, geom: ImageGeometry): void {
  const { dom } = loadDom(project);
  const img: any = dom.document.querySelector(`img[data-image-id="${imageId}"]`);
  if (!img) throw new Error(`page.html has no <img data-image-id="${imageId}">`);
  const frame: any = dom.document.querySelector(`[data-img-frame="${imageId}"]`) ?? img.parentElement;

  const clampPos = (v: number) => Math.max(-NUDGE_LIMIT_MM, Math.min(NUDGE_LIMIT_MM * 2, Number(v) || 0));
  const clampSize = (v: number) => Math.max(FRAME_MIN_MM, Math.min(FRAME_MAX_MM, Number(v) || 0));

  if (geom.frame && frame) {
    mergeStyle(frame, (e) => {
      e.set("position", "absolute");
      e.set("left", `${clampPos(geom.frame!.leftMm).toFixed(1)}mm`);
      e.set("top", `${clampPos(geom.frame!.topMm).toFixed(1)}mm`);
      e.set("width", `${clampSize(geom.frame!.widthMm).toFixed(1)}mm`);
      e.set("height", `${clampSize(geom.frame!.heightMm).toFixed(1)}mm`);
      e.set("overflow", "hidden");
    });
  }
  if (geom.layer) {
    mergeStyle(img, (e) => {
      e.set("position", "absolute");
      e.set("max-width", "none");
      e.set("height", "auto");
      // Photo may extend well past the frame (that's the crop) — allow a generous range.
      const w = Math.max(1, Math.min(FRAME_MAX_MM * 4, Number(geom.layer!.widthMm) || 1));
      e.set("width", `${w.toFixed(1)}mm`);
      e.set("left", `${(Number(geom.layer!.leftMm) || 0).toFixed(1)}mm`);
      e.set("top", `${(Number(geom.layer!.topMm) || 0).toFixed(1)}mm`);
    });
  }
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
