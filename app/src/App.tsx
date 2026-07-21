import { Download, FolderOpen, Play, Plus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentPane, type FeedItem } from "./components/AgentPane";
import { LeftPane } from "./components/LeftPane";
import { NewProjectDialog } from "./components/NewProjectDialog";
import { PreviewPane } from "./components/PreviewPane";
import { SettingsDialog } from "./components/SettingsDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { BrowserEngineClient, type EngineEvent, type ProjectListing, type ProjectState } from "./engine-client";

export function App() {
  const client = useMemo(() => new BrowserEngineClient(), []);
  const [project, setProject] = useState<ProjectState | null>(null);
  const [bridgeError, setBridgeError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [cacheKey, setCacheKey] = useState(() => Date.now());
  const [viewRound, setViewRound] = useState<number | null>(null); // null = latest
  const [projects, setProjects] = useState<ProjectListing[]>([]);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const refreshTimer = useRef<number | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      setProject(await client.getProject());
      setBridgeError(null);
    } catch (err) {
      setBridgeError(err instanceof Error ? err.message : String(err));
    }
  }, [client]);

  useEffect(() => {
    void refresh();
    void client.listProjects().then(setProjects);
    return client.subscribe((event: EngineEvent) => {
      switch (event.type) {
        case "text_delta":
          setFeed((f) => {
            const last = f.at(-1);
            if (last?.kind === "text") return [...f.slice(0, -1), { ...last, text: last.text + event.delta }];
            return [...f, { kind: "text", text: event.delta, at: Date.now() }];
          });
          break;
        case "tool_start":
          setFeed((f) => [...f, { kind: "tool", tool: event.tool, args: event.args, at: Date.now() }]);
          break;
        case "tool_end":
          setFeed((f) => [...f, { kind: "tool_result", tool: event.tool, summary: event.summary, at: Date.now() }]);
          break;
        case "error":
          setFeed((f) => [...f, { kind: "error", message: event.message, at: Date.now() }]);
          break;
        case "status":
          setRunning(event.running);
          void refresh();
          break;
        case "settings_changed":
          void refresh();
          break;
        case "project_changed":
        case "workspace_changed":
          setFeed([]);
          setViewRound(null);
          setCacheKey(Date.now());
          void refresh();
          void client.listProjects().then(setProjects);
          break;
        case "files_changed":
          window.clearTimeout(refreshTimer.current);
          refreshTimer.current = window.setTimeout(() => {
            setCacheKey(Date.now());
            void refresh();
          }, 400);
          break;
      }
    });
  }, [client, refresh]);

  const actions = useMemo(
    () => ({
      run: () => client.run().catch((e) => setFeed((f) => [...f, { kind: "error" as const, message: String(e), at: Date.now() }])),
      chat: (text: string) => client.chat(text),
      render: () => client.render(),
      updateCopy: (pcId: string, text: string) => client.updateCopy(pcId, text),
      selectVariant: (id: string, v: number) => client.selectVariant(id, v),
    }),
    [client],
  );

  if (bridgeError) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 text-center">
        <h1 className="text-xl font-semibold">presscheck</h1>
        <p className="max-w-md text-sm text-muted-foreground">{bridgeError}</p>
        <p className="text-sm text-muted-foreground">
          Start the bridge: <code className="rounded bg-muted px-1.5 py-0.5">cd toolkit && npm run serve -- projects/demo</code>
        </p>
        <Button variant="outline" size="sm" onClick={() => void refresh()}>
          Retry
        </Button>
      </div>
    );
  }
  if (!project) return <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">loading…</div>;

  if (!project.slug) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 bg-background text-foreground">
        <h1 className="text-lg font-semibold">presscheck</h1>
        <p className="text-sm text-muted-foreground">
          Workspace: <code className="rounded bg-muted px-1.5 py-0.5">{project.workspaceRoot}</code>
        </p>
        <p className="text-sm text-muted-foreground">No projects here yet.</p>
        <div className="flex gap-2">
          <Button onClick={() => setNewProjectOpen(true)}>
            <Plus data-slot="icon" /> New project
          </Button>
          <Button variant="outline" onClick={() => void client.chooseWorkspace()}>
            <FolderOpen data-slot="icon" /> Change workspace
          </Button>
        </div>
        <NewProjectDialog client={client} open={newProjectOpen} onOpenChange={setNewProjectOpen} />
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b px-4">
        <span className="text-sm font-semibold tracking-tight">presscheck</span>
        <Select
          value={project.slug ?? "__none"}
          onValueChange={(value) => {
            if (value === "__new") return setNewProjectOpen(true);
            if (value === "__workspace") return void client.chooseWorkspace();
            const target = projects.find((p) => p.slug === value);
            if (target && !target.current) void client.openProject(target.dir);
          }}
        >
          <SelectTrigger size="sm" className="w-52 border-none shadow-none" title={project.workspaceRoot}>
            <SelectValue placeholder="no project" />
          </SelectTrigger>
          <SelectContent>
            {!project.slug && <SelectItem value="__none" disabled>no project open</SelectItem>}
            {projects.map((p) => (
              <SelectItem key={p.slug} value={p.slug} disabled={!p.hasBrief}>
                {p.slug}
              </SelectItem>
            ))}
            <SelectItem value="__new">
              <Plus className="size-3.5" /> New project…
            </SelectItem>
            <SelectItem value="__workspace">
              <FolderOpen className="size-3.5" /> Change workspace…
            </SelectItem>
          </SelectContent>
        </Select>
        {running && <Badge variant="secondary" className="animate-pulse">running</Badge>}
        <div className="flex-1" />
        <Badge variant="outline" className="font-mono text-xs">{project.designerModel}</Badge>
        <Button size="sm" disabled={running} onClick={() => void actions.run()}>
          <Play data-slot="icon" /> Run
        </Button>
        <Button size="sm" variant="outline" disabled={!project.hasPage} onClick={() => void actions.render()}>
          <RefreshCw data-slot="icon" /> Re-render
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!project.hasProof}
          onClick={() =>
            void client.exportPdf().then((path) => {
              if (path) setFeed((f) => [...f, { kind: "text", text: `Exported: ${path}`, at: Date.now() }]);
            })
          }
        >
          <Download data-slot="icon" /> Export
        </Button>
        <SettingsDialog client={client} />
        <NewProjectDialog client={client} open={newProjectOpen} onOpenChange={setNewProjectOpen} />
      </header>
      {/* grid-rows-1 => minmax(0,1fr): bounds the row to the viewport so panes scroll internally */}
      <div className="grid min-h-0 flex-1 grid-cols-[260px_minmax(0,1fr)_340px] grid-rows-1 overflow-hidden">
        <LeftPane project={project} viewRound={viewRound} onViewRound={setViewRound} />
        <PreviewPane project={project} client={client} cacheKey={cacheKey} actions={actions} viewRound={viewRound} onViewRound={setViewRound} />
        <AgentPane feed={feed} running={running} onChat={(t) => void actions.chat(t)} />
      </div>
    </div>
  );
}
