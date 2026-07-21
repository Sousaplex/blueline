import { useEffect, useRef, useState } from "react";

export type FeedItem =
  | { kind: "text"; text: string; at: number }
  | { kind: "tool"; tool: string; args: Record<string, unknown>; at: number }
  | { kind: "tool_result"; tool: string; summary: string; at: number }
  | { kind: "error"; message: string; at: number };

const TOOL_ICONS: Record<string, string> = {
  render: "⎙",
  review: "✓",
  gen_images: "▣",
  web_fetch: "⇩",
  read: "▤",
  write: "✎",
  edit: "✎",
};

export function AgentPane({
  feed,
  running,
  onChat,
}: {
  feed: FeedItem[];
  running: boolean;
  onChat: (text: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [feed]);

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    onChat(text);
    setDraft("");
  };

  return (
    <aside className="agent-pane">
      <div className="agent-header">
        <h3>Agent</h3>
        <span className={`status-dot ${running ? "running" : "idle"}`} title={running ? "running" : "idle"} />
      </div>
      <div className="agent-feed" ref={scroller}>
        {feed.map((item, i) => {
          switch (item.kind) {
            case "text":
              return (
                <div className="feed-text" key={i}>
                  {item.text}
                </div>
              );
            case "tool":
              return (
                <div className="feed-tool" key={i}>
                  {TOOL_ICONS[item.tool] ?? "⚙"} {item.tool}
                  <span className="tool-args">{compactArgs(item.args)}</span>
                </div>
              );
            case "tool_result":
              return item.tool === "review" ? (
                <div className="feed-review" key={i}>
                  {reviewSummary(item.summary)}
                </div>
              ) : null;
            case "error":
              return (
                <div className="feed-error" key={i}>
                  ✗ {item.message}
                </div>
              );
          }
        })}
        {!feed.length && <p className="dim">No activity yet. Run ▶ starts the design loop; type below to steer.</p>}
      </div>
      <div className="chat-box">
        <input
          value={draft}
          placeholder={running ? "steer the agent…" : 'e.g. "make the headline punchier"'}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
        />
        <button onClick={send} disabled={!draft.trim()}>
          Send
        </button>
      </div>
    </aside>
  );
}

function compactArgs(args: Record<string, unknown>): string {
  const s = JSON.stringify(args);
  if (s === "{}") return "";
  return s.length > 60 ? ` ${s.slice(0, 60)}…` : ` ${s}`;
}

function reviewSummary(summary: string): string {
  const verdict = /"verdict":\s*"(\w+)"/.exec(summary)?.[1];
  const issueCount = (summary.match(/"problem"/g) ?? []).length;
  const round = /round (\d+\/\d+)/.exec(summary)?.[1];
  if (!verdict) return summary.slice(0, 120);
  return verdict === "pass"
    ? `✅ Review ${round ?? ""}: PASS`
    : `✏ Review ${round ?? ""}: revise — ${issueCount} issue(s)`;
}
