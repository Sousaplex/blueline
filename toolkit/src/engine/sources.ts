// Workspace source curation — the write side of context/ and brand/.
// The design agent (and the bridge API) may author markdown docs and reorganize
// the source library ONLY through these helpers: text docs only for writes, no
// overwrites on moves, every path traversal-checked. Binary brand assets (logos,
// fonts, photos) can never be clobbered from here.
import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { safeRelPath } from "./project.ts";
import type { Workspace } from "./workspace.ts";

export type WorkspaceArea = "context" | "brand";

export function areaDir(workspace: Workspace, area: WorkspaceArea): string {
  return area === "brand" ? workspace.brandDir : workspace.contextDir;
}

/** Docs authored by the agent are text-only — it must never write binary assets. */
const TEXT_DOC = /\.(md|txt)$/i;

export interface WriteDocResult {
  /** path relative to the area dir */
  path: string;
  /** true when an existing doc was replaced (vs created) */
  updated: boolean;
}

/** Create or update a markdown/text doc inside context/ or brand/ (subfolders ok). */
export function writeWorkspaceDoc(
  workspace: Workspace,
  area: WorkspaceArea,
  relPath: string,
  content: string,
): WriteDocResult {
  const rel = safeRelPath(relPath);
  if (!TEXT_DOC.test(rel)) {
    throw new Error(`Only .md/.txt docs can be written to ${area}/ — got "${rel}". Binary assets arrive via the app's upload.`);
  }
  if (!content.trim()) throw new Error("Refusing to write an empty doc.");
  const target = join(areaDir(workspace, area), rel);
  const updated = existsSync(target);
  if (updated && !statSync(target).isFile()) throw new Error(`${area}/${rel} exists and is not a file.`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content.trimEnd() + "\n");
  return { path: rel, updated };
}

export interface SourceMove {
  /** area-prefixed workspace path, e.g. "context/notes.md" or "brand/voice.md" */
  from: string;
  to: string;
}

/** Split an area-prefixed path ("context/a/b.md") into its area + area-relative rest. */
function parseAreaPath(p: string): { area: WorkspaceArea; rel: string } {
  const norm = safeRelPath(p);
  const [head, ...rest] = norm.split("/");
  if ((head !== "context" && head !== "brand") || !rest.length) {
    throw new Error(`Path must start with "context/" or "brand/" and name a file: "${p}"`);
  }
  return { area: head, rel: rest.join("/") };
}

const MAX_MOVES = 100;

/** Rename/move files within (or between) context/ and brand/.
 *  All moves are validated up front; nothing is renamed unless every move is legal,
 *  and an existing destination is never overwritten. Returns "from -> to" lines. */
export function moveWorkspaceFiles(workspace: Workspace, moves: SourceMove[]): string[] {
  if (!moves.length) throw new Error("No moves given.");
  if (moves.length > MAX_MOVES) throw new Error(`Too many moves in one call (max ${MAX_MOVES}).`);
  const planned: { srcAbs: string; destAbs: string; label: string }[] = [];
  const claimed = new Set<string>(); // destinations taken by earlier moves in this batch
  const taken = new Set<string>(); // sources already moved away by this batch
  for (const move of moves) {
    const from = parseAreaPath(String(move.from ?? ""));
    const to = parseAreaPath(String(move.to ?? ""));
    const srcAbs = join(areaDir(workspace, from.area), from.rel);
    const destAbs = join(areaDir(workspace, to.area), to.rel);
    if (taken.has(srcAbs)) throw new Error(`Duplicate source in batch: ${move.from}`);
    if (!existsSync(srcAbs) || !statSync(srcAbs).isFile()) {
      throw new Error(`No such file: ${move.from}. List the dir first — nothing was moved.`);
    }
    if ((existsSync(destAbs) && !taken.has(destAbs)) || claimed.has(destAbs)) {
      throw new Error(`Destination already exists: ${move.to}. Pick a new name — nothing was moved.`);
    }
    taken.add(srcAbs);
    claimed.add(destAbs);
    planned.push({ srcAbs, destAbs, label: `${move.from} -> ${move.to}` });
  }
  for (const { srcAbs, destAbs } of planned) {
    mkdirSync(dirname(destAbs), { recursive: true });
    renameSync(srcAbs, destAbs);
  }
  return planned.map((p) => p.label);
}
