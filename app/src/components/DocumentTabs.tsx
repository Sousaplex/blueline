// Tab strip of the current document's FAMILY — the document itself plus its
// variants, branches and series siblings — with a "+" menu for growing it.
// This is the primary way to hop between variations; the Library stays the
// whole-workspace browser.
import { useState } from "react";
import { FilePlus2, GitBranch, Layers, Loader2, Plus, Sparkles, X } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
  onDelete,
  onNewVariants,
  onNewSeries,
  onBranch,
  onNewProject,
}: {
  projects: ProjectListing[];
  currentSlug: string;
  hasPage: boolean;
  onOpen: (dir: string) => void;
  onDelete: (slug: string) => void;
  onNewVariants: () => void;
  onNewSeries: () => void;
  onBranch: () => void;
  onNewProject: () => void;
}) {
  const family = familyOf(projects, currentSlug);
  const [confirmDelete, setConfirmDelete] = useState<ProjectListing | null>(null);

  return (
    <div className="flex h-9 shrink-0 items-end gap-0.5 overflow-x-auto border-b bg-muted/20 px-2">
      {family.map((p) => {
        const active = p.slug === currentSlug;
        return (
          <div
            key={p.slug}
            className={cn(
              "group relative flex h-8 shrink-0 items-center gap-1.5 rounded-t-md border px-2.5 text-xs transition-colors",
              active
                ? "-mb-px border-border border-b-transparent bg-background font-medium"
                : "border-transparent text-muted-foreground hover:bg-accent/50 hover:text-foreground",
            )}
            title={`${p.meta.displayName}${p.meta.kind === "variant" ? " · variant" : ""}${p.meta.forkedFromRound != null ? ` · branched @ round ${p.meta.forkedFromRound}` : ""}`}
          >
            <button className="flex items-center gap-1.5" onClick={() => !active && onOpen(p.dir)}>
              {p.runState === "running" && <Loader2 className="size-3 shrink-0 animate-spin text-emerald-500" />}
              {p.runState === "queued" && <span className="size-1.5 shrink-0 rounded-full bg-amber-500" title="queued" />}
              <span className="max-w-44 truncate">{p.meta.displayName}</span>
              {p.meta.kind === "variant" && (
                <Badge variant="secondary" className="h-4 px-1 text-[9px] uppercase">var</Badge>
              )}
              {p.meta.forkedFromRound != null && (
                <span className="font-mono text-[9px] text-muted-foreground">r{p.meta.forkedFromRound}</span>
              )}
              {p.lastVerdict === "pass" && <span className="size-1.5 shrink-0 rounded-full bg-emerald-500/50" title="passed review" />}
            </button>
            <button
              className={cn(
                "-mr-1 ml-0.5 rounded p-0.5 transition-opacity hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30",
                active ? "text-muted-foreground opacity-60 hover:opacity-100" : "text-muted-foreground opacity-0 group-hover:opacity-70",
              )}
              title={p.runState !== "idle" ? "Stop the run before deleting" : "Delete this document"}
              disabled={p.runState !== "idle"}
              onClick={(e) => {
                e.stopPropagation();
                setConfirmDelete(p);
              }}
            >
              <X className="size-3" />
            </button>
          </div>
        );
      })}

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

      <AlertDialog open={!!confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{confirmDelete?.meta.displayName}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the document and all its rounds from the workspace. This can’t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmDelete) onDelete(confirmDelete.slug);
                setConfirmDelete(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
