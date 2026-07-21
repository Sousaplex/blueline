import { CircleX, Download, Hammer, Image as ImageIcon, Pencil, Printer, ScanEye, SendHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export type FeedItem =
  | { kind: "text"; text: string; at: number }
  | { kind: "tool"; tool: string; args: Record<string, unknown>; at: number }
  | { kind: "tool_result"; tool: string; summary: string; at: number }
  | { kind: "error"; message: string; at: number };

function ToolIcon({ tool }: { tool: string }) {
  const cls = "size-3.5";
  switch (tool) {
    case "render": return <Printer className={cls} />;
    case "review": return <ScanEye className={cls} />;
    case "gen_images": return <ImageIcon className={cls} />;
    case "web_fetch": return <Download className={cls} />;
    case "write":
    case "edit": return <Pencil className={cls} />;
    default: return <Hammer className={cls} />;
  }
}

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
    <aside className="flex h-full min-h-0 flex-col overflow-hidden border-l">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b px-4">
        <h3 className="text-sm font-medium">Agent</h3>
        <span
          className={cn("size-2 rounded-full", running ? "animate-pulse bg-emerald-500" : "bg-muted-foreground/40")}
          title={running ? "running" : "idle"}
        />
      </div>
      <div ref={scroller} className="flex-1 space-y-2 overflow-y-auto p-4 text-sm">
        {feed.map((item, i) => {
          switch (item.kind) {
            case "text":
              return (
                <p key={i} className="whitespace-pre-wrap leading-relaxed">
                  {item.text}
                </p>
              );
            case "tool":
              return (
                <div key={i} className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
                  <ToolIcon tool={item.tool} />
                  {item.tool}
                  <span className="truncate opacity-70">{compactArgs(item.args)}</span>
                </div>
              );
            case "tool_result":
              return item.tool === "review" ? (
                <p key={i} className="text-xs font-medium">
                  {reviewSummary(item.summary)}
                </p>
              ) : null;
            case "error":
              return (
                <p key={i} className="flex items-center gap-1.5 text-xs text-destructive">
                  <CircleX className="size-3.5" /> {item.message}
                </p>
              );
          }
        })}
        {!feed.length && (
          <p className="text-sm text-muted-foreground">
            No activity yet. <strong>Run</strong> starts the design loop; type below to steer.
          </p>
        )}
      </div>
      <div className="flex shrink-0 gap-2 border-t p-3">
        <Input
          value={draft}
          placeholder={running ? "steer the agent…" : 'e.g. "make the headline punchier"'}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
        />
        <Button size="icon" variant="secondary" onClick={send} disabled={!draft.trim()}>
          <SendHorizontal />
        </Button>
      </div>
    </aside>
  );
}

function compactArgs(args: Record<string, unknown>): string {
  const s = JSON.stringify(args);
  if (s === "{}") return "";
  return s.length > 48 ? ` ${s.slice(0, 48)}…` : ` ${s}`;
}

function reviewSummary(summary: string): string {
  const verdict = /"verdict":\s*"(\w+)"/.exec(summary)?.[1];
  const issueCount = (summary.match(/"problem"/g) ?? []).length;
  const round = /round (\d+\/\d+)/.exec(summary)?.[1];
  if (!verdict) return summary.slice(0, 120);
  return verdict === "pass" ? `✅ Review ${round ?? ""}: pass` : `✏️ Review ${round ?? ""}: revise — ${issueCount} issue(s)`;
}
