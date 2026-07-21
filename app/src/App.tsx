import { Play, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentPane, type FeedItem } from "./components/AgentPane";
import { LeftPane } from "./components/LeftPane";
import { PreviewPane } from "./components/PreviewPane";
import { SettingsDialog } from "./components/SettingsDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { BrowserEngineClient, type EngineEvent, type ProjectState } from "./engine-client";

export function App() {
  const client = useMemo(() => new BrowserEngineClient(), []);
  const [project, setProject] = useState<ProjectState | null>(null);
  const [bridgeError, setBridgeError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [cacheKey, setCacheKey] = useState(() => Date.now());
  const [viewRound, setViewRound] = useState<number | null>(null); // null = latest
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

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b px-4">
        <span className="text-sm font-semibold tracking-tight">presscheck</span>
        <span className="text-sm text-muted-foreground">/ {project.slug}</span>
        {running && <Badge variant="secondary" className="animate-pulse">running</Badge>}
        <div className="flex-1" />
        <Badge variant="outline" className="font-mono text-xs">{project.designerModel}</Badge>
        <Button size="sm" disabled={running} onClick={() => void actions.run()}>
          <Play data-slot="icon" /> Run
        </Button>
        <Button size="sm" variant="outline" disabled={!project.hasPage} onClick={() => void actions.render()}>
          <RefreshCw data-slot="icon" /> Re-render
        </Button>
        <SettingsDialog client={client} />
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
