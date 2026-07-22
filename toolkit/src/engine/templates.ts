// Workspace templates: reusable document skeletons (invoice, proposal, rate card…).
// A template freezes an approved page structure; projects created from it get the
// page copied in and a meta.template marker that switches the agent into strict
// fill-in-the-data mode (structure is a contract, only content changes).
//
//   <workspace>/templates/<slug>/
//     template.json   — name, description, settings, provenance
//     page.html       — the frozen structure (with data-pc-ids)
//     brief.md        — optional brief skeleton copied into new projects
//     images/         — placeholder images + prompts.json so the page renders
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SETTINGS, Project, type PageSettings } from "./project.ts";
import type { Workspace } from "./workspace.ts";

export interface TemplateInfo {
  slug: string;
  name: string;
  description: string;
  settings: PageSettings;
  sourceProject: string | null;
  createdAt: string;
}

export function templatesDir(ws: Workspace): string {
  return join(ws.root, "templates");
}

function slugify(name: string): string {
  const slug = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  if (!slug) throw new Error("Template name produces an empty slug");
  return slug;
}

function readInfo(dir: string, slug: string): TemplateInfo {
  let stored: Partial<TemplateInfo> = {};
  try {
    stored = JSON.parse(readFileSync(join(dir, "template.json"), "utf8"));
  } catch {
    // corrupt/missing template.json degrades to defaults rather than hiding the template
  }
  return {
    slug,
    name: stored.name?.trim() || slug,
    description: stored.description ?? "",
    settings: {
      pageSize: stored.settings?.pageSize?.trim() || DEFAULT_SETTINGS.pageSize,
      orientation: stored.settings?.orientation === "landscape" ? "landscape" : "portrait",
      pages: Math.max(1, Math.min(24, Number(stored.settings?.pages) || DEFAULT_SETTINGS.pages)),
    },
    sourceProject: stored.sourceProject ?? null,
    createdAt: stored.createdAt ?? "",
  };
}

export function listTemplates(ws: Workspace): TemplateInfo[] {
  const root = templatesDir(ws);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(root, e.name, "page.html")))
    .map((e) => readInfo(join(root, e.name), e.name))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Freeze a project's current design as a workspace template. */
export function saveTemplate(project: Project, name: string, description = ""): TemplateInfo {
  if (!existsSync(project.pageHtml)) {
    throw new Error(`"${project.slug}" has no page.html yet — a template needs a finished design`);
  }
  const slug = slugify(name);
  const dir = join(templatesDir(project.workspace), slug);
  if (existsSync(dir)) throw new Error(`Template "${slug}" already exists — pick another name or delete it first`);
  mkdirSync(dir, { recursive: true });
  cpSync(project.pageHtml, join(dir, "page.html"));
  if (existsSync(join(project.dir, "brief.md"))) cpSync(join(project.dir, "brief.md"), join(dir, "brief.md"));
  if (existsSync(project.imagesDir)) cpSync(project.imagesDir, join(dir, "images"), { recursive: true });
  const info: TemplateInfo = {
    slug,
    name: name.trim(),
    description: description.trim(),
    settings: project.meta().settings,
    sourceProject: project.slug,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(join(dir, "template.json"), JSON.stringify(info, null, 2) + "\n");
  return info;
}

export function deleteTemplate(ws: Workspace, slug: string): void {
  if (!/^[a-z0-9-]+$/.test(slug)) throw new Error(`Invalid template slug: ${slug}`);
  const dir = join(templatesDir(ws), slug);
  if (!existsSync(dir)) throw new Error(`No such template: ${slug}`);
  rmSync(dir, { recursive: true, force: true });
}

/** Copy a template's frozen design into a freshly created project dir. */
export function instantiateTemplate(ws: Workspace, slug: string, projectDir: string): TemplateInfo {
  const dir = join(templatesDir(ws), slug);
  if (!existsSync(join(dir, "page.html"))) throw new Error(`No such template: ${slug}`);
  cpSync(join(dir, "page.html"), join(projectDir, "page.html"));
  if (existsSync(join(dir, "images"))) cpSync(join(dir, "images"), join(projectDir, "images"), { recursive: true });
  return readInfo(dir, slug);
}

/** The template's brief skeleton, if it shipped one. */
export function templateBrief(ws: Workspace, slug: string): string | null {
  const p = join(templatesDir(ws), slug, "brief.md");
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}
