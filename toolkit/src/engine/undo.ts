// Per-project undo/redo for page.html (in-memory, capped). The bridge snapshots
// BEFORE each mutating page edit; undo/redo swap file contents LIFO. Human edits
// only — agent runs rewrite the page wholesale and archive per round instead.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Project } from "./project.ts";

const MAX_DEPTH = 50;
const stacks = new Map<string, { undo: string[]; redo: string[] }>();

function stackFor(project: Project): { undo: string[]; redo: string[] } {
  let s = stacks.get(project.dir);
  if (!s) stacks.set(project.dir, (s = { undo: [], redo: [] }));
  return s;
}

export function historyDepth(project: Project): { undo: number; redo: number } {
  const s = stacks.get(project.dir);
  return { undo: s?.undo.length ?? 0, redo: s?.redo.length ?? 0 };
}

/** Capture page.html before a mutation. Any new edit invalidates the redo branch. */
export function snapshotPage(project: Project): void {
  if (!existsSync(project.pageHtml)) return;
  const s = stackFor(project);
  const current = readFileSync(project.pageHtml, "utf8");
  s.redo = [];
  if (s.undo.at(-1) === current) return; // identical consecutive writes collapse
  s.undo.push(current);
  if (s.undo.length > MAX_DEPTH) s.undo.shift();
}

export function undoPage(project: Project): { undo: number; redo: number } {
  const s = stackFor(project);
  const prev = s.undo.pop();
  if (prev === undefined) throw new Error("Nothing to undo");
  s.redo.push(readFileSync(project.pageHtml, "utf8"));
  writeFileSync(project.pageHtml, prev);
  return historyDepth(project);
}

export function redoPage(project: Project): { undo: number; redo: number } {
  const s = stackFor(project);
  const next = s.redo.pop();
  if (next === undefined) throw new Error("Nothing to redo");
  s.undo.push(readFileSync(project.pageHtml, "utf8"));
  writeFileSync(project.pageHtml, next);
  return historyDepth(project);
}

/** Forget a project's history (project deleted / workspace switched). */
export function clearHistory(projectDir: string): void {
  stacks.delete(projectDir);
}
