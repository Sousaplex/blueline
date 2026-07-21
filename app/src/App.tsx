import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentPane, type FeedItem } from "./components/AgentPane";
import { LeftPane } from "./components/LeftPane";
import { PreviewPane } from "./components/PreviewPane";
import { BrowserEngineClient, type EngineEvent, type ProjectState } from "./engine-client";

export function App() {
  const client = useMemo(() => new BrowserEngineClient(), []);
  const [project, setProject] = useState<ProjectState | null>(null);
  const [bridgeError, setBridgeError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [cacheKey, setCacheKey] = useState(() => Date.now());
  const [selectedRound, setSelectedRound] = useState<number | null>(null);
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
            if (last?.kind === "text") {
              return [...f.slice(0, -1), { ...last, text: last.text + event.delta }];
            }
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
        case "files_changed":
          // debounce bursts of file changes into one refresh + preview reload
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
      <div className="bridge-error">
        <h1>presscheck</h1>
        <p>{bridgeError}</p>
        <p className="hint">
          Start the bridge: <code>cd toolkit && npm run serve -- projects/demo</code>
        </p>
        <button onClick={() => void refresh()}>Retry</button>
      </div>
    );
  }
  if (!project) return <div className="bridge-error">loading…</div>;

  return (
    <div className="workspace">
      <header className="topbar">
        <span className="brand">● presscheck</span>
        <span className="project-name">▸ {project.slug}</span>
        <span className="spacer" />
        <span className="engine-chip">Engine: {project.designerModel}</span>
        <button className="primary" disabled={running} onClick={() => void actions.run()}>
          {running ? "Running…" : "Run ▶"}
        </button>
        <button disabled={!project.hasPage} onClick={() => void actions.render()}>
          Re-render ⎙
        </button>
      </header>
      <div className="panes">
        <LeftPane project={project} selectedRound={selectedRound} onSelectRound={setSelectedRound} />
        <PreviewPane project={project} client={client} cacheKey={cacheKey} actions={actions} />
        <AgentPane feed={feed} running={running} onChat={(t) => void actions.chat(t)} />
      </div>
    </div>
  );
}
