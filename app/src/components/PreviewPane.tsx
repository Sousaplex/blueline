import { ChevronLeft, ChevronRight, History, ImagePlus, Loader2, Minus, Move, Plus, RefreshCw, RotateCcw, Sparkles, Type, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { EngineClient, ProjectState } from "../engine-client";

type Mode = "proof" | "live";
type EditTool = "text" | "nudge";

const PX_TO_MM = 25.4 / 96;

interface NudgeState {
  pcId: string;
  x: number; // translate mm
  y: number;
  marginTop: number | null; // mm
}

/** Read the inline nudge state straight off the element (source of truth = page.html). */
function readNudge(el: HTMLElement): Omit<NudgeState, "pcId"> {
  const t = /translate\((-?[\d.]+)mm,\s*(-?[\d.]+)mm\)/.exec(el.style.transform ?? "");
  const m = /^(-?[\d.]+)mm$/.exec(el.style.marginTop ?? "");
  return { x: t ? Number(t[1]) : 0, y: t ? Number(t[2]) : 0, marginTop: m ? Number(m[1]) : null };
}

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
  const [editTool, setEditTool] = useState<EditTool>("text");
  const [pageCount, setPageCount] = useState(0);
  const [page, setPage] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [activeImage, setActiveImage] = useState<string | null>(null);
  const [nudge, setNudge] = useState<NudgeState | null>(null);
  const [zoom, setZoom] = useState(1);
  const [genBusy, setGenBusy] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const uploadInput = useRef<HTMLInputElement>(null);
  const activeImageRef = useRef<string | null>(null);
  activeImageRef.current = activeImage;
  const editToolRef = useRef<EditTool>(editTool);
  editToolRef.current = editTool;
  const nudgeRef = useRef<NudgeState | null>(nudge);
  nudgeRef.current = nudge;
  const persistTimer = useRef<number | undefined>(undefined);

  const nudgeEl = (pcId: string): HTMLElement | null =>
    iframeRef.current?.contentDocument?.querySelector<HTMLElement>(`[data-pc-id="${pcId}"]`) ?? null;

  /** Apply a nudge to the iframe immediately; persist to page.html debounced. */
  const applyNudge = (next: NudgeState) => {
    nudgeRef.current = next; // sync, so rapid key-repeat bursts accumulate correctly
    setNudge(next);
    const el = nudgeEl(next.pcId);
    if (el) {
      el.style.transform = next.x || next.y ? `translate(${next.x.toFixed(1)}mm, ${next.y.toFixed(1)}mm)` : "";
      if (next.marginTop != null) el.style.marginTop = `${next.marginTop.toFixed(1)}mm`;
      else el.style.removeProperty("margin-top");
    }
    window.clearTimeout(persistTimer.current);
    persistTimer.current = window.setTimeout(() => {
      void client
        .setElementStyle(next.pcId, { translateX: next.x, translateY: next.y, marginTop: next.marginTop })
        .then(() => setDirty(true));
    }, 500);
  };
  const applyNudgeRef = useRef(applyNudge);
  applyNudgeRef.current = applyNudge;

  const clearNudgeSelection = () => {
    const doc = iframeRef.current?.contentDocument;
    doc?.querySelectorAll(".pc-nudge-active").forEach((el) => el.classList.remove("pc-nudge-active"));
    setNudge(null);
  };

  const roundInfo = viewRound != null ? project.rounds.find((r) => r.round === viewRound) : undefined;
  const roundHasProof = roundInfo?.hasProof ?? false;
  const proofRound = viewRound != null && roundHasProof ? viewRound : undefined;

  // Viewing a historical round forces proof mode (there is no historical live HTML).
  useEffect(() => {
    if (viewRound != null) setMode("proof");
  }, [viewRound]);

  // Switching edit tools clears selections and flips the iframe's cursor affordance.
  useEffect(() => {
    const doc = iframeRef.current?.contentDocument;
    if (doc?.body) {
      doc.body.classList.toggle("pc-nudge-mode", editTool === "nudge");
      doc.querySelectorAll(".pc-nudge-active").forEach((el) => el.classList.remove("pc-nudge-active"));
      doc.querySelectorAll("img.pc-active").forEach((el) => el.classList.remove("pc-active"));
    }
    setNudge(null);
    setActiveImage(null);
  }, [editTool]);

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
      body.pc-nudge-mode [data-pc-id]:hover { outline: 2px dashed rgba(245,158,11,.8); cursor: move; }
      .pc-nudge-active { outline: 2px solid rgba(245,158,11,1) !important; outline-offset: 2px; cursor: move !important; }
      img[data-image-id]:hover { outline: 2px dashed rgba(52,199,89,.8); outline-offset: 2px; cursor: pointer; }
      img[data-image-id].pc-active { outline: 2px solid rgba(52,199,89,1); outline-offset: 2px; cursor: grab; }
    `;
    doc.head.appendChild(style);
    doc.body.classList.toggle("pc-nudge-mode", editToolRef.current === "nudge");

    const selectForNudge = (el: HTMLElement) => {
      doc.querySelectorAll(".pc-nudge-active").forEach((other) => other.classList.remove("pc-nudge-active"));
      el.classList.add("pc-nudge-active");
      setActiveImage(null);
      const next = { pcId: el.getAttribute("data-pc-id")!, ...readNudge(el) };
      nudgeRef.current = next; // sync, so keystrokes right after the click see the selection
      setNudge(next);
    };

    doc.querySelectorAll<HTMLElement>("[data-pc-id]").forEach((el) => {
      el.addEventListener("click", (ev) => {
        if (editToolRef.current === "nudge") {
          ev.preventDefault();
          ev.stopPropagation(); // innermost block wins
          selectForNudge(el);
          return;
        }
        ev.preventDefault();
        el.setAttribute("contenteditable", "plaintext-only");
        el.focus();
      });
      el.addEventListener("blur", () => {
        if (!el.hasAttribute("contenteditable")) return;
        el.removeAttribute("contenteditable");
        const pcId = el.getAttribute("data-pc-id")!;
        void actions.updateCopy(pcId, el.textContent ?? "").then(() => setDirty(true));
      });

      // Drag-to-move when this element is the nudge selection.
      let drag: { x: number; y: number; startX: number; startY: number } | null = null;
      el.addEventListener("mousedown", (ev) => {
        const n = nudgeRef.current;
        if (editToolRef.current !== "nudge" || n?.pcId !== el.getAttribute("data-pc-id")) return;
        ev.preventDefault();
        drag = { x: ev.clientX, y: ev.clientY, startX: n.x, startY: n.y };
      });
      doc.addEventListener("mousemove", (ev) => {
        if (!drag) return;
        const n = nudgeRef.current;
        if (!n || n.pcId !== el.getAttribute("data-pc-id")) return (drag = null);
        applyNudgeRef.current({
          ...n,
          x: drag.startX + (ev.clientX - drag.x) * PX_TO_MM,
          y: drag.startY + (ev.clientY - drag.y) * PX_TO_MM,
        });
      });
      doc.addEventListener("mouseup", () => (drag = null));
    });

    // Arrow-key nudging (focus lives inside the iframe after a click).
    doc.addEventListener("keydown", (ev) => {
      const n = nudgeRef.current;
      if (!n || editToolRef.current !== "nudge") return;
      if (ev.key === "Escape") {
        doc.querySelectorAll(".pc-nudge-active").forEach((el) => el.classList.remove("pc-nudge-active"));
        setNudge(null);
        return;
      }
      const step = ev.shiftKey ? 2 : 0.5;
      const deltas: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
      };
      const d = deltas[ev.key];
      if (!d) return;
      ev.preventDefault();
      applyNudgeRef.current({ ...n, x: n.x + d[0], y: n.y + d[1] });
    });

    // Image slots: click selects (opens the image toolbar); drag pans object-position.
    doc.querySelectorAll<HTMLImageElement>("img[data-image-id]").forEach((img) => {
      const id = img.getAttribute("data-image-id")!;
      let drag: { x: number; y: number; posX: number; posY: number; moved: boolean } | null = null;

      const parsePos = (): [number, number] => {
        const m = /([\d.]+)%\s+([\d.]+)%/.exec(img.style.objectPosition || "50% 50%");
        return m ? [Number(m[1]), Number(m[2])] : [50, 50];
      };

      img.addEventListener("click", (ev) => {
        ev.preventDefault();
        if (drag?.moved) return; // click after a drag = end of pan, not a select toggle
        doc.querySelectorAll(".pc-nudge-active").forEach((other) => other.classList.remove("pc-nudge-active"));
        setNudge(null); // an image selection replaces a block selection
        doc.querySelectorAll("img.pc-active").forEach((other) => other.classList.remove("pc-active"));
        if (activeImageRef.current === id) {
          setActiveImage(null);
        } else {
          img.classList.add("pc-active");
          const m = /scale\(([\d.]+)\)/.exec(img.style.transform ?? "");
          setZoom(m ? Number(m[1]) : 1);
          setActiveImage(id);
        }
      });

      img.addEventListener("mousedown", (ev) => {
        if (activeImageRef.current !== id) return;
        ev.preventDefault();
        const [posX, posY] = parsePos();
        drag = { x: ev.clientX, y: ev.clientY, posX, posY, moved: false };
      });
      doc.addEventListener("mousemove", (ev) => {
        if (!drag || activeImageRef.current !== id) return;
        const rect = img.getBoundingClientRect();
        const dx = ((ev.clientX - drag.x) / rect.width) * 100;
        const dy = ((ev.clientY - drag.y) / rect.height) * 100;
        if (Math.abs(dx) + Math.abs(dy) > 1) drag.moved = true;
        const nx = Math.min(100, Math.max(0, drag.posX - dx));
        const ny = Math.min(100, Math.max(0, drag.posY - dy));
        img.style.objectFit = "cover";
        img.style.objectPosition = `${nx.toFixed(1)}% ${ny.toFixed(1)}%`;
      });
      doc.addEventListener("mouseup", () => {
        if (!drag || activeImageRef.current !== id) return;
        if (drag.moved) {
          void client
            .setImageStyle(id, { objectPosition: img.style.objectPosition })
            .then(() => setDirty(true));
        }
        drag = null;
      });
    });
  };

  const activeSlot = project.images.find((s) => s.id === activeImage);

  const applyZoom = (z: number) => {
    setZoom(z);
    const img = iframeRef.current?.contentDocument?.querySelector<HTMLImageElement>(
      `img[data-image-id="${activeImage}"]`,
    );
    if (img) img.style.transform = z === 1 ? "" : `scale(${z.toFixed(2)})`;
  };

  const persistZoom = () => {
    if (activeImage) void client.setImageStyle(activeImage, { zoom }).then(() => setDirty(true));
  };

  const onUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !activeImage) return;
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = String(reader.result).split(",")[1] ?? "";
      void client.uploadImageVariant(activeImage, base64).then(() => setDirty(true));
    };
    reader.readAsDataURL(file);
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

        {mode === "live" && (
          <Tabs value={editTool} onValueChange={(v) => setEditTool(v as EditTool)}>
            <TabsList className="h-8">
              <TabsTrigger value="text" className="gap-1 text-xs" title="Click text to edit copy">
                <Type className="size-3" /> Text
              </TabsTrigger>
              <TabsTrigger value="nudge" className="gap-1 text-xs" title="Click a block, then arrow keys / drag to nudge its position">
                <Move className="size-3" /> Nudge
              </TabsTrigger>
            </TabsList>
          </Tabs>
        )}

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

      {mode === "live" && editTool === "nudge" && nudge && viewRound == null && (
        <div className="flex shrink-0 items-center gap-3 border-t bg-muted/40 px-4 py-2 text-xs">
          <span className="font-mono font-medium">{nudge.pcId}</span>
          <span className="tabular-nums text-muted-foreground">
            x {nudge.x.toFixed(1)}mm · y {nudge.y.toFixed(1)}mm
          </span>
          <div className="flex items-center gap-1">
            <span className="text-muted-foreground">space above</span>
            <Button
              variant="outline"
              size="icon-sm"
              className="size-6"
              aria-label="Less space above"
              onClick={() => applyNudge({ ...nudge, marginTop: (nudge.marginTop ?? 0) - 1 })}
            >
              <Minus />
            </Button>
            <span className="w-12 text-center tabular-nums">{nudge.marginTop != null ? `${nudge.marginTop.toFixed(1)}mm` : "auto"}</span>
            <Button
              variant="outline"
              size="icon-sm"
              className="size-6"
              aria-label="More space above"
              onClick={() => applyNudge({ ...nudge, marginTop: (nudge.marginTop ?? 0) + 1 })}
            >
              <Plus />
            </Button>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-6 text-xs"
            onClick={() => applyNudge({ ...nudge, x: 0, y: 0, marginTop: null })}
          >
            <RotateCcw data-slot="icon" /> Reset
          </Button>
          <span className="text-muted-foreground">arrow keys nudge · shift = 2mm steps · drag to move</span>
          <div className="flex-1" />
          <Button variant="ghost" size="icon-sm" className="size-6" onClick={clearNudgeSelection}>
            <X />
          </Button>
        </div>
      )}

      {mode === "live" && editTool === "nudge" && !nudge && viewRound == null && (
        <div className="flex h-9 shrink-0 items-center border-t bg-muted/40 px-4 text-xs text-muted-foreground">
          Click any block in the page to nudge its position and spacing.
        </div>
      )}

      {mode === "live" && activeSlot && viewRound == null && (
        <div className="flex shrink-0 items-center gap-3 border-t bg-muted/40 px-4 py-2 text-xs">
          <span className="font-mono font-medium">{activeSlot.id}</span>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon-sm"
              className="size-6"
              disabled={!activeSlot.current || activeSlot.current <= Math.min(...activeSlot.variants)}
              onClick={() => void actions.selectVariant(activeSlot.id, activeSlot.current! - 1).then(() => setDirty(true))}
            >
              <ChevronLeft />
            </Button>
            <span className="tabular-nums">v{activeSlot.current ?? "?"} / {activeSlot.variants.length}</span>
            <Button
              variant="outline"
              size="icon-sm"
              className="size-6"
              disabled={!activeSlot.current || activeSlot.current >= Math.max(...activeSlot.variants)}
              onClick={() => void actions.selectVariant(activeSlot.id, activeSlot.current! + 1).then(() => setDirty(true))}
            >
              <ChevronRight />
            </Button>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-6 text-xs"
            disabled={genBusy}
            onClick={() => {
              setGenBusy(true);
              void client.generateMoreImages(activeSlot.id).finally(() => setGenBusy(false));
            }}
          >
            {genBusy ? <Loader2 className="animate-spin" data-slot="icon" /> : <Sparkles data-slot="icon" />} Generate more
          </Button>
          <Button variant="outline" size="sm" className="h-6 text-xs" onClick={() => uploadInput.current?.click()}>
            <ImagePlus data-slot="icon" /> Upload…
          </Button>
          <input ref={uploadInput} type="file" accept="image/*" hidden onChange={onUpload} />
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">zoom</span>
            <input
              type="range"
              min={1}
              max={2.5}
              step={0.05}
              value={zoom}
              onChange={(e) => applyZoom(Number(e.target.value))}
              onMouseUp={persistZoom}
              className="w-28 accent-primary"
            />
            <span className="w-8 tabular-nums">{zoom.toFixed(2)}×</span>
          </div>
          <span className="text-muted-foreground">drag the photo to reposition the crop</span>
          <div className="flex-1" />
          <Button variant="ghost" size="icon-sm" className="size-6" onClick={() => setActiveImage(null)}>
            <X />
          </Button>
        </div>
      )}

      {(mode === "proof" || (!activeSlot && editTool === "text")) && project.images.length > 0 && viewRound == null && (
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
          {mode === "live" && <span className="text-xs text-muted-foreground">click a photo in the page to edit its crop</span>}
        </div>
      )}
    </main>
  );
}
