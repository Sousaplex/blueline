// Series-grouped, searchable project tree with lineage (parent → children, fork
// rounds). Shared by the home screen and the topbar Library sheet — this is the
// navigation that replaces the flat dropdown once a workspace grows.
import {
  CheckCircle2,
  CircleAlert,
  CornerDownRight,
  GitBranch,
  Layers,
  Loader2,
  Play,
  Search,
  Timer,
  Trash2,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { ProjectListing } from "../engine-client";

interface TreeNode {
  listing: ProjectListing;
  children: TreeNode[];
}

/** Group by series, then arrange each group as parent→children trees. */
function buildGroups(projects: ProjectListing[]): { series: string | null; roots: TreeNode[] }[] {
  const bySlug = new Map(projects.map((p) => [p.slug, p]));
  const nodes = new Map<string, TreeNode>(projects.map((p) => [p.slug, { listing: p, children: [] }]));
  const roots: TreeNode[] = [];
  for (const p of projects) {
    const node = nodes.get(p.slug)!;
    const parent = p.meta.parent && bySlug.has(p.meta.parent) ? nodes.get(p.meta.parent) : undefined;
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  const groups = new Map<string | null, TreeNode[]>();
  for (const root of roots) {
    const series = root.listing.meta.series;
    groups.set(series, [...(groups.get(series) ?? []), root]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a.localeCompare(b))) // named series first
    .map(([series, groupRoots]) => ({ series, roots: groupRoots }));
}

function flatten(node: TreeNode, depth: number): { node: TreeNode; depth: number }[] {
  return [{ node, depth }, ...node.children.flatMap((c) => flatten(c, depth + 1))];
}

export function ProjectLibrary({
  projects,
  currentSlug,
  onOpen,
  onRun,
  onDelete,
}: {
  projects: ProjectListing[];
  currentSlug?: string | null;
  onOpen: (p: ProjectListing) => void;
  onRun?: (slug: string) => void;
  onDelete?: (slug: string) => void;
}) {
  const [query, setQuery] = useState("");

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? projects.filter(
          (p) =>
            p.slug.includes(q) ||
            p.meta.displayName.toLowerCase().includes(q) ||
            (p.meta.series ?? "").toLowerCase().includes(q),
        )
      : projects;
    return buildGroups(filtered);
  }, [projects, query]);

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search ${projects.length} project${projects.length === 1 ? "" : "s"}…`}
          className="h-8 pl-8 text-sm"
        />
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
        {groups.map(({ series, roots }) => (
          <section key={series ?? "__none"}>
            <h3 className="mb-1 flex items-center gap-1.5 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              {series ? (
                <>
                  <Layers className="size-3" /> {series}
                </>
              ) : (
                "Projects"
              )}
            </h3>
            <div className="space-y-0.5">
              {roots
                .flatMap((r) => flatten(r, 0))
                .map(({ node, depth }) => (
                  <LibraryRow
                    key={node.listing.slug}
                    listing={node.listing}
                    depth={depth}
                    current={node.listing.slug === currentSlug}
                    onOpen={onOpen}
                    onRun={onRun}
                    onDelete={onDelete}
                  />
                ))}
            </div>
          </section>
        ))}
        {groups.length === 0 && (
          <p className="px-1 py-6 text-center text-sm text-muted-foreground">
            {query ? "No projects match." : "No projects in this workspace yet."}
          </p>
        )}
      </div>
    </div>
  );
}

function LibraryRow({
  listing: p,
  depth,
  current,
  onOpen,
  onRun,
  onDelete,
}: {
  listing: ProjectListing;
  depth: number;
  current: boolean;
  onOpen: (p: ProjectListing) => void;
  onRun?: (slug: string) => void;
  onDelete?: (slug: string) => void;
}) {
  return (
    <div
      className={cn(
        "group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent",
        current && "bg-accent font-medium",
        !p.hasBrief && "cursor-default opacity-60",
      )}
      style={{ paddingLeft: `${8 + depth * 18}px` }}
      onClick={() => p.hasBrief && onOpen(p)}
      title={p.slug}
    >
      {depth > 0 && <CornerDownRight className="size-3.5 shrink-0 text-muted-foreground" />}
      <span className="truncate">{p.meta.displayName}</span>
      {p.meta.kind === "variant" && (
        <Badge variant="outline" className="shrink-0 px-1 text-[10px]">
          variant
        </Badge>
      )}
      {p.meta.forkedFromRound != null && (
        <Badge variant="outline" className="shrink-0 gap-0.5 px-1 text-[10px]">
          <GitBranch className="size-2.5" /> r{p.meta.forkedFromRound}
        </Badge>
      )}
      <span className="flex-1" />
      <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
        {p.runState === "running" && <Loader2 className="size-3.5 animate-spin text-emerald-600 dark:text-emerald-400" />}
        {p.runState === "queued" && <Timer className="size-3.5 text-amber-600 dark:text-amber-400" />}
        {p.rounds > 0 && <span className="tabular-nums">{p.rounds}r</span>}
        {p.lastVerdict === "pass" && <CheckCircle2 className="size-3.5 text-emerald-600 dark:text-emerald-400" />}
        {p.lastVerdict === "revise" && <CircleAlert className="size-3.5 text-amber-600 dark:text-amber-400" />}
        {!p.hasBrief && <span className="text-amber-600 dark:text-amber-400">no brief</span>}
      </span>
      {(onRun || onDelete) && (
        <span className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100">
          {onRun && p.runState === "idle" && p.hasBrief && (
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-6"
              aria-label={`Run ${p.slug}`}
              onClick={(e) => {
                e.stopPropagation();
                onRun(p.slug);
              }}
            >
              <Play />
            </Button>
          )}
          {onDelete && (
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-6"
              aria-label={`Delete ${p.slug}`}
              onClick={(e) => {
                e.stopPropagation();
                onDelete(p.slug);
              }}
            >
              <Trash2 className="text-destructive" />
            </Button>
          )}
        </span>
      )}
    </div>
  );
}
