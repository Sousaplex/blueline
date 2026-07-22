// Per-project undo/redo for page.html (in-memory, capped). The bridge snapshots
// BEFORE each mutating page edit; undo/redo swap file contents LIFO. Human edits
// only — agent runs rewrite the page wholesale and archive per round instead.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import type { Project } from "./project.ts";

/** pc-ids whose element differs between two page states, innermost only —
 *  lets the UI scroll to and name what an undo/redo actually changed. */
export function diffPages(before: string, after: string): string[] {
  const docOf = (html: string) => parseHTML(html).document;
  const mapOf = (doc: any) => {
    const m = new Map<string, string>();
    doc.querySelectorAll("[data-pc-id]").forEach((el: any) => m.set(el.getAttribute("data-pc-id"), el.outerHTML));
    return m;
  };
  const beforeDoc = docOf(before);
  const afterDoc = docOf(after);
  const a = mapOf(beforeDoc);
  const b = mapOf(afterDoc);
  const changed = new Set<string>();
  for (const [id, html] of a) if (b.get(id) !== html) changed.add(id);
  for (const id of b.keys()) if (!a.has(id)) changed.add(id);
  // A parent's outerHTML changes whenever a child does — keep only the innermost.
  // Containment is checked in BOTH states so a removed child still explains its parent.
  const contains = (el: any, other: string) => Boolean(el?.querySelector(`[data-pc-id="${other}"]`));
  const leafOnly = [...changed].filter((id) => {
    const elAfter = afterDoc.querySelector(`[data-pc-id="${id}"]`);
    const elBefore = beforeDoc.querySelector(`[data-pc-id="${id}"]`);
    if (!elAfter && !elBefore) return true;
    return ![...changed].some((other) => other !== id && (contains(elAfter, other) || contains(elBefore, other)));
  });
  return leafOnly;
}

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

export function undoPage(project: Project): { undo: number; redo: number; changed: string[] } {
  const s = stackFor(project);
  const prev = s.undo.pop();
  if (prev === undefined) throw new Error("Nothing to undo");
  const current = readFileSync(project.pageHtml, "utf8");
  s.redo.push(current);
  writeFileSync(project.pageHtml, prev);
  return { ...historyDepth(project), changed: diffPages(current, prev) };
}

export function redoPage(project: Project): { undo: number; redo: number; changed: string[] } {
  const s = stackFor(project);
  const next = s.redo.pop();
  if (next === undefined) throw new Error("Nothing to redo");
  const current = readFileSync(project.pageHtml, "utf8");
  s.undo.push(current);
  writeFileSync(project.pageHtml, next);
  return { ...historyDepth(project), changed: diffPages(current, next) };
}

/** Forget a project's history (project deleted / workspace switched). */
export function clearHistory(projectDir: string): void {
  stacks.delete(projectDir);
}
