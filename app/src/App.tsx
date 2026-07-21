import { Download, Play, RefreshCw, Timer } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import logo from "./assets/logo.png";
import { AgentPane, type FeedItem } from "./components/AgentPane";
import { HomeScreen } from "./components/HomeScreen";
import { LeftPane } from "./components/LeftPane";
import { LibrarySheet } from "./components/LibrarySheet";
import { NewProjectDialog } from "./components/NewProjectDialog";
import { Onboarding } from "./components/Onboarding";
import { ThemeToggle } from "./components/ThemeToggle";
import { PreviewPane } from "./components/PreviewPane";
import { SeriesDialog } from "./components/SeriesDialog";
import { SettingsDialog } from "./components/SettingsDialog";
import { VariantsDialog } from "./components/VariantsDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  BrowserEngineClient,
  type EngineEvent,
  type ProjectListing,
  type ProjectState,
  type RunState,
  type SetupState,
} from "./engine-client";

/** Fold one wire event into the feed (used for both live events and replay). */
function applyEvent(feed: FeedItem[], event: EngineEvent): FeedItem[] {
  switch (event.type) {
    case "text_delta": {
      const last = feed.at(-1);
      if (last?.kind === "text") return [...feed.slice(0, -1), { ...last, text: last.text + event.delta }];
      return [...feed, { kind: "text", text: event.delta, at: Date.now() }];
    }
    case "tool_start":
      return [...feed, { kind: "tool", tool: event.tool, args: event.args, done: false, at: Date.now() }];
    case "tool_end": {
      for (let i = feed.length - 1; i >= 0; i--) {
        const item = feed[i];
        if (item.kind === "tool" && item.tool === event.tool && !item.done) {
          const next = [...feed];
          next[i] = { ...item, summary: event.summary, done: true };
          return next;
        }
      }
      return feed;
    }
    case "error":
      return [...feed, { kind: "error", message: event.message, at: Date.now() }];
    default:
      return feed;
  }
}

export function App() {
  const client = useMemo(() => new BrowserEngineClient(), []);
  const [project, setProject] = useState<ProjectState | null>(null);
  const [bridgeError, setBridgeError] = useState<string | null>(null);
  const [runStates, setRunStates] = useState<Record<string, RunState>>({});
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [cacheKey, setCacheKey] = useState(() => Date.now());
  const [viewRound, setViewRound] = useState<number | null>(null);
  const [projects, setProjects] = useState<ProjectListing[]>([]);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [setup, setSetup] = useState<SetupState | null>(null);
  const refreshTimer = useRef<number | undefined>(undefined);
  const currentSlug = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const state = await client.getProject();
      currentSlug.current = state.slug;
      setProject(state);
      setRunStates(state.runStates);
      setBridgeError(null);
    } catch (err) {
      setBridgeError(err instanceof Error ? err.message : String(err));
    }
  }, [client]);

  const loadFeed = useCallback(
    async (slug: string | null) => {
      if (!slug) return setFeed([]);
      const events = await client.getFeed(slug);
      setFeed(events.reduce(applyEvent, [] as FeedItem[]));
    },
    [client],
  );

  useEffect(() => {
    void refresh();
    void client.listProjects().then(setProjects);
    void client.getSetup().then(setSetup).catch(() => setSetup(null));
    return client.subscribe((event: EngineEvent) => {
      switch (event.type) {
        case "hello":
          currentSlug.current = event.project;
          setRunStates(event.runStates);
          setFeed(event.replay.reduce(applyEvent, [] as FeedItem[]));
          void refresh();
          void client.listProjects().then(setProjects);
          break;
        case "text_delta":
        case "tool_start":
        case "tool_end":
        case "error":
          if (!event.project || event.project === currentSlug.current) {
            setFeed((f) => applyEvent(f, event));
          }
          break;
        case "run_state":
          setRunStates((s) => {
            const next = { ...s };
            if (event.state === "idle") delete next[event.project];
            else next[event.project] = event.state;
            return next;
          });
          void client.listProjects().then(setProjects);
          if (event.project === currentSlug.current) void refresh();
          break;
        case "project_changed":
        case "workspace_changed":
          setViewRound(null);
          setCacheKey(Date.now());
          void refresh();
          void client.listProjects().then(setProjects);
          void loadFeed("slug" in event ? event.slug : null);
          break;
        case "projects_changed":
          void refresh();
          void client.listProjects().then(setProjects);
          break;
        case "settings_changed":
          void refresh();
          break;
        case "files_changed":
          if (event.project && event.project !== currentSlug.current) break;
          window.clearTimeout(refreshTimer.current);
          refreshTimer.current = window.setTimeout(() => {
            setCacheKey(Date.now());
            void refresh();
          }, 400);
          break;
      }
    });
  }, [client, refresh, loadFeed]);

  const currentRunState: RunState = project?.slug ? (runStates[project.slug] ?? "idle") : "idle";
  const running = currentRunState === "running";

  const actions = useMemo(
    () => ({
      run: (slug?: string) =>
        client.run(slug).catch((e) => setFeed((f) => [...f, { kind: "error" as const, message: String(e), at: Date.now() }])),
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
        <h1 className="text-xl font-semibold">blueline</h1>
        <p className="max-w-md text-sm text-muted-foreground">{bridgeError}</p>
        <p className="text-sm text-muted-foreground">
          Start the bridge: <code className="rounded bg-muted px-1.5 py-0.5">cd toolkit && npm run serve</code>
        </p>
        <Button variant="outline" size="sm" onClick={() => void refresh()}>
          Retry
        </Button>
      </div>
    );
  }
  if (!project) return <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">loading…</div>;

  if (setup?.fresh) {
    return (
      <Onboarding
        client={client}
        setup={setup}
        onDone={() => {
          void client.getSetup().then(setSetup).catch(() => setSetup(null));
          void refresh();
        }}
      />
    );
  }

  if (!project.slug) {
    return <HomeScreen client={client} workspaceRoot={project.workspaceRoot} projects={projects} />;
  }

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b px-4">
        <img src={logo} alt="" className="size-6" />
        <span className="text-sm font-semibold tracking-tight">blueline</span>
        <LibrarySheet
          client={client}
          projects={projects}
          currentSlug={project.slug}
          currentName={project.meta?.displayName ?? project.slug}
          workspaceRoot={project.workspaceRoot}
          onNewProject={() => setNewProjectOpen(true)}
          onError={(message) => setFeed((f) => [...f, { kind: "error", message, at: Date.now() }])}
        />
        {project.meta?.series && (
          <Badge variant="outline" className="max-w-40 truncate text-xs" title={`Series: ${project.meta.series}`}>
            {project.meta.series}
          </Badge>
        )}
        {running && <Badge variant="secondary" className="animate-pulse">running</Badge>}
        {currentRunState === "queued" && (
          <Badge variant="outline">
            <Timer data-slot="icon" /> queued
          </Badge>
        )}
        <div className="flex-1" />
        <Badge variant="outline" className="font-mono text-xs">{project.designerModel}</Badge>
        <Button size="sm" disabled={currentRunState !== "idle"} onClick={() => void actions.run()}>
          <Play data-slot="icon" /> Run
        </Button>
        <VariantsDialog client={client} slug={project.slug} />
        <SeriesDialog
          client={client}
          slug={project.slug}
          defaultRootName={project.meta?.series ?? project.meta?.displayName ?? project.slug}
          hasPage={project.hasPage}
        />
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
        <ThemeToggle />
        <SettingsDialog client={client} />
        <NewProjectDialog client={client} open={newProjectOpen} onOpenChange={setNewProjectOpen} />
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-[260px_minmax(0,1fr)_340px] grid-rows-1 overflow-hidden">
        <LeftPane project={project} client={client} cacheKey={cacheKey} viewRound={viewRound} onViewRound={setViewRound} />
        <PreviewPane project={project} client={client} cacheKey={cacheKey} actions={actions} viewRound={viewRound} onViewRound={setViewRound} />
        <AgentPane feed={feed} running={running} onChat={(t) => void actions.chat(t)} />
      </div>
    </div>
  );
}
