import { CheckCircle2, FileText, FolderOpen, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
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
import { Button } from "@/components/ui/button";
import type { EngineClient, ProjectListing } from "../engine-client";
import { NewProjectDialog } from "./NewProjectDialog";

export function HomeScreen({
  client,
  workspaceRoot,
  projects,
}: {
  client: EngineClient;
  workspaceRoot: string;
  projects: ProjectListing[];
}) {
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const act = (fn: () => Promise<unknown>) => {
    setError(null);
    void fn().catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b px-4">
        <span className="text-sm font-semibold tracking-tight">presscheck</span>
        <span className="truncate font-mono text-xs text-muted-foreground" title={workspaceRoot}>
          {workspaceRoot}
        </span>
        <div className="flex-1" />
        <Button size="sm" variant="outline" onClick={() => act(() => client.chooseWorkspace())}>
          <FolderOpen data-slot="icon" /> Change workspace
        </Button>
        <Button size="sm" onClick={() => setNewProjectOpen(true)}>
          <Plus data-slot="icon" /> New project
        </Button>
      </header>

      <main className="flex-1 overflow-y-auto p-8">
        {error && <p className="mb-4 text-sm text-destructive">{error}</p>}
        {projects.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3">
            <p className="text-sm text-muted-foreground">No projects in this workspace yet.</p>
            <Button onClick={() => setNewProjectOpen(true)}>
              <Plus data-slot="icon" /> Create the first one
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4">
            {projects.map((p) => (
              <div
                key={p.slug}
                className="group flex cursor-pointer flex-col gap-2 rounded-lg border p-4 transition-colors hover:border-primary/40 hover:bg-accent/40"
                onClick={() => p.hasBrief && act(() => client.openProject(p.dir))}
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="truncate font-medium">{p.slug}</span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="opacity-0 transition-opacity group-hover:opacity-100"
                    aria-label={`Delete ${p.slug}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setPendingDelete(p.slug);
                    }}
                  >
                    <Trash2 className="text-destructive" />
                  </Button>
                </div>
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  {!p.hasBrief && <span className="text-amber-600 dark:text-amber-400">no brief.md</span>}
                  {p.hasBrief && (
                    <span className="flex items-center gap-1">
                      <FileText className="size-3" /> brief
                    </span>
                  )}
                  {p.rounds > 0 && <span>{p.rounds} round{p.rounds === 1 ? "" : "s"}</span>}
                  {p.hasProof && (
                    <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                      <CheckCircle2 className="size-3" /> proof
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </main>

      <NewProjectDialog client={client} open={newProjectOpen} onOpenChange={setNewProjectOpen} />

      <AlertDialog open={pendingDelete !== null} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{pendingDelete}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Permanently deletes the project folder — brief, page, generated images, proofs, and review
              history. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => {
                const slug = pendingDelete!;
                setPendingDelete(null);
                act(() => client.deleteProject(slug));
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
