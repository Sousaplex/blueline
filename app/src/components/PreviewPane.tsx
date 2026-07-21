import { ChevronLeft, ChevronRight, Code2, Grid3x3, History, Loader2, Move, RefreshCw, Save, Type } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { EngineClient, ProjectState } from "../engine-client";
import type { SelectionInfo } from "../selection";

type Mode = "proof" | "live" | "code";
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
  onSelect,
  onRequestDelete,
}: {
  project: ProjectState;
  client: EngineClient;
  cacheKey: number;
  actions: Actions;
  viewRound: number | null;
  onViewRound: (round: number | null) => void;
  onSelect: (selection: SelectionInfo | null) => void;
  onRequestDelete: (pcId: string) => void;
}) {
  // Deep-linkable initial view (?mode=live|code&tool=nudge) — also used by automated tests.
  const initialParams = useRef(new URLSearchParams(window.location.search));
  const [mode, setMode] = useState<Mode>(() => {
    const m = initialParams.current.get("mode");
    return m === "live" || m === "code" ? m : "proof";
  });
  const [editTool, setEditTool] = useState<EditTool>(() => (initialParams.current.get("tool") === "nudge" ? "nudge" : "text"));
  const [showGrid, setShowGrid] = useState(() => initialParams.current.get("grid") === "1");
  const showGridRef = useRef(showGrid);
  showGridRef.current = showGrid;
  const [pageCount, setPageCount] = useState(0);
  const [page, setPage] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [activeImage, setActiveImage] = useState<string | null>(null);
  const [nudge, setNudge] = useState<NudgeState | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [sourceDirty, setSourceDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const activeImageRef = useRef<string | null>(null);
  activeImageRef.current = activeImage;
  const editToolRef = useRef<EditTool>(editTool);
  editToolRef.current = editTool;
  const nudgeRef = useRef<NudgeState | null>(nudge);
  nudgeRef.current = nudge;
  const persistTimer = useRef<number | undefined>(undefined);

  const nudgeEl = (pcId: string): HTMLElement | null =>
    iframeRef.current?.contentDocument?.querySelector<HTMLElement>(`[data-pc-id="${pcId}"]`) ?? null;

  const reportBlock = (n: NudgeState, tag?: string) =>
    onSelect({ kind: "block", id: n.pcId, tag, nudge: { x: n.x, y: n.y, marginTop: n.marginTop } });

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
    reportBlock(next, el?.tagName);
    window.clearTimeout(persistTimer.current);
    persistTimer.current = window.setTimeout(() => {
      void client
        .setElementStyle(next.pcId, { translateX: next.x, translateY: next.y, marginTop: next.marginTop })
        .then(() => setDirty(true));
    }, 500);
  };
  const applyNudgeRef = useRef(applyNudge);
  applyNudgeRef.current = applyNudge;

  const clearSelections = () => {
    const doc = iframeRef.current?.contentDocument;
    doc?.querySelectorAll(".pc-nudge-active").forEach((el) => el.classList.remove("pc-nudge-active"));
    doc?.querySelectorAll("img.pc-active").forEach((el) => el.classList.remove("pc-active"));
    nudgeRef.current = null;
    setNudge(null);
    setActiveImage(null);
    onSelect(null);
  };
  const clearSelectionsRef = useRef(clearSelections);
  clearSelectionsRef.current = clearSelections;

  // 5mm layout grid overlay in the live iframe (snap uses it too).
  const syncGrid = () => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc?.body) return;
    const existing = doc.getElementById("pc-grid");
    if (showGridRef.current && !existing) {
      const g = doc.createElement("div");
      g.id = "pc-grid";
      g.style.cssText =
        "position:fixed;inset:0;pointer-events:none;z-index:2147483645;" +
        "background-image:repeating-linear-gradient(to right, rgba(59,130,246,.18) 0 0.2mm, transparent 0.2mm 5mm)," +
        "repeating-linear-gradient(to bottom, rgba(59,130,246,.18) 0 0.2mm, transparent 0.2mm 5mm);";
      doc.body.appendChild(g);
    } else if (!showGridRef.current && existing) {
      existing.remove();
    }
  };
  useEffect(syncGrid, [showGrid]); // eslint-disable-line react-hooks/exhaustive-deps

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
    if (doc?.body) doc.body.classList.toggle("pc-nudge-mode", editTool === "nudge");
    clearSelectionsRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editTool]);

  // Leaving live mode drops the selection; entering code mode loads the source.
  useEffect(() => {
    if (mode !== "live") clearSelectionsRef.current();
    if (mode === "code") {
      setSource(null);
      void client.getPageSource().then((s) => {
        setSource(s);
        setSourceDirty(false);
      }).catch((e) => setSource(`<!-- failed to load: ${e instanceof Error ? e.message : e} -->`));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

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
    syncGrid(); // iframe reloads drop injected overlays — restore the grid if it's on
    const style = doc.createElement("style");
    style.textContent = `
      [data-pc-id]:hover { outline: 2px dashed rgba(120,120,255,.7); outline-offset: 2px; cursor: text; }
      [data-pc-id]:focus { outline: 2px solid rgba(120,120,255,.95); outline-offset: 2px; }
      body.pc-nudge-mode [data-pc-id]:hover { outline: 2px dashed rgba(245,158,11,.8); cursor: move; }
      .pc-nudge-active { outline: 2px solid rgba(245,158,11,1) !important; outline-offset: 2px; cursor: move !important; }
      .pc-drop-before { box-shadow: inset 0 4px 0 0 rgba(59,130,246,.9) !important; }
      .pc-drop-after { box-shadow: inset 0 -4px 0 0 rgba(59,130,246,.9) !important; }
      .pc-dragging { opacity: .6; }
      img[data-image-id]:hover { outline: 2px dashed rgba(52,199,89,.8); outline-offset: 2px; cursor: pointer; }
      img[data-image-id].pc-active { outline: 2px solid rgba(52,199,89,1); outline-offset: 2px; cursor: grab; }
    `;
    doc.head.appendChild(style);
    doc.body.classList.toggle("pc-nudge-mode", editToolRef.current === "nudge");

    // An element holding other blocks must never become contenteditable: blurring it
    // would replace ALL of its children with flat text. Rule: ANY non-inline child.
    const INLINE_TAGS = new Set(["B", "I", "EM", "STRONG", "SPAN", "A", "BR", "SMALL", "SUP", "SUB", "CODE", "U", "MARK", "WBR", "TIME", "ABBR"]);
    const isStructural = (el: HTMLElement) =>
      Boolean(el.querySelector("[data-pc-id], [data-image-id], img")) ||
      [...el.children].some((child) => !INLINE_TAGS.has(child.tagName.toUpperCase()));

    const selectForNudge = (el: HTMLElement) => {
      doc.querySelectorAll(".pc-nudge-active").forEach((other) => other.classList.remove("pc-nudge-active"));
      doc.querySelectorAll("img.pc-active").forEach((other) => other.classList.remove("pc-active"));
      setActiveImage(null);
      el.classList.add("pc-nudge-active");
      const next = { pcId: el.getAttribute("data-pc-id")!, ...readNudge(el) };
      nudgeRef.current = next; // sync, so keystrokes right after the click see the selection
      setNudge(next);
      reportBlock(next, el.tagName);
    };

    const clearDropMarkers = () =>
      doc.querySelectorAll(".pc-drop-before, .pc-drop-after").forEach((el) => el.classList.remove("pc-drop-before", "pc-drop-after"));

    // Smart-align guide lines (magenta) shown while a drag snaps to sibling edges/centers.
    const guides = {
      show(vXs: number[], hYs: number[]) {
        let g = doc.getElementById("pc-guides");
        if (!g) {
          g = doc.createElement("div");
          g.id = "pc-guides";
          g.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
          doc.body.appendChild(g);
        }
        g.innerHTML = "";
        for (const x of vXs) {
          const l = doc.createElement("div");
          l.style.cssText = `position:absolute;left:${x}px;top:0;bottom:0;width:1px;background:#ec4899;`;
          g.appendChild(l);
        }
        for (const y of hYs) {
          const l = doc.createElement("div");
          l.style.cssText = `position:absolute;top:${y}px;left:0;right:0;height:1px;background:#ec4899;`;
          g.appendChild(l);
        }
      },
      clear() {
        doc.getElementById("pc-guides")?.remove();
      },
    };
    const SNAP_PX = 6; // smart-align capture distance
    const GRID_MM = 5;
    const GRID_SNAP_MM = 1.2; // grid capture distance (only when the grid is shown)

    doc.querySelectorAll<HTMLElement>("[data-pc-id]").forEach((el) => {
      el.addEventListener("click", (ev) => {
        ev.stopPropagation(); // innermost block wins — never bubble edits to containers
        if (editToolRef.current === "nudge") {
          ev.preventDefault();
          selectForNudge(el);
          return;
        }
        ev.preventDefault();
        if (isStructural(el)) return; // containers are nudge-only, not text-editable
        const cs = doc.defaultView!.getComputedStyle(el);
        onSelect({
          kind: "text",
          id: el.getAttribute("data-pc-id")!,
          tag: el.tagName,
          text: el.textContent ?? "",
          styles: { fontSize: cs.fontSize, fontWeight: cs.fontWeight, lineHeight: cs.lineHeight, color: cs.color, textAlign: cs.textAlign },
        });
        el.dataset.pcOriginal = el.textContent ?? "";
        el.setAttribute("contenteditable", "plaintext-only");
        el.focus();
      });
      el.addEventListener("blur", () => {
        if (!el.hasAttribute("contenteditable")) return;
        el.removeAttribute("contenteditable");
        const pcId = el.getAttribute("data-pc-id")!;
        const text = el.textContent ?? "";
        const original = el.dataset.pcOriginal;
        delete el.dataset.pcOriginal;
        if (text === original) return; // click-in, click-out: touch nothing
        void actions.updateCopy(pcId, text).then(() => setDirty(true));
      });

      // Nudge-mode drag: plain drag = translate (with smart-align + grid snap);
      // ⌥-drag = reorder in document flow.
      let drag: {
        x: number; y: number; startX: number; startY: number;
        reorder: boolean; target: HTMLElement | null; after: boolean;
        baseRect?: DOMRect; alignV?: number[]; alignH?: number[];
      } | null = null;
      el.addEventListener("mousedown", (ev) => {
        const n = nudgeRef.current;
        if (editToolRef.current !== "nudge" || n?.pcId !== el.getAttribute("data-pc-id")) return;
        ev.preventDefault();
        drag = { x: ev.clientX, y: ev.clientY, startX: n.x, startY: n.y, reorder: ev.altKey, target: null, after: false };
        if (drag.reorder) {
          el.classList.add("pc-dragging");
        } else {
          // Collect the edges/centers of every other block once — smart-align targets.
          drag.baseRect = el.getBoundingClientRect();
          const v: number[] = [];
          const h: number[] = [];
          doc.querySelectorAll<HTMLElement>("[data-pc-id], img[data-image-id]").forEach((other) => {
            if (other === el || el.contains(other) || other.contains(el)) return;
            const r = other.getBoundingClientRect();
            if (!r.width || !r.height) return;
            v.push(r.left, r.right, r.left + r.width / 2);
            h.push(r.top, r.bottom, r.top + r.height / 2);
          });
          drag.alignV = v;
          drag.alignH = h;
        }
      });
      doc.addEventListener("mousemove", (ev) => {
        if (!drag) return;
        const n = nudgeRef.current;
        if (!n || n.pcId !== el.getAttribute("data-pc-id")) return (drag = null);
        if (drag.reorder) {
          clearDropMarkers();
          const under = doc.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>("[data-pc-id]");
          if (under && under !== el && !el.contains(under) && !under.contains(el)) {
            const rect = under.getBoundingClientRect();
            drag.after = ev.clientY > rect.top + rect.height / 2;
            drag.target = under;
            under.classList.add(drag.after ? "pc-drop-after" : "pc-drop-before");
          } else {
            drag.target = null;
          }
          return;
        }
        let dxPx = ev.clientX - drag.x;
        let dyPx = ev.clientY - drag.y;
        const vLines: number[] = [];
        const hLines: number[] = [];
        if (drag.baseRect && drag.alignV && drag.alignH) {
          const r = drag.baseRect;
          let bestX: { adj: number; line: number } | null = null;
          for (const edge of [r.left + dxPx, r.right + dxPx, r.left + r.width / 2 + dxPx]) {
            for (const t of drag.alignV) {
              const adj = t - edge;
              if (Math.abs(adj) <= SNAP_PX && (!bestX || Math.abs(adj) < Math.abs(bestX.adj))) bestX = { adj, line: t };
            }
          }
          let bestY: { adj: number; line: number } | null = null;
          for (const edge of [r.top + dyPx, r.bottom + dyPx, r.top + r.height / 2 + dyPx]) {
            for (const t of drag.alignH) {
              const adj = t - edge;
              if (Math.abs(adj) <= SNAP_PX && (!bestY || Math.abs(adj) < Math.abs(bestY.adj))) bestY = { adj, line: t };
            }
          }
          if (bestX) { dxPx += bestX.adj; vLines.push(bestX.line); }
          if (bestY) { dyPx += bestY.adj; hLines.push(bestY.line); }
          if (vLines.length || hLines.length) guides.show(vLines, hLines);
          else guides.clear();
        }
        let xmm = drag.startX + dxPx * PX_TO_MM;
        let ymm = drag.startY + dyPx * PX_TO_MM;
        // Grid snap (only when the grid is visible, and only on axes smart-align didn't claim).
        if (showGridRef.current) {
          if (!vLines.length) { const s = Math.round(xmm / GRID_MM) * GRID_MM; if (Math.abs(s - xmm) <= GRID_SNAP_MM) xmm = s; }
          if (!hLines.length) { const s = Math.round(ymm / GRID_MM) * GRID_MM; if (Math.abs(s - ymm) <= GRID_SNAP_MM) ymm = s; }
        }
        applyNudgeRef.current({ ...n, x: xmm, y: ymm });
      });
      doc.addEventListener("mouseup", () => {
        if (!drag) return;
        const d = drag;
        drag = null;
        el.classList.remove("pc-dragging");
        clearDropMarkers();
        guides.clear();
        if (d.reorder && d.target) {
          const id = el.getAttribute("data-pc-id")!;
          const beforeId = d.target.getAttribute("data-pc-id")!;
          clearSelectionsRef.current();
          void client.moveElementBefore(id, beforeId, d.after).then(() => setDirty(true));
        }
      });
    });

    // Keyboard: arrows nudge, Escape deselects, Delete asks to remove the element.
    doc.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") {
        clearSelectionsRef.current();
        return;
      }
      const n = nudgeRef.current;
      if (!n || editToolRef.current !== "nudge") return;
      if (ev.key === "Delete" || ev.key === "Backspace") {
        ev.preventDefault();
        onRequestDelete(n.pcId);
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

    // Image slots: click selects (Inspector shows controls); drag pans object-position.
    doc.querySelectorAll<HTMLImageElement>("img[data-image-id]").forEach((img) => {
      const id = img.getAttribute("data-image-id")!;
      let drag: { x: number; y: number; posX: number; posY: number; moved: boolean } | null = null;

      const parsePos = (): [number, number] => {
        const m = /([\d.]+)%\s+([\d.]+)%/.exec(img.style.objectPosition || "50% 50%");
        return m ? [Number(m[1]), Number(m[2])] : [50, 50];
      };

      img.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (drag?.moved) return; // click after a drag = end of pan, not a select toggle
        doc.querySelectorAll(".pc-nudge-active").forEach((other) => other.classList.remove("pc-nudge-active"));
        nudgeRef.current = null;
        setNudge(null);
        doc.querySelectorAll("img.pc-active").forEach((other) => other.classList.remove("pc-active"));
        if (activeImageRef.current === id) {
          setActiveImage(null);
          onSelect(null);
        } else {
          img.classList.add("pc-active");
          setActiveImage(id);
          onSelect({ kind: "image", id, tag: "IMG" });
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
          void client.setImageStyle(id, { objectPosition: img.style.objectPosition }).then(() => setDirty(true));
        }
        drag = null;
      });
    });
  };

  const saveSource = () => {
    if (source == null) return;
    setSaving(true);
    void client
      .savePageSource(source)
      .then(() => actions.render())
      .then(() => setSourceDirty(false))
      .catch((e) => setSource((s) => s)) // error surfaces via the bridge error event
      .finally(() => setSaving(false));
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
            <TabsTrigger value="code" className="gap-1 text-xs" disabled={viewRound != null}>
              <Code2 className="size-3" /> Code
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {mode === "live" && (
          <Tabs value={editTool} onValueChange={(v) => setEditTool(v as EditTool)}>
            <TabsList className="h-8">
              <TabsTrigger value="text" className="gap-1 text-xs" title="Click text to edit copy">
                <Type className="size-3" /> Text
              </TabsTrigger>
              <TabsTrigger value="nudge" className="gap-1 text-xs" title="Click a block, then arrow keys / drag to nudge; ⌥-drag to reorder">
                <Move className="size-3" /> Nudge
              </TabsTrigger>
            </TabsList>
          </Tabs>
        )}

        {mode === "live" && (
          <Button
            size="sm"
            variant={showGrid ? "secondary" : "ghost"}
            className="h-8 text-xs"
            title="5mm grid — drags snap to it (smart-align to neighbors always on)"
            onClick={() => setShowGrid(!showGrid)}
          >
            <Grid3x3 data-slot="icon" /> Grid
          </Button>
        )}

        {mode === "code" && (
          <Button size="sm" className="h-7 text-xs" disabled={saving || !sourceDirty || source == null} onClick={saveSource}>
            {saving ? <Loader2 className="animate-spin" data-slot="icon" /> : <Save data-slot="icon" />} Save & re-render
          </Button>
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

      {mode === "code" ? (
        source == null ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">loading source…</div>
        ) : (
          <textarea
            spellCheck={false}
            className="min-h-0 flex-1 resize-none bg-muted/20 p-4 font-mono text-xs leading-relaxed outline-none"
            value={source}
            onChange={(e) => {
              setSource(e.target.value);
              setSourceDirty(true);
            }}
          />
        )
      ) : (
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
      )}

      {mode === "proof" && project.images.length > 0 && viewRound == null && (
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
