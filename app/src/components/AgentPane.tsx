import {
  ChevronRight,
  CircleX,
  Download,
  Hammer,
  Image as ImageIcon,
  Loader2,
  Pencil,
  Printer,
  ScanEye,
  SendHorizontal,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export type FeedItem =
  | { kind: "text"; text: string; at: number }
  | { kind: "tool"; tool: string; args: Record<string, unknown>; summary?: string; done: boolean; at: number }
  | { kind: "error"; message: string; at: number };

function ToolIcon({ tool, className }: { tool: string; className?: string }) {
  const cls = className ?? "size-3.5";
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

/** The one argument worth showing inline for each tool. */
function salientArg(args: Record<string, unknown>): string {
  for (const key of ["path", "url", "pattern", "ids", "text"]) {
    const v = args[key];
    if (typeof v === "string") return v.replace(/^\/Users\/[^/]+\/[^ ]*?(context|styles|projects)\//, "$1/");
    if (Array.isArray(v)) return v.join(", ");
  }
  const first = Object.values(args)[0];
  return typeof first === "string" ? first.slice(0, 80) : "";
}

function reviewBadge(summary: string): { label: string; pass: boolean } | null {
  const verdict = /"verdict":\s*"(\w+)"/.exec(summary)?.[1];
  if (!verdict) return null;
  const round = /round (\d+\/\d+)/.exec(summary)?.[1];
  const issues = (summary.match(/"problem"/g) ?? []).length;
  return {
    label: verdict === "pass" ? `Review ${round ?? ""} — pass` : `Review ${round ?? ""} — ${issues} issue${issues === 1 ? "" : "s"}`,
    pass: verdict === "pass",
  };
}

function ToolRow({ item }: { item: Extract<FeedItem, { kind: "tool" }> }) {
  const [expanded, setExpanded] = useState(false);
  const argsJson = JSON.stringify(item.args ?? {}, null, 2);
  const hasDetail = argsJson !== "{}" || !!item.summary;
  const badge = item.tool === "review" && item.summary ? reviewBadge(item.summary) : null;

  return (
    <div className="rounded-md border bg-muted/30">
      <button
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left font-mono text-xs"
        onClick={() => hasDetail && setExpanded(!expanded)}
      >
        {hasDetail ? (
          <ChevronRight className={cn("size-3 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-90")} />
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <ToolIcon tool={item.tool} className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-medium">{item.tool}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground" title={salientArg(item.args ?? {})}>
          {salientArg(item.args ?? {})}
        </span>
        {!item.done && <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />}
        {badge && (
          <span
            className={cn(
              "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold",
              badge.pass
                ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                : "bg-amber-500/15 text-amber-600 dark:text-amber-400",
            )}
          >
            {badge.label}
          </span>
        )}
      </button>
      {expanded && (
        <div className="space-y-2 border-t px-2 py-2">
          {argsJson !== "{}" && (
            <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap break-all rounded bg-muted/50 p-2 font-mono text-[10.5px] leading-relaxed">
              {argsJson}
            </pre>
          )}
          {item.summary && (
            <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words rounded bg-muted/50 p-2 font-mono text-[10.5px] leading-relaxed">
              {item.summary}
            </pre>
          )}
        </div>
      )}
    </div>
  );
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
  const pinned = useRef(true);

  useEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
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
      <div
        ref={scroller}
        className="flex-1 space-y-1.5 overflow-y-auto p-3 text-sm"
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
      >
        {feed.map((item, i) => {
          switch (item.kind) {
            case "text":
              return (
                <p key={i} className="whitespace-pre-wrap px-1 py-0.5 leading-relaxed">
                  {item.text}
                </p>
              );
            case "tool":
              return <ToolRow key={i} item={item} />;
            case "error":
              return (
                <p key={i} className="flex items-start gap-1.5 px-1 text-xs text-destructive">
                  <CircleX className="mt-0.5 size-3.5 shrink-0" /> <span className="break-words">{item.message}</span>
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
