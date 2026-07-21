// Topbar library: replaces the old flat project dropdown. Opens a sheet with the
// searchable, series-grouped project tree plus workspace-level actions.
import { FolderOpen, Library, Plus, X } from "lucide-react";
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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import type { EngineClient, ProjectListing } from "../engine-client";
import { GitSyncDialog } from "./GitSyncDialog";
import { ProjectLibrary } from "./ProjectLibrary";

export function LibrarySheet({
  client,
  projects,
  currentSlug,
  currentName,
  workspaceRoot,
  onNewProject,
  onError,
}: {
  client: EngineClient;
  projects: ProjectListing[];
  currentSlug: string | null;
  currentName: string;
  workspaceRoot: string;
  onNewProject: () => void;
  onError: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const act = (fn: () => Promise<unknown>, close = false) => {
    void fn()
      .then(() => close && setOpen(false))
      .catch((e) => onError(e instanceof Error ? e.message : String(e)));
  };

  return (
    <>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <Button variant="ghost" size="sm" className="max-w-64 gap-2 font-medium" title={workspaceRoot}>
            <Library data-slot="icon" />
            <span className="truncate">{currentName}</span>
          </Button>
        </SheetTrigger>
        <SheetContent side="left" className="flex w-96 flex-col gap-0 sm:max-w-96">
          <SheetHeader className="pb-2">
            <SheetTitle>Library</SheetTitle>
            <SheetDescription className="truncate font-mono text-xs" title={workspaceRoot}>
              {workspaceRoot}
            </SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 px-4">
            <ProjectLibrary
              projects={projects}
              currentSlug={currentSlug}
              onOpen={(p) => act(() => client.openProject(p.dir), true)}
              onRun={(slug) => act(() => client.run(slug))}
              onDelete={setPendingDelete}
            />
          </div>
          <div className="flex items-center gap-2 border-t p-4">
            <Button
              size="sm"
              onClick={() => {
                setOpen(false);
                onNewProject();
              }}
            >
              <Plus data-slot="icon" /> New project
            </Button>
            <Button size="sm" variant="outline" onClick={() => act(() => client.chooseWorkspace(), true)}>
              <FolderOpen data-slot="icon" /> Workspace…
            </Button>
            <GitSyncDialog client={client} />
            <div className="flex-1" />
            {currentSlug && (
              <Button size="sm" variant="ghost" title="Close the current project and go to the library home" onClick={() => act(() => client.closeProject(), true)}>
                <X data-slot="icon" /> Close project
              </Button>
            )}
          </div>
        </SheetContent>
      </Sheet>

      <AlertDialog open={pendingDelete !== null} onOpenChange={(o) => !o && setPendingDelete(null)}>
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
    </>
  );
}
