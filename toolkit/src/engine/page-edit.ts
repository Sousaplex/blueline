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

export function selectVariant(project: Project, imageId: string, variant: number): void {
  const file = join(project.imagesDir, imageId, `v${variant}.png`);
  if (!existsSync(file)) throw new Error(`No such variant: ${imageId}/v${variant}.png`);
  const { dom } = loadDom(project);
  const img = dom.document.querySelector(`img[data-image-id="${imageId}"]`);
  if (!img) throw new Error(`page.html has no <img data-image-id="${imageId}">`);
  img.setAttribute("src", `images/${imageId}/v${variant}.png`);
  save(project, dom.document);
}
