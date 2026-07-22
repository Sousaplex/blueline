import { FolderOpen, Plus } from "lucide-react";
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
import logo from "../assets/logo.png";
import type { EngineClient, ProjectListing } from "../engine-client";
import { NewProjectDialog } from "./NewProjectDialog";
import { GitSyncDialog } from "./GitSyncDialog";
import { ProjectLibrary } from "./ProjectLibrary";
import { ThemeToggle } from "./ThemeToggle";

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
        <img src={logo} alt="" className="size-6" />
        <span className="text-sm font-semibold tracking-tight">blueline</span>
        <span className="font-mono text-[10px] text-muted-foreground" title={`built ${__BUILD_TIME__}`}>v{__APP_VERSION__}</span>
        <span className="truncate font-mono text-xs text-muted-foreground" title={workspaceRoot}>
          {workspaceRoot}
        </span>
        <div className="flex-1" />
        <ThemeToggle />
        <GitSyncDialog client={client} />
        <Button size="sm" variant="outline" onClick={() => act(() => client.chooseWorkspace())}>
          <FolderOpen data-slot="icon" /> Change workspace
        </Button>
        <Button size="sm" onClick={() => setNewProjectOpen(true)}>
          <Plus data-slot="icon" /> New project
        </Button>
      </header>

      <main className="mx-auto flex w-full max-w-2xl min-h-0 flex-1 flex-col p-8">
        {error && <p className="mb-4 text-sm text-destructive">{error}</p>}
        {projects.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3">
            <p className="text-sm text-muted-foreground">No projects in this workspace yet.</p>
            <Button onClick={() => setNewProjectOpen(true)}>
              <Plus data-slot="icon" /> Create the first one
            </Button>
          </div>
        ) : (
          <ProjectLibrary
            projects={projects}
            onOpen={(p) => act(() => client.openProject(p.dir))}
            onRun={(slug) => act(() => client.run(slug))}
            onDelete={setPendingDelete}
          />
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
