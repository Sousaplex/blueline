import { Download, Play, RefreshCw, Square, Timer } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import logo from "./assets/logo.png";
import { type FeedItem } from "./components/AgentPane";
import { ChatFab } from "./components/ChatFab";
import { DocumentTabs } from "./components/DocumentTabs";
import { AboutDialog } from "./components/AboutDialog";
import { HomeScreen } from "./components/HomeScreen";
import { InspectorPane } from "./components/InspectorPane";
import { LayersPanel } from "./components/LayersPanel";
import { LeftPane } from "./components/LeftPane";
import { LibrarySheet } from "./components/LibrarySheet";
import { NewProjectDialog } from "./components/NewProjectDialog";
import { Onboarding } from "./components/Onboarding";
import { ThemeToggle } from "./components/ThemeToggle";
import { PreviewPane } from "./components/PreviewPane";
import { SeriesDialog } from "./components/SeriesDialog";
import { SettingsDialog } from "./components/SettingsDialog";
import { VariantsDialog } from "./components/VariantsDialog";
import { Toaster, toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { currentTheme } from "@/lib/theme";
import {
  BrowserEngineClient,
  type ContextUsage,
  type EngineEvent,
  type ProjectListing,
  type ProjectState,
  type RunState,
  type SetupState,
  type SystemEvent,
} from "./engine-client";
import type { AlignOp, LayerItem, SelectionInfo } from "./selection";

/** Fold one wire event into the feed (used for both live events and replay). */
function applyEvent(feed: FeedItem[], event: EngineEvent): FeedItem[] {
  switch (event.type) {
    case "chat":
      return [...feed, { kind: "user", text: event.text, at: Date.now() }];
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
    case "run_cost":
      return [
        ...feed,
        {
          kind: "cost",
          total: event.total,
          designer: event.designer,
          images: event.images,
          imageCount: event.imageCount,
          review: event.review,
          search: event.search,
          at: Date.now(),
        },
      ];
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
  const [systemFeed, setSystemFeed] = useState<SystemEvent[]>([]);
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null);
  const [selection, setSelection] = useState<SelectionInfo | null>(null);
  const [deleteRequestIds, setDeleteRequestIds] = useState<string[] | null>(null);
  const [variantsOpen, setVariantsOpen] = useState(false);
  const [seriesOpen, setSeriesOpen] = useState(false);
  const alignFn = useRef<((op: AlignOp) => void) | null>(null);
  const applyPropsFn = useRef<((id: string, props: Record<string, string>) => void) | null>(null);
  const setPositionFn = useRef<((id: string, x: number, y: number, marginTop: number | null) => void) | null>(null);
  const selectLayerFn = useRef<((id: string) => void) | null>(null);
  const [layers, setLayers] = useState<LayerItem[]>([]);
  const clearSelectionFn = useRef<(() => void) | null>(null);
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
      if (!slug) {
        setContextUsage(null);
        return setFeed([]);
      }
      const events = await client.getFeed(slug);
      setFeed(events.reduce(applyEvent, [] as FeedItem[]));
      // Seed the context meter from the live session (context_usage events aren't buffered).
      void client.getSessionStats(slug).then((s) => setContextUsage(s.contextUsage)).catch(() => setContextUsage(null));
    },
    [client],
  );

  useEffect(() => {
    void refresh();
    void client.listProjects().then(setProjects);
    void client.getSetup().then(setSetup).catch(() => setSetup(null));
    void client.getSystemEvents().then(setSystemFeed).catch(() => {});
    return client.subscribe((event: EngineEvent) => {
      switch (event.type) {
        case "system":
          setSystemFeed((f) => [...f.slice(-299), event]);
          break;
        case "hello":
          currentSlug.current = event.project;
          setRunStates(event.runStates);
          setFeed(event.replay.reduce(applyEvent, [] as FeedItem[]));
          if (event.project) {
            void client.getSessionStats(event.project).then((s) => setContextUsage(s.contextUsage)).catch(() => {});
          } else {
            setContextUsage(null);
          }
          void refresh();
          void client.listProjects().then(setProjects);
          break;
        case "chat":
        case "text_delta":
        case "tool_start":
        case "tool_end":
        case "error":
        case "run_cost":
          if (!event.project || event.project === currentSlug.current) {
            setFeed((f) => applyEvent(f, event));
          }
          break;
        case "context_usage":
          if (!event.project || event.project === currentSlug.current) {
            setContextUsage({ tokens: event.tokens, contextWindow: event.contextWindow, percent: event.percent });
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
      chat: (text: string) => {
        setViewRound(null); // steering acts on the LATEST state — a historical proof would hide the result
        return client.chat(text);
      },
      render: () => client.render(),
      cancel: (slug?: string) =>
        client.cancelRun(slug).catch((e) => setFeed((f) => [...f, { kind: "error" as const, message: String(e), at: Date.now() }])),
      updateCopy: (pcId: string, text: string) => client.updateCopy(pcId, text),
      selectVariant: (id: string, v: number) => client.selectVariant(id, v),
    }),
    [client],
  );

  const exportArchive = useCallback(
    (kind: "file" | "project") => {
      const slug = currentSlug.current;
      if (!slug) return;
      void client
        .exportArchive(slug, kind)
        .then(({ path, filename }) => {
          if (path) {
            setFeed((f) => [...f, { kind: "export", path, at: Date.now() }]);
            toast(kind === "project" ? "Project exported" : "Document exported", { description: filename });
          } else {
            toast("Downloaded", { description: filename });
          }
        })
        .catch((e) => toast.error("Export failed", { description: String(e) }));
    },
    [client],
  );

  const [aboutOpen, setAboutOpen] = useState(false);

  // Resizable left column — file names in Sources/Brand can be longer than the default width.
  const gridRef = useRef<HTMLDivElement>(null);
  const [leftWidth, setLeftWidth] = useState(() => {
    const s = Number(localStorage.getItem("bl-left-width"));
    return s >= 240 && s <= 640 ? s : 300;
  });
  useEffect(() => {
    localStorage.setItem("bl-left-width", String(leftWidth));
  }, [leftWidth]);
  const startLeftResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const left = gridRef.current?.getBoundingClientRect().left ?? 0;
    const onMove = (ev: MouseEvent) => setLeftWidth(Math.max(240, Math.min(640, ev.clientX - left)));
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
    };
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };
  // In the packaged app the OS title bar is hidden (titleBarStyle: hiddenInset), so
  // mark the root frameless — global CSS then makes the top bars draggable and pads
  // them to clear the traffic lights. No-op in the browser dev server.
  useEffect(() => {
    if (typeof window !== "undefined" && window.blueline) {
      document.documentElement.classList.add("frameless");
    }
  }, []);

  // Auto-update: notify (never silently download). The user approves the download,
  // then approves the restart. Wired to the main-process electron-updater events.
  useEffect(() => {
    const bl = typeof window !== "undefined" ? window.blueline : undefined;
    if (!bl?.onUpdateAvailable) return;
    const offs = [
      bl.onUpdateAvailable((version) =>
        toast(`Blueline ${version} is available`, {
          description: "A new version is ready to download.",
          duration: Infinity,
          action: {
            label: "Download",
            onClick: () => {
              void bl.downloadUpdate();
              toast.loading("Downloading update…", { id: "bl-update-dl", duration: Infinity });
            },
          },
        }),
      ),
      bl.onUpdateProgress((percent) =>
        toast.loading(`Downloading update… ${percent}%`, { id: "bl-update-dl", duration: Infinity }),
      ),
      bl.onUpdateDownloaded((version) => {
        toast.dismiss("bl-update-dl");
        toast.success(`Blueline ${version} ready`, {
          description: "Restart to finish updating.",
          duration: Infinity,
          action: { label: "Restart now", onClick: () => void bl.installUpdate() },
        });
      }),
      // Failures used to be silent (console-only) — now the user sees why nothing happened.
      bl.onUpdateError?.((message) => {
        toast.dismiss("bl-update-dl");
        toast.error("Update failed", { description: message, duration: 12000 });
      }) ?? (() => {}),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  if (bridgeError) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 text-center">
        <h1 className="text-xl font-semibold">Blueline</h1>
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
      <Toaster position="bottom-center" theme={currentTheme()} toastOptions={{ style: { fontSize: "13px" } }} />
      <header className="relative flex h-12 shrink-0 items-center gap-3 border-b px-4">
        <button
          type="button"
          onClick={() => setAboutOpen(true)}
          title="About Blueline"
          aria-label="About Blueline"
          className="-m-1 rounded p-1 hover:bg-accent"
        >
          <img src={logo} alt="" className="size-6" />
        </button>
        <span className="text-sm font-semibold tracking-tight">Blueline</span>
        <button
          type="button"
          onClick={() => setAboutOpen(true)}
          title={`built ${__BUILD_TIME__} — click for changelog`}
          className="font-mono text-[10px] text-muted-foreground hover:text-foreground"
        >
          v{__APP_VERSION__}
        </button>
        {running && (
          <div className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden">
            <div className="pc-indeterminate h-full w-1/3 rounded-full bg-blue-500" />
          </div>
        )}
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
        {currentRunState === "idle" ? (
          <Button size="sm" onClick={() => void actions.run()}>
            <Play data-slot="icon" /> Run
          </Button>
        ) : (
          <Button size="sm" variant="destructive" onClick={() => void actions.cancel()}>
            <Square data-slot="icon" /> Cancel
          </Button>
        )}
        <Button size="sm" variant="outline" disabled={!project.hasPage} onClick={() => void actions.render()}>
          <RefreshCw data-slot="icon" /> Re-render
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!project.hasProof}
          onClick={() =>
            void client.exportPdf().then((path) => {
              if (!path) return;
              setFeed((f) => [...f, { kind: "export", path, at: Date.now() }]);
              toast("PDF exported", {
                description: path.split("/").pop(),
                action: window.blueline ? { label: "Show in Finder", onClick: () => void window.blueline!.revealInFinder(path) } : undefined,
              });
            })
          }
        >
          <Download data-slot="icon" /> Export
        </Button>
        <ThemeToggle />
        <SettingsDialog client={client} />
        <NewProjectDialog client={client} open={newProjectOpen} onOpenChange={setNewProjectOpen} />
        <AboutDialog open={aboutOpen} onOpenChange={setAboutOpen} />
      </header>
      <DocumentTabs
        projects={projects}
        currentSlug={project.slug}
        hasPage={project.hasPage}
        onOpen={(dir) => void client.openProject(dir).catch((e) => setFeed((f) => [...f, { kind: "error", message: String(e), at: Date.now() }]))}
        onDelete={(slug) => void client.deleteProject(slug).catch((e) => setFeed((f) => [...f, { kind: "error", message: String(e), at: Date.now() }]))}
        onNewVariants={() => setVariantsOpen(true)}
        onNewSeries={() => setSeriesOpen(true)}
        onBranch={() => void client.forkProject(project.slug!).catch((e) => setFeed((f) => [...f, { kind: "error", message: String(e), at: Date.now() }]))}
        onNewProject={() => setNewProjectOpen(true)}
        onExportFile={() => exportArchive("file")}
        onExportProject={() => exportArchive("project")}
      />
      <VariantsDialog client={client} slug={project.slug} open={variantsOpen} onOpenChange={setVariantsOpen} />
      <SeriesDialog
        client={client}
        slug={project.slug}
        defaultRootName={project.meta?.series ?? project.meta?.displayName ?? project.slug}
        open={seriesOpen}
        onOpenChange={setSeriesOpen}
      />
      <div
        ref={gridRef}
        className="relative grid min-h-0 flex-1 grid-rows-1 overflow-hidden"
        style={{ gridTemplateColumns: `${leftWidth}px minmax(0,1fr) 340px` }}
      >
        <LeftPane project={project} client={client} cacheKey={cacheKey} viewRound={viewRound} onViewRound={setViewRound} />
        <div
          onMouseDown={startLeftResize}
          onDoubleClick={() => setLeftWidth(300)}
          className="absolute top-0 z-20 h-full w-1.5 -translate-x-1/2 cursor-col-resize transition-colors hover:bg-primary/40"
          style={{ left: leftWidth }}
          title="Drag to resize · double-click to reset"
        />
        <PreviewPane
          project={project}
          client={client}
          cacheKey={cacheKey}
          actions={actions}
          runState={currentRunState}
          viewRound={viewRound}
          onViewRound={setViewRound}
          onSelect={setSelection}
          onRequestDelete={setDeleteRequestIds}
          onLayers={setLayers}
          registerAlign={(fn) => (alignFn.current = fn)}
          registerApplyProps={(fn) => (applyPropsFn.current = fn)}
          registerSetPosition={(fn) => (setPositionFn.current = fn)}
          registerSelectLayer={(fn) => (selectLayerFn.current = fn)}
          registerClearSelection={(fn) => (clearSelectionFn.current = fn)}
        />
        <div className="flex h-full min-h-0 flex-col overflow-hidden border-l">
          <InspectorPane
            selection={selection}
            project={project}
            client={client}
            deleteRequestIds={deleteRequestIds}
            onDeleteHandled={() => setDeleteRequestIds(null)}
            onDeselect={() => {
              // Drop the canvas selection too — it freezes the live iframe, and a
              // stale freeze after a delete makes the removed element look immortal.
              clearSelectionFn.current?.();
              setSelection(null);
            }}
            onAlign={(op) => alignFn.current?.(op)}
            applyProps={(id, props) => applyPropsFn.current?.(id, props)}
            setPosition={(id, x, y, mt) => setPositionFn.current?.(id, x, y, mt)}
          />
          <div className="min-h-0 flex-1 border-t">
            <LayersPanel
              layers={layers}
              selectedId={selection && selection.kind !== "multi" ? selection.id : null}
              client={client}
              onSelect={(id) => selectLayerFn.current?.(id)}
              onReordered={() => {
                // Drop the canvas selection so the frozen iframe reloads with the new order
                // (and the Layers panel re-emits). The ws files_changed already bumped cacheKey.
                clearSelectionFn.current?.();
                setSelection(null);
              }}
            />
          </div>
        </div>
      </div>
      <ChatFab
        feed={feed}
        systemFeed={systemFeed}
        running={running}
        onChat={(t) => void actions.chat(t)}
        contextUsage={contextUsage}
        onExportSession={() => {
          const slug = project?.slug;
          if (!slug) return;
          void client
            .exportSession(slug, "json")
            .then(({ path }) => {
              if (path) {
                setFeed((f) => [...f, { kind: "export", path, at: Date.now() }]);
                toast("Conversation exported", { description: path.split("/").pop() });
              } else {
                toast("Conversation downloaded", { description: `blueline-session-${slug}.json` });
              }
            })
            .catch((e) => toast.error("Export failed", { description: String(e) }));
        }}
      />
    </div>
  );
}
