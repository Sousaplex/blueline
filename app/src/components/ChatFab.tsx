// Chat as a bottom-right floating action button (docs/layer-model.md slice 5). Frees the
// right rail for the property + layers panels; the agent chat opens on demand.
import { MessageSquare, X } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import type { ContextUsage, SystemEvent } from "../engine-client";
import { AgentPane, type FeedItem } from "./AgentPane";

export function ChatFab({ feed, systemFeed, running, onChat, contextUsage, onExportSession }: {
  feed: FeedItem[];
  systemFeed: SystemEvent[];
  running: boolean;
  onChat: (text: string) => void;
  contextUsage?: ContextUsage | null;
  onExportSession?: () => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      {open && (
        <div className="fixed bottom-20 right-4 z-50 flex h-[min(560px,70vh)] w-[380px] flex-col overflow-hidden rounded-xl border bg-background shadow-2xl">
          <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
            <MessageSquare className="size-3.5 text-primary" />
            <span className="text-xs font-medium">Agent</span>
            {running && <span className="size-1.5 animate-pulse rounded-full bg-primary" />}
            <div className="flex-1" />
            <button className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => setOpen(false)} title="Close chat">
              <X className="size-3.5" />
            </button>
          </div>
          <div className="min-h-0 flex-1">
            <AgentPane feed={feed} systemFeed={systemFeed} running={running} onChat={onChat} contextUsage={contextUsage} onExportSession={onExportSession} />
          </div>
        </div>
      )}
      <button
        onClick={() => setOpen((v) => !v)}
        title={open ? "Hide agent chat" : "Open agent chat"}
        className={cn(
          "fixed bottom-4 right-4 z-50 flex size-12 items-center justify-center rounded-full text-primary-foreground shadow-lg transition-transform hover:scale-105",
          open ? "bg-muted-foreground" : "bg-primary",
        )}
      >
        {open ? <X className="size-5" /> : <MessageSquare className="size-5" />}
        {!open && running && (
          <span className="absolute right-0 top-0 size-3 animate-pulse rounded-full border-2 border-background bg-emerald-500" />
        )}
      </button>
    </>
  );
}
