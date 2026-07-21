import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { DATA_ROOT } from "./config.ts";
import { Workspace } from "./workspace.ts";

export interface PageSettings {
  pageSize: string; // "A4" | "Letter" | "A5" | …
  orientation: "portrait" | "landscape";
  pages: number; // target page count — enforced by the reviewer
}

export interface ProjectMeta {
  displayName: string;
  series: string | null; // document-family name; drives grouping + export filenames
  kind: "document" | "variant";
  parent: string | null; // slug this project was created from
  forkedFromRound: number | null; // set when branched from a specific review round
  settings: PageSettings;
}

export const DEFAULT_SETTINGS: PageSettings = { pageSize: "A4", orientation: "portrait", pages: 1 };

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
      settings: {
        pageSize: stored.settings?.pageSize?.trim() || DEFAULT_SETTINGS.pageSize,
        orientation: stored.settings?.orientation === "landscape" ? "landscape" : "portrait",
        pages: Math.max(1, Math.min(24, Number(stored.settings?.pages) || DEFAULT_SETTINGS.pages)),
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

  /** Concatenated style guides from the workspace's styles/ directory. */
  styleGuide(): string {
    const stylesDir = this.workspace.stylesDir;
    if (!existsSync(stylesDir)) return "";
    return readdirSync(stylesDir)
      .filter((f) => /\.(md|txt)$/i.test(f))
      .map((f) => `## ${f}\n\n${readFileSync(join(stylesDir, f), "utf8")}`)
      .join("\n\n");
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
