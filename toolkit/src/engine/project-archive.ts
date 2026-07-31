// Portable project archives — the two shareable file types:
//   .blueline    = ONE finished document (self-contained; images are project-local).
//   .blueproject = a whole family (the doc + its variants/series) PLUS the shared brand/
//                  assets and the context/ sources those documents reference.
// Both are zip containers with a `blueline.json` manifest stamped with the app version, so
// they're version-aware and git-storable. Import re-expands into the workspace, de-duplicating
// slugs and rewriting parent-lineage so a shared bundle reconnects cleanly.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { Project, type ProjectMeta } from "./project.ts";
import type { Workspace } from "./workspace.ts";

export const BLUELINE_FILE_EXT = "blueline";
export const BLUELINE_PROJECT_EXT = "blueproject";

/** Blueline app version for the manifest — Electron passes it in; falls back to dev. */
function appVersion(): string {
  return process.env.BLUELINE_VERSION?.trim() || "dev";
}

const RELEASES_URL = "https://github.com/Sousaplex/blueline/releases/latest";

/** A README shipped inside every archive so whoever (or whatever) receives it knows what it is and
 *  how to open it — download Blueline, then Import the file. Written for both humans and agents. */
function readmeFor(kind: "document" | "project", name: string): string {
  const isProject = kind === "project";
  return `# ${name} — Blueline ${kind}

This is a **Blueline ${kind} file** (\`.${isProject ? BLUELINE_PROJECT_EXT : BLUELINE_FILE_EXT}\`), created with Blueline ${appVersion()} — a free AI design studio for print & marketing collateral.

It is a zip archive of ${
    isProject
      ? "a whole project: every document (page HTML/CSS + images), plus the shared brand assets and sources they use"
      : "one finished document: its page HTML/CSS and images"
  }, described by the \`blueline.json\` manifest. It is **not** meant to be opened in a browser or text editor — Blueline reassembles it into a working, editable project.

## How to open it
1. Download and install **Blueline** (free, macOS): ${RELEASES_URL}
2. Open Blueline, and on the **Home** screen click **Import**.
3. Choose this \`.${isProject ? BLUELINE_PROJECT_EXT : BLUELINE_FILE_EXT}\` file. Blueline expands it back into ${isProject ? "the full project" : "an editable document"}.

## For an AI / automated agent
- To view or edit this file properly, install Blueline from ${RELEASES_URL} and **Import** it (Home → Import), or drive Blueline programmatically via its bundled MCP server / local bridge API.
- The machine-readable manifest is \`blueline.json\` (format: \`${isProject ? "blueline-project/1" : "blueline-file/1"}\`). The design source is standard HTML + CSS under \`${isProject ? "projects/<id>/page.html" : "document/page.html"}\`, so the content can be read directly, but Blueline is required to render/export it faithfully.
`;
}

/** Transient/cache files that should never travel in an archive. */
const SKIP_NAMES = new Set([".DS_Store", ".budget.json", ".run-start.json", ".search-budget.json"]);
const SKIP_DIRS = new Set(["fetched", "node_modules", ".git"]);

/** Recursively add a directory's files into the flat zip map under `prefix/…` (forward slashes). */
function addDir(files: Record<string, Uint8Array>, absDir: string, prefix: string): void {
  if (!existsSync(absDir)) return;
  for (const e of readdirSync(absDir, { withFileTypes: true })) {
    if (SKIP_NAMES.has(e.name)) continue;
    const abs = join(absDir, e.name);
    const key = `${prefix}/${e.name}`;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      addDir(files, abs, key);
    } else if (e.isFile()) {
      files[key] = readFileSync(abs);
    }
  }
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** A workspace-unique slug: appends -2, -3… when the base is taken. */
function uniqueSlug(workspace: Workspace, base: string): string {
  let slug = slugify(base) || "document";
  if (!existsSync(join(workspace.projectsDir, slug))) return slug;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${slug}-${n}`;
    if (!existsSync(join(workspace.projectsDir, candidate))) return candidate;
  }
  throw new Error(`Could not find a free slug for "${base}"`);
}

/** The family of a project: same series ∪ parent-lineage (mirrors the UI's DocumentTabs). */
export function projectFamily(workspace: Workspace, slug: string): Array<{ dir: string; slug: string; meta: ProjectMeta }> {
  const all = workspace.listProjects().map((p) => ({ dir: p.dir, slug: p.slug, meta: new Project(p.dir, workspace).meta() }));
  const bySlug = new Map(all.map((p) => [p.slug, p]));
  const cur = bySlug.get(slug);
  if (!cur) return [];
  let root = cur;
  const guard = new Set<string>();
  while (root.meta.parent && bySlug.has(root.meta.parent) && !guard.has(root.slug)) {
    guard.add(root.slug);
    root = bySlug.get(root.meta.parent)!;
  }
  const inLineage = (p: { slug: string; meta: ProjectMeta }): boolean => {
    let q = p;
    for (let hops = 0; hops < 12; hops++) {
      if (q.slug === root.slug) return true;
      if (!q.meta.parent || !bySlug.has(q.meta.parent)) return false;
      q = bySlug.get(q.meta.parent)!;
    }
    return false;
  };
  const fam = all.filter((p) => (cur.meta.series ? p.meta.series === cur.meta.series : false) || inLineage(p));
  return fam.length ? fam : [cur];
}

// ---- export ----

/** Export ONE document as a self-contained `.blueline` file. */
export function exportDocument(project: Project): { filename: string; data: Uint8Array } {
  const meta = project.meta();
  const files: Record<string, Uint8Array> = {};
  addDir(files, project.dir, "document");
  const manifest = {
    format: "blueline-file/1",
    kind: "document" as const,
    app_version: appVersion(),
    exported_at: new Date().toISOString(),
    document: {
      slug: project.slug,
      displayName: meta.displayName,
      series: meta.series,
      settings: meta.settings,
      template: meta.template,
    },
  };
  files["blueline.json"] = strToU8(JSON.stringify(manifest, null, 2));
  files["README.md"] = strToU8(readmeFor("document", meta.displayName || project.slug));
  return { filename: `${slugify(meta.displayName) || project.slug}.${BLUELINE_FILE_EXT}`, data: zipSync(files, { level: 6 }) };
}

/** Export a whole family as a `.blueproject` bundle (documents + brand + referenced context). */
export function exportBundle(workspace: Workspace, slug: string): { filename: string; data: Uint8Array } {
  const fam = projectFamily(workspace, slug);
  if (!fam.length) throw new Error(`No such project: ${slug}`);
  const files: Record<string, Uint8Array> = {};
  for (const p of fam) addDir(files, p.dir, `projects/${p.slug}`);

  // Brand home travels whole — it's the shared identity and is small/curated.
  addDir(files, workspace.brandDir, "brand");

  // Context: only the sources the family actually references (pinned via sources.json).
  // If any member uses "all sources" (null selection), include the whole context library.
  let includeAllContext = false;
  const pinned = new Set<string>();
  for (const p of fam) {
    const sel = new Project(p.dir, workspace).selectedSources();
    if (sel === null) includeAllContext = true;
    else sel.forEach((s) => pinned.add(s));
  }
  if (includeAllContext) {
    addDir(files, workspace.contextDir, "context");
  } else {
    for (const rel of pinned) {
      const abs = join(workspace.contextDir, rel);
      if (existsSync(abs) && statSync(abs).isFile()) files[`context/${rel}`] = readFileSync(abs);
    }
  }

  const root = fam.find((p) => !p.meta.parent) ?? fam[0];
  const manifest = {
    format: "blueline-project/1",
    kind: "project" as const,
    app_version: appVersion(),
    exported_at: new Date().toISOString(),
    root: root.slug,
    documents: fam.map((p) => ({ slug: p.slug, displayName: p.meta.displayName, series: p.meta.series, parent: p.meta.parent })),
    includesBrand: existsSync(workspace.brandDir),
    context: includeAllContext ? "all" : [...pinned],
  };
  files["blueline.json"] = strToU8(JSON.stringify(manifest, null, 2));
  files["README.md"] = strToU8(readmeFor("project", root.meta.series || root.meta.displayName || root.slug));
  const baseName = slugify(root.meta.series || root.meta.displayName) || root.slug;
  return { filename: `${baseName}.${BLUELINE_PROJECT_EXT}`, data: zipSync(files, { level: 6 }) };
}

// ---- import ----

export interface ImportResult {
  kind: "document" | "project";
  imported: { slug: string; displayName: string }[];
  /** The slug to open after import (the first/root document). */
  open: string;
  /** Notes about anything remapped/skipped, for the UI. */
  notes: string[];
}

/** Write a set of zip entries whose keys start with `srcPrefix/` into `destDir`, stripping the prefix. */
function extractInto(entries: Record<string, Uint8Array>, srcPrefix: string, destDir: string, overwrite: boolean): number {
  let count = 0;
  const prefix = `${srcPrefix}/`;
  for (const [key, bytes] of Object.entries(entries)) {
    if (!key.startsWith(prefix)) continue;
    const rel = key.slice(prefix.length);
    if (!rel || rel.includes("..")) continue; // defensive: no traversal out of destDir
    const abs = join(destDir, rel);
    if (!overwrite && existsSync(abs)) continue;
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, bytes);
    count++;
  }
  return count;
}

/** Import a `.blueline` or `.blueproject` archive into the workspace. */
export function importArchive(workspace: Workspace, data: Uint8Array): ImportResult {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(data);
  } catch {
    throw new Error("Not a valid Blueline archive (could not read the zip).");
  }
  const manifestRaw = entries["blueline.json"];
  if (!manifestRaw) throw new Error("Not a Blueline archive — missing blueline.json manifest.");
  const manifest = JSON.parse(strFromU8(manifestRaw)) as any;
  const notes: string[] = [];
  if (manifest.app_version && manifest.app_version !== appVersion() && manifest.app_version !== "dev") {
    notes.push(`Made with Blueline ${manifest.app_version} (you're on ${appVersion()}).`);
  }

  if (typeof manifest.format === "string" && manifest.format.startsWith("blueline-file")) {
    const base = manifest.document?.displayName || manifest.document?.slug || "imported-document";
    const slug = uniqueSlug(workspace, base);
    const dest = join(workspace.projectsDir, slug);
    mkdirSync(dest, { recursive: true });
    extractInto(entries, "document", dest, true);
    if (slug !== (manifest.document?.slug ?? slug)) notes.push(`Imported as "${slug}".`);
    return { kind: "document", imported: [{ slug, displayName: manifest.document?.displayName ?? slug }], open: slug, notes };
  }

  if (typeof manifest.format === "string" && manifest.format.startsWith("blueline-project")) {
    // Merge shared brand/context first (never overwrite the user's existing files).
    const brandN = extractInto(entries, "brand", workspace.brandDir, false);
    const ctxN = extractInto(entries, "context", workspace.contextDir, false);
    if (brandN) notes.push(`Merged ${brandN} brand file(s).`);
    if (ctxN) notes.push(`Merged ${ctxN} source file(s).`);

    // Map every bundled project slug → a free slug up front, so parent references can be rewritten.
    const docs: { slug: string }[] = manifest.documents ?? [];
    const rename = new Map<string, string>();
    for (const d of docs) rename.set(d.slug, uniqueSlug(workspace, d.slug));

    const imported: { slug: string; displayName: string }[] = [];
    for (const d of docs) {
      const newSlug = rename.get(d.slug)!;
      const dest = join(workspace.projectsDir, newSlug);
      mkdirSync(dest, { recursive: true });
      extractInto(entries, `projects/${d.slug}`, dest, true);
      // Rewrite lineage: parent slug → its remapped slug (series is a plain name, carries as-is).
      const proj = new Project(dest, workspace);
      const meta = proj.meta();
      if (meta.parent && rename.has(meta.parent)) proj.updateMeta({ parent: rename.get(meta.parent)! });
      imported.push({ slug: newSlug, displayName: meta.displayName });
    }
    if ([...rename].some(([a, b]) => a !== b)) notes.push("Some documents were renamed to avoid collisions.");
    const rootOrig = manifest.root ?? docs[0]?.slug;
    const open = rename.get(rootOrig) ?? imported[0]?.slug;
    if (!open) throw new Error("Bundle contained no documents.");
    return { kind: "project", imported, open, notes };
  }

  throw new Error(`Unrecognized archive format: ${manifest.format ?? "(none)"}`);
}
