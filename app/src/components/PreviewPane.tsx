import { ChevronLeft, ChevronRight, History, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { EngineClient, ProjectState } from "../engine-client";

type Mode = "proof" | "live";

interface Actions {
  updateCopy(pcId: string, text: string): Promise<void>;
  selectVariant(id: string, v: number): Promise<void>;
  render(): Promise<void>;
}

export function PreviewPane({
  project,
  client,
  cacheKey,
  actions,
  viewRound,
  onViewRound,
}: {
  project: ProjectState;
  client: EngineClient;
  cacheKey: number;
  actions: Actions;
  viewRound: number | null;
  onViewRound: (round: number | null) => void;
}) {
  const [mode, setMode] = useState<Mode>("proof");
  const [pageCount, setPageCount] = useState(0);
  const [page, setPage] = useState(0);
  const [dirty, setDirty] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const roundInfo = viewRound != null ? project.rounds.find((r) => r.round === viewRound) : undefined;
  const roundHasProof = roundInfo?.hasProof ?? false;
  const proofRound = viewRound != null && roundHasProof ? viewRound : undefined;

  // Viewing a historical round forces proof mode (there is no historical live HTML).
  useEffect(() => {
    if (viewRound != null) setMode("proof");
  }, [viewRound]);

  useEffect(() => {
    if (viewRound != null && !roundHasProof) return setPageCount(0);
    if (viewRound == null && !project.hasProof) return setPageCount(0);
    client.proofMeta(proofRound).then(({ pages }) => {
      setPageCount(pages);
      setPage((p) => Math.min(p, Math.max(0, pages - 1)));
    });
  }, [client, cacheKey, project.hasProof, proofRound, roundHasProof, viewRound]);

  const armLiveEditing = () => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;
    const style = doc.createElement("style");
    style.textContent = `
      [data-pc-id]:hover { outline: 2px dashed rgba(120,120,255,.7); outline-offset: 2px; cursor: text; }
      [data-pc-id]:focus { outline: 2px solid rgba(120,120,255,.95); outline-offset: 2px; }
    `;
    doc.head.appendChild(style);
    doc.querySelectorAll<HTMLElement>("[data-pc-id]").forEach((el) => {
      el.addEventListener("click", (ev) => {
        ev.preventDefault();
        el.setAttribute("contenteditable", "plaintext-only");
        el.focus();
      });
      el.addEventListener("blur", () => {
        el.removeAttribute("contenteditable");
        const pcId = el.getAttribute("data-pc-id")!;
        void actions.updateCopy(pcId, el.textContent ?? "").then(() => setDirty(true));
      });
    });
  };

  if (!project.hasPage) {
    return (
      <main className="flex items-center justify-center bg-muted/30">
        <p className="text-sm text-muted-foreground">
          No page yet — hit <strong>Run</strong> to let the agent draft the piece.
        </p>
      </main>
    );
  }

  return (
    <main className="flex min-h-0 min-w-0 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-3 border-b px-3">
        <Tabs value={mode} onValueChange={(v) => setMode(v as Mode)}>
          <TabsList className="h-8">
            <TabsTrigger value="proof" className="text-xs">Proof</TabsTrigger>
            <TabsTrigger value="live" className="text-xs" disabled={viewRound != null}>
              Live edit
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {viewRound != null && (
          <div className="flex items-center gap-2 rounded-md border bg-muted/60 px-2 py-1 text-xs">
            <History className="size-3.5" />
            Viewing round {viewRound}
            <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => onViewRound(null)}>
              Back to latest
            </Button>
          </div>
        )}

        <div className="flex-1" />

        {mode === "proof" && pageCount > 1 && (
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <Button variant="ghost" size="icon-sm" disabled={page === 0} onClick={() => setPage(page - 1)}>
              <ChevronLeft />
            </Button>
            {page + 1} / {pageCount}
            <Button variant="ghost" size="icon-sm" disabled={page >= pageCount - 1} onClick={() => setPage(page + 1)}>
              <ChevronRight />
            </Button>
          </div>
        )}

        {dirty && viewRound == null && (
          <Button size="sm" variant="secondary" className="h-7 text-xs" onClick={() => void actions.render().then(() => setDirty(false))}>
            <RefreshCw data-slot="icon" /> Changes not in proof — re-render
          </Button>
        )}
      </div>

      <div className="flex flex-1 items-start justify-center overflow-auto bg-muted/30 p-6">
        {mode === "proof" ? (
          viewRound != null && !roundHasProof ? (
            <p className="text-sm text-muted-foreground">
              No archived proof for round {viewRound} (older run) — its issues are listed on the left.
            </p>
          ) : pageCount > 0 ? (
            <img
              className="h-auto max-w-full rounded-sm bg-white shadow-lg ring-1 ring-black/10"
              src={client.proofPageUrl(page, cacheKey, proofRound)}
              alt={`proof page ${page + 1}`}
            />
          ) : (
            <p className="text-sm text-muted-foreground">No proof yet — re-render or run.</p>
          )
        ) : (
          <iframe
            ref={iframeRef}
            title="live preview"
            className="min-h-[297mm] w-[210mm] rounded-sm border-0 bg-white shadow-lg ring-1 ring-black/10"
            src={client.fileUrl("page.html", cacheKey)}
            onLoad={armLiveEditing}
          />
        )}
      </div>

      {project.images.length > 0 && viewRound == null && (
        <div className="flex shrink-0 items-center gap-6 overflow-x-auto border-t px-4 py-2">
          {project.images.map((slot) => (
            <div key={slot.id} className="flex items-center gap-1.5 text-xs">
              <span className="font-mono text-muted-foreground">{slot.id}</span>
              <Button
                variant="outline"
                size="icon-sm"
                className="size-6"
                disabled={!slot.current || slot.current <= Math.min(...slot.variants)}
                onClick={() => void actions.selectVariant(slot.id, slot.current! - 1).then(() => setDirty(true))}
              >
                <ChevronLeft />
              </Button>
              <span className="tabular-nums">
                v{slot.current ?? "?"} / {slot.variants.length}
              </span>
              <Button
                variant="outline"
                size="icon-sm"
                className="size-6"
                disabled={!slot.current || slot.current >= Math.max(...slot.variants)}
                onClick={() => void actions.selectVariant(slot.id, slot.current! + 1).then(() => setDirty(true))}
              >
                <ChevronRight />
              </Button>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
