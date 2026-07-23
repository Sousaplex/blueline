import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { DATA_ROOT } from "./config.ts";
import { Workspace } from "./workspace.ts";

/** Document GENRE — orthogonal to size. Drives the composition doctrine the agent
 *  receives (and the reviewer enforces): an infographic is a modular data grid, a
 *  poster is one dominant visual, a report is multi-column flowing text, etc. */
export const DOC_TYPES = ["one-pager", "infographic", "poster", "deck", "report", "flyer", "brochure"] as const;
export type DocType = (typeof DOC_TYPES)[number];

export interface PageSettings {
  pageSize: string; // "A4" | "Letter" | "Slide 16:9" | "Custom" | …
  orientation: "portrait" | "landscape";
  pages: number; // target page count — enforced by the reviewer
  widthMm: number | null; // Custom size only
  heightMm: number | null;
  docType?: string; // genre/intent (DOC_TYPES) — shapes layout guidance, NOT size. meta() always fills it.
}

/** Base dimensions in mm. Print sizes are portrait-first; slide presets are landscape-first. */
export const PAGE_DIMS: Record<string, { w: number; h: number }> = {
  A4: { w: 210, h: 297 },
  A5: { w: 148, h: 210 },
  A3: { w: 297, h: 420 },
  Letter: { w: 215.9, h: 279.4 },
  Legal: { w: 215.9, h: 355.6 },
  Tabloid: { w: 279.4, h: 431.8 },
  "Slide 16:9": { w: 338.7, h: 190.5 }, // PowerPoint widescreen (13.33in × 7.5in)
  "Slide 4:3": { w: 254, h: 190.5 },
  Square: { w: 210, h: 210 },
};

/** Resolve the artboard size in mm, honoring orientation and custom dimensions. */
export function pageDims(settings: PageSettings): { w: number; h: number } {
  const base =
    settings.pageSize === "Custom" && settings.widthMm && settings.heightMm
      ? { w: settings.widthMm, h: settings.heightMm }
      : (PAGE_DIMS[settings.pageSize] ?? PAGE_DIMS.A4);
  if (settings.pageSize === "Custom") return base; // custom dims are literal — orientation is baked in
  const landscape = settings.orientation === "landscape";
  return (landscape && base.w < base.h) || (!landscape && base.w > base.h) ? { w: base.h, h: base.w } : base;
}

export interface ProjectMeta {
  displayName: string;
  series: string | null; // document-family name; drives grouping + export filenames
  kind: "document" | "variant";
  parent: string | null; // slug this project was created from
  forkedFromRound: number | null; // set when branched from a specific review round
  template: string | null; // workspace template slug — locks the agent into fill-in-the-data mode
  settings: PageSettings;
}

export const DEFAULT_SETTINGS: PageSettings = { pageSize: "A4", orientation: "portrait", pages: 1, widthMm: null, heightMm: null, docType: "one-pager" };

/** Clamp a custom dimension to something a printer/screen could plausibly want. */
function clampDim(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.max(50, Math.min(2000, n)) : null;
}

export type SourceKind = "text" | "image" | "pdf" | "other";

export interface SourceFile {
  path: string; // posix-style path relative to the context/styles dir
  kind: SourceKind;
  size: number;
}

export function sourceKind(name: string): SourceKind {
  if (/\.(md|txt)$/i.test(name)) return "text";
  if (/\.(png|jpe?g|webp|gif|svg)$/i.test(name)) return "image";
  if (/\.pdf$/i.test(name)) return "pdf";
  return "other";
}

/** Reject path traversal / absolute paths in workspace-relative source paths. */
export function safeRelPath(p: string): string {
  const norm = p.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!norm || norm.split("/").some((seg) => !seg || seg === ".." || seg === ".")) {
    throw new Error(`Invalid path: ${p}`);
  }
  return norm;
}

/** Recursively list files under a sources dir (context/ or styles/), depth-capped. */
export function listSourceFiles(dir: string, prefix = "", depth = 0): SourceFile[] {
  if (depth > 4 || !existsSync(dir)) return [];
  const out: SourceFile[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listSourceFiles(join(dir, entry.name), rel, depth + 1));
    else if (entry.isFile()) out.push({ path: rel, kind: sourceKind(entry.name), size: statSync(join(dir, entry.name)).size });
    if (out.length > 500) break; // sanity cap for runaway workspaces
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Paths and accessors for one project working directory inside a workspace. */
export class Project {
  readonly dir: string;
  readonly slug: string;
  readonly workspace: Workspace;

  constructor(projectDirArg: string, workspace?: Workspace) {
    this.workspace = workspace ?? new Workspace(DATA_ROOT).ensure();
    // Accept absolute paths, workspace-relative ("projects/x") and bare slugs.
    this.dir = isAbsolute(projectDirArg)
      ? projectDirArg
      : projectDirArg.includes("/")
        ? resolve(this.workspace.root, projectDirArg)
        : join(this.workspace.projectsDir, projectDirArg);
    if (!existsSync(this.dir)) throw new Error(`Project directory not found: ${this.dir}`);
    this.slug = this.dir.split("/").filter(Boolean).pop()!;
    for (const sub of ["images", "out", "review", "fetched"]) {
      mkdirSync(join(this.dir, sub), { recursive: true });
    }
  }

  get pageHtml() { return join(this.dir, "page.html"); }
  get promptsJson() { return join(this.dir, "images", "prompts.json"); }
  get imagesDir() { return join(this.dir, "images"); }
  get proofPdf() { return join(this.dir, "out", "proof.pdf"); }
  get reviewDir() { return join(this.dir, "review"); }
  get fetchedDir() { return join(this.dir, "fetched"); }

  brief(): string {
    const p = join(this.dir, "brief.md");
    if (!existsSync(p)) throw new Error(`No brief.md in ${this.dir}`);
    return readFileSync(p, "utf8");
  }

  writeBrief(content: string): void {
    writeFileSync(join(this.dir, "brief.md"), content.trimEnd() + "\n");
  }

  private get metaJson() { return join(this.dir, "project.json"); }

  /** Project metadata with defaults — always safe to call, even on legacy projects. */
  meta(): ProjectMeta {
    let stored: Partial<ProjectMeta> = {};
    if (existsSync(this.metaJson)) {
      try {
        stored = JSON.parse(readFileSync(this.metaJson, "utf8"));
      } catch {
        // corrupt project.json falls back to defaults rather than bricking the project
      }
    }
    return {
      displayName: stored.displayName?.trim() || this.slug,
      series: stored.series ?? null,
      kind: stored.kind === "variant" ? "variant" : "document",
      parent: stored.parent ?? null,
      forkedFromRound: stored.forkedFromRound ?? null,
      template: stored.template ?? null,
      settings: {
        pageSize: stored.settings?.pageSize?.trim() || DEFAULT_SETTINGS.pageSize,
        orientation: stored.settings?.orientation === "landscape" ? "landscape" : "portrait",
        pages: Math.max(1, Math.min(24, Number(stored.settings?.pages) || DEFAULT_SETTINGS.pages)),
        widthMm: clampDim(stored.settings?.widthMm),
        heightMm: clampDim(stored.settings?.heightMm),
        docType: (DOC_TYPES as readonly string[]).includes(stored.settings?.docType ?? "")
          ? (stored.settings!.docType as string)
          : DEFAULT_SETTINGS.docType,
      },
    };
  }

  updateMeta(patch: Partial<ProjectMeta>): ProjectMeta {
    const current = this.meta();
    const next: ProjectMeta = {
      ...current,
      ...patch,
      settings: { ...current.settings, ...(patch.settings ?? {}) },
    };
    writeFileSync(this.metaJson, JSON.stringify(next, null, 2) + "\n");
    return this.meta();
  }

  private get sourcesJson() { return join(this.dir, "sources.json"); }

  /** Selected workspace context files for this project; null = all (default). */
  selectedSources(): string[] | null {
    if (!existsSync(this.sourcesJson)) return null;
    try {
      const parsed = JSON.parse(readFileSync(this.sourcesJson, "utf8"));
      return Array.isArray(parsed.context) ? parsed.context : null;
    } catch {
      return null;
    }
  }

  setSelectedSources(files: string[] | null): void {
    if (files === null) {
      if (existsSync(this.sourcesJson)) writeFileSync(this.sourcesJson, JSON.stringify({ context: null }, null, 2));
      return;
    }
    const safe = files
      .map((f) => {
        try {
          return safeRelPath(f);
        } catch {
          return null;
        }
      })
      .filter((f): f is string => Boolean(f));
    writeFileSync(this.sourcesJson, JSON.stringify({ context: safe }, null, 2));
  }

  /** Concatenated brand guidelines (md/txt, subfolders included) from workspace brand/. */
  brandGuide(): string {
    return listSourceFiles(this.workspace.brandDir)
      .filter((f) => f.kind === "text")
      .map((f) => `## ${f.path}\n\n${readFileSync(join(this.workspace.brandDir, f.path), "utf8")}`)
      .join("\n\n");
  }

  /** Non-text brand assets (logos, photos, fonts) the agent must use as-is. */
  brandAssets(): SourceFile[] {
    return listSourceFiles(this.workspace.brandDir).filter((f) => f.kind !== "text");
  }

  completedRounds(): number {
    if (!existsSync(this.reviewDir)) return 0;
    return readdirSync(this.reviewDir).filter((f) => /^round-\d+\.json$/.test(f)).length;
  }

  latestReview(): { round: number; result: unknown } | undefined {
    const rounds = readdirSync(this.reviewDir)
      .map((f) => /^round-(\d+)\.json$/.exec(f)?.[1])
      .filter(Boolean)
      .map(Number)
      .sort((a, b) => a - b);
    const last = rounds.at(-1);
    if (last === undefined) return undefined;
    return { round: last, result: JSON.parse(readFileSync(join(this.reviewDir, `round-${last}.json`), "utf8")) };
  }

  /** Archived page state for a review round (enables branching from that round). */
  roundHtml(round: number): string {
    return join(this.reviewDir, `round-${round}.html`);
  }

  writeReview(round: number, result: unknown): string {
    const p = join(this.reviewDir, `round-${round}.json`);
    writeFileSync(p, JSON.stringify(result, null, 2));
    return p;
  }
}
