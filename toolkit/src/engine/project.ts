import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { REPO_ROOT } from "./config.ts";

/** Paths and accessors for one projects/<slug>/ working directory. */
export class Project {
  readonly dir: string;
  readonly slug: string;

  constructor(projectDirArg: string) {
    this.dir = resolve(REPO_ROOT, projectDirArg);
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

  /** Concatenated style guides from styles/ (repo-level, shared across projects). */
  styleGuide(): string {
    const stylesDir = join(REPO_ROOT, "styles");
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
