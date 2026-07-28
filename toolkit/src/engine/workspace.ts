// A workspace is the user-chosen folder where all design work lives:
//   <root>/projects/<slug>/   — one dir per deliverable
//   <root>/context/           — source material (agent read-only)
//   <root>/brand/             — brand guidelines + assets (agent read-only)
// The Blueline repo itself is the default workspace (backwards compatible
// with the demo). The last-used workspace persists in config/workspace.json.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DATA_ROOT } from "./config.ts";

/** A short filesystem-safe random id (base36, ~41 bits) appended to document folder names so
 *  two people who independently create documents with the SAME name never collide in git —
 *  no central coordination needed. Lowercase avoids case-insensitive-filesystem clashes. */
export function shortId(len = 8): string {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[bytes[i]! % alphabet.length];
  return out;
}

const STATE_PATH = join(DATA_ROOT, "config", "workspace.json");

export interface WorkspaceState {
  root: string;
  lastProject?: string; // slug
}

export class Workspace {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
    if (!existsSync(this.root) || !statSync(this.root).isDirectory()) {
      throw new Error(`Workspace directory does not exist: ${this.root}`);
    }
  }

  get projectsDir() { return join(this.root, "projects"); }
  get contextDir() { return join(this.root, "context"); }
  /** Brand guidelines + assets (logos, fonts, palettes) — the agent's persistent brand home. */
  get brandDir() { return join(this.root, "brand"); }

  /** Create the standard sub-folders (idempotent); migrates legacy styles/ → brand/. */
  ensure(): this {
    if (existsSync(join(this.root, "styles")) && !existsSync(this.brandDir)) {
      renameSync(join(this.root, "styles"), this.brandDir);
    }
    for (const dir of [this.projectsDir, this.contextDir, this.brandDir]) {
      mkdirSync(dir, { recursive: true });
    }
    return this;
  }

  listProjects(): { dir: string; slug: string; hasBrief: boolean }[] {
    if (!existsSync(this.projectsDir)) return [];
    return readdirSync(this.projectsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => ({
        dir: join(this.projectsDir, e.name),
        slug: e.name,
        hasBrief: existsSync(join(this.projectsDir, e.name, "brief.md")),
      }))
      .sort((a, b) => a.slug.localeCompare(b.slug));
  }

  createProject(name: string, brief: string): { dir: string; slug: string } {
    const base = name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48);
    if (!base) throw new Error("Project name produces an empty slug");
    // Folder id = readable slug + a random suffix, so the SAME name from two people never
    // collides in a shared git repo. The display name (which may repeat) lives in project.json.
    const slug = `${base}-${shortId()}`;
    const dir = join(this.projectsDir, slug);
    if (existsSync(dir)) throw new Error(`Project "${slug}" already exists`); // astronomically unlikely
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "brief.md"), brief.trim() + "\n");
    return { dir, slug };
  }

  persist(lastProject?: string): void {
    mkdirSync(join(DATA_ROOT, "config"), { recursive: true });
    writeFileSync(STATE_PATH, JSON.stringify({ root: this.root, lastProject } satisfies WorkspaceState, null, 2));
  }

  /** Restore the last-used workspace, defaulting to the data root.
   *  `fresh` = no workspace was ever persisted — the UI runs onboarding. */
  static load(): { workspace: Workspace; lastProject?: string; fresh: boolean } {
    if (existsSync(STATE_PATH)) {
      try {
        const state = JSON.parse(readFileSync(STATE_PATH, "utf8")) as WorkspaceState;
        return { workspace: new Workspace(state.root).ensure(), lastProject: state.lastProject, fresh: false };
      } catch {
        // fall through to default on a stale/broken state file
      }
    }
    return { workspace: new Workspace(DATA_ROOT).ensure(), fresh: true };
  }
}

export const BRIEF_TEMPLATE = `# Brief: <what is this piece?>

**Format:** one-pager, A4 portrait, print (PDF)
**Audience:** <who will hold this in their hands?>
**Goal:** <what should they do after reading it?>

## Key messages
1. <the one thing they must remember>
2. <supporting point>
3. <supporting point>

## Must include
- <hero image? logo? CTA with contact info?>

## Tone
<confident / playful / clinical / warm …>
`;
