// Tab strip of the current document's FAMILY — the document itself plus its
// variants, branches and series siblings — with a "+" menu for growing it.
// This is the primary way to hop between variations; the Library stays the
// whole-workspace browser.
import { FilePlus2, GitBranch, Layers, Plus, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { ProjectListing } from "../engine-client";

/** The documents that belong with `curSlug`: same series, or connected by parent links. */
export function familyOf(projects: ProjectListing[], curSlug: string): ProjectListing[] {
  const bySlug = new Map(projects.map((p) => [p.slug, p]));
  const cur = bySlug.get(curSlug);
  if (!cur) return [];
  let root = cur;
  const guard = new Set<string>();
  while (root.meta.parent && bySlug.has(root.meta.parent) && !guard.has(root.slug)) {
    guard.add(root.slug);
    root = bySlug.get(root.meta.parent)!;
  }
  const inLineage = (p: ProjectListing): boolean => {
    let q = p;
    for (let hops = 0; hops < 12; hops++) {
      if (q.slug === root.slug) return true;
      if (!q.meta.parent || !bySlug.has(q.meta.parent)) return false;
      q = bySlug.get(q.meta.parent)!;
    }
    return false;
  };
  return projects
    .filter((p) => (cur.meta.series ? p.meta.series === cur.meta.series : false) || inLineage(p))
    .sort((a, b) =>
      a.slug === root.slug ? -1 : b.slug === root.slug ? 1 : a.meta.displayName.localeCompare(b.meta.displayName),
    );
}

export function DocumentTabs({
  projects,
  currentSlug,
  hasPage,
  onOpen,
  onNewVariants,
  onNewSeries,
  onBranch,
  onNewProject,
}: {
  projects: ProjectListing[];
  currentSlug: string;
  hasPage: boolean;
  onOpen: (dir: string) => void;
  onNewVariants: () => void;
  onNewSeries: () => void;
  onBranch: () => void;
  onNewProject: () => void;
}) {
  const family = familyOf(projects, currentSlug);

  return (
    <div className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b bg-muted/20 px-2">
      {family.map((p) => (
        <button
          key={p.slug}
          className={cn(
            "flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-xs transition-colors",
            p.slug === currentSlug
              ? "border-border bg-background font-medium shadow-sm"
              : "border-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground",
          )}
          title={`${p.meta.displayName}${p.meta.kind === "variant" ? " · variant" : ""}${p.meta.forkedFromRound != null ? ` · branched @ round ${p.meta.forkedFromRound}` : ""}`}
          onClick={() => p.slug !== currentSlug && onOpen(p.dir)}
        >
          {p.runState === "running" && <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500" />}
          {p.runState === "queued" && <span className="size-1.5 shrink-0 rounded-full bg-amber-500" />}
          <span className="max-w-44 truncate">{p.meta.displayName}</span>
          {p.meta.kind === "variant" && (
            <Badge variant="secondary" className="h-4 px-1 text-[9px] uppercase">var</Badge>
          )}
          {p.meta.forkedFromRound != null && (
            <span className="font-mono text-[9px] text-muted-foreground">r{p.meta.forkedFromRound}</span>
          )}
          {p.lastVerdict === "pass" && <span className="size-1.5 shrink-0 rounded-full bg-emerald-500/50" title="passed review" />}
        </button>
      ))}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" className="size-7 shrink-0" title="Add a variation of this document">
            <Plus />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuItem onClick={onNewVariants}>
            <Sparkles /> Explore design variants…
            <span className="ml-auto text-[10px] text-muted-foreground">same brief, new looks</span>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onBranch} disabled={!hasPage}>
            <GitBranch /> Branch this document
            <span className="ml-auto text-[10px] text-muted-foreground">copy to edit freely</span>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onNewSeries} disabled={!hasPage}>
            <Layers /> Make a series from this…
            <span className="ml-auto text-[10px] text-muted-foreground">same design, N subjects</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onNewProject}>
            <FilePlus2 /> New blank document…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
