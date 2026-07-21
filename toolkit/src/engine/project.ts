import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { REPO_ROOT } from "./config.ts";
import { Workspace } from "./workspace.ts";

/** Paths and accessors for one project working directory inside a workspace. */
export class Project {
  readonly dir: string;
  readonly slug: string;
  readonly workspace: Workspace;

  constructor(projectDirArg: string, workspace?: Workspace) {
    this.workspace = workspace ?? new Workspace(REPO_ROOT).ensure();
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
    const safe = files.map((f) => f.replace(/[/\\]/g, "")).filter(Boolean);
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

  writeReview(round: number, result: unknown): string {
    const p = join(this.reviewDir, `round-${round}.json`);
    writeFileSync(p, JSON.stringify(result, null, 2));
    return p;
  }
}
