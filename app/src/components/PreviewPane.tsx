import { html } from "@codemirror/lang-html";
import { search, searchKeymap } from "@codemirror/search";
import { keymap } from "@codemirror/view";
import { oneDark } from "@codemirror/theme-one-dark";
import CodeMirror from "@uiw/react-codemirror";
import { ChevronLeft, ChevronRight, Code2, Crop, Grid3x3, Heading, History, Loader2, Maximize, Minus, MousePointerClick, Move, Plus, Redo2, RefreshCw, Save, Sparkles, Square, Trash2, Type, Undo2, X, ZoomIn, ZoomOut } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  coverLayer,
  type FrameCtx,
  type FrameGeom,
  type ImgLayerGeom,
  isCorner,
  resizeFrame,
  scaleContent,
  scaleLayerWithFrame,
  screenDeltaToMm,
} from "@/lib/layerGeometry";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { currentTheme } from "@/lib/theme";
import type { EngineClient, ProjectState } from "../engine-client";
import type { AlignOp, LayerItem, SelectionInfo } from "../selection";

type Mode = "proof" | "live" | "code";

const PX_TO_MM = 25.4 / 96;
const MM_TO_PX = 96 / 25.4;
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3];

// 8 resize handles for the image-mask selection overlay. l/r/t/b flag which edges the
// handle moves; the OPPOSITE edge stays anchored (Figma-style).
type ImgHandle = { k: string; l?: boolean; r?: boolean; t?: boolean; b?: boolean; cur: string };
const IMG_HANDLES: ImgHandle[] = [
  { k: "nw", l: true, t: true, cur: "nwse-resize" },
  { k: "n", t: true, cur: "ns-resize" },
  { k: "ne", r: true, t: true, cur: "nesw-resize" },
  { k: "e", r: true, cur: "ew-resize" },
  { k: "se", r: true, b: true, cur: "nwse-resize" },
  { k: "s", b: true, cur: "ns-resize" },
  { k: "sw", l: true, b: true, cur: "nesw-resize" },
  { k: "w", l: true, cur: "ew-resize" },
];
const handlePos = (h: ImgHandle): { left: string; top: string } => ({
  left: h.l ? "0%" : h.r ? "100%" : "50%",
  top: h.t ? "0%" : h.b ? "100%" : "50%",
});

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
  cancel(slug?: string): void;
}

export function PreviewPane({
  project,
  client,
  cacheKey,
  actions,
  runState,
  viewRound,
  onViewRound,
  onSelect,
  onRequestDelete,
  onLayers,
  registerAlign,
  registerApplyProps,
  registerSetPosition,
  registerSelectLayer,
  registerClearSelection,
}: {
  project: ProjectState;
  client: EngineClient;
  cacheKey: number;
  actions: Actions;
  runState: "idle" | "queued" | "running";
  viewRound: number | null;
  onViewRound: (round: number | null) => void;
  onSelect: (selection: SelectionInfo | null) => void;
  onRequestDelete: (pcIds: string[]) => void;
  /** Emits the live document's layer list (for the Layers panel) after each iframe (re)arm. */
  onLayers?: (layers: LayerItem[]) => void;
  /** Hands the Inspector a way to trigger alignment on the current selection. */
  registerAlign: (fn: ((op: AlignOp) => void) | null) => void;
  /** Lets the Inspector's property panel apply inline styles to the LIVE element + persist. */
  registerApplyProps: (fn: ((id: string, props: Record<string, string>) => void) | null) => void;
  /** Lets the Inspector set a block's exact position (X/Y/top) live + persist. */
  registerSetPosition?: (fn: ((id: string, x: number, y: number, marginTop: number | null) => void) | null) => void;
  /** Lets the Layers panel select an element by id (dispatches a click in the iframe). */
  registerSelectLayer?: (fn: ((id: string) => void) | null) => void;
  /** Lets the app drop the canvas selection (e.g. after a delete) so the frozen iframe reloads. */
  registerClearSelection: (fn: (() => void) | null) => void;
}) {
  // Deep-linkable initial view (?mode=live|code&grid=1) — also used by automated tests.
  const initialParams = useRef(new URLSearchParams(window.location.search));
  const [mode, setMode] = useState<Mode>(() => {
    const m = initialParams.current.get("mode");
    return m === "live" || m === "code" ? m : "proof";
  });
  const [showGrid, setShowGrid] = useState(() => initialParams.current.get("grid") === "1");
  const showGridRef = useRef(showGrid);
  showGridRef.current = showGrid;
  const [pageCount, setPageCount] = useState(0);
  const [page, setPage] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [activeImage, setActiveImage] = useState<string | null>(null);
  // Image editing (docs/layer-model.md §5): one selection, no Move/Crop toggle. Default =
  // frame ops (body moves, corners scale, edges crop). Double-click enters CONTENT mode
  // (drag pans the photo, corners zoom it inside the frame); Esc/click-out exits.
  const [contentMode, setContentMode] = useState(false);
  const contentModeRef = useRef(false);
  contentModeRef.current = contentMode;
  // Screen-space rect of the selected image's mask frame (position:fixed coords), used to
  // draw the selection overlay + resize handles and to anchor the floating toolbar.
  const [imgTool, setImgTool] = useState<{ id: string; top: number; left: number; width: number; height: number } | null>(null);
  // Refs to the overlay + toolbar DOM nodes so a drag can reposition them by writing style
  // directly (no per-frame React re-render — that was the jank). setState only on drag end.
  const imgOverlayRef = useRef<HTMLDivElement>(null);
  const imgToolbarRef = useRef<HTMLDivElement>(null);
  const [nudge, setNudge] = useState<NudgeState | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [sourceDirty, setSourceDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const activeImageRef = useRef<string | null>(null);
  activeImageRef.current = activeImage;
  const nudgeRef = useRef<NudgeState | null>(nudge);
  nudgeRef.current = nudge;
  const extraIdsRef = useRef<string[]>([]); // selection beyond the primary (shift-click)
  const persistTimer = useRef<number | undefined>(undefined);
  const cacheKeyRef = useRef(cacheKey);
  cacheKeyRef.current = cacheKey;
  // The live iframe freezes while the user has a selection or an open text edit —
  // a mid-edit reload would eat their focus (and their typing).
  const [liveKey, setLiveKey] = useState(cacheKey);
  useEffect(() => {
    const doc = iframeRef.current?.contentDocument;
    const editing = Boolean(
      nudgeRef.current ||
        activeImageRef.current ||
        (doc?.activeElement as HTMLElement | null)?.hasAttribute?.("contenteditable"),
    );
    if (!editing) setLiveKey(cacheKey);
  }, [cacheKey]);

  // Keep the live canvas's images in sync with their selected variant WITHOUT reloading
  // the iframe. While an image is selected the iframe is frozen (see liveKey above), so a
  // variant shuttle / upload / regenerate would otherwise stay invisible until deselect.
  // Swapping the <img src> in place is instant and preserves the selection and crop pan.
  useEffect(() => {
    if (mode !== "live") return;
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;
    for (const slot of project.images) {
      if (!slot.current) continue;
      const img = doc.querySelector<HTMLImageElement>(`img[data-image-id="${slot.id}"]`);
      const want = `images/${slot.id}/v${slot.current}.png`;
      if (img && !(img.getAttribute("src") ?? "").startsWith(want)) img.setAttribute("src", want);
    }
  }, [project.images, mode, liveKey]);

  const nudgeEl = (pcId: string): HTMLElement | null =>
    iframeRef.current?.contentDocument?.querySelector<HTMLElement>(`[data-pc-id="${pcId}"]`) ?? null;

  const selectedIds = (): string[] => (nudgeRef.current ? [nudgeRef.current.pcId, ...extraIdsRef.current] : []);

  /** Computed style subset the contextual property panel edits. Also carries the rendered
   *  width (mm) and whether width is explicitly set inline (so the panel shows a real value). */
  const readElStyles = (el: HTMLElement): Record<string, string> => {
    const win = iframeRef.current?.contentDocument?.defaultView;
    const cs = win ? win.getComputedStyle(el) : null;
    const rect = el.getBoundingClientRect();
    return {
      fontFamily: cs?.fontFamily ?? "",
      fontSize: cs?.fontSize ?? "",
      fontWeight: cs?.fontWeight ?? "",
      fontStyle: cs?.fontStyle ?? "",
      color: cs?.color ?? "",
      textAlign: cs?.textAlign ?? "",
      backgroundColor: cs?.backgroundColor ?? "",
      borderRadius: cs?.borderTopLeftRadius ?? "",
      widthMm: (rect.width / MM_TO_PX).toFixed(1),
      heightMm: (rect.height / MM_TO_PX).toFixed(1),
      widthInline: el.style.width || "",
    };
  };

  const reportBlock = (n: NudgeState, tag?: string) => {
    const el = nudgeEl(n.pcId);
    onSelect({ kind: "block", id: n.pcId, tag, nudge: { x: n.x, y: n.y, marginTop: n.marginTop }, styles: el ? readElStyles(el) : undefined });
  };

  /** Push the current selection (single block or multi set) to the Inspector. */
  const reportSelection = () => {
    const n = nudgeRef.current;
    if (!n) return onSelect(null);
    const ids = selectedIds();
    if (ids.length > 1) onSelect({ kind: "multi", ids });
    else reportBlock(n, nudgeEl(n.pcId)?.tagName);
  };
  const reportSelectionRef = useRef(reportSelection);
  reportSelectionRef.current = reportSelection;

  /** Current translate/margin per selected element — the base for a move gesture. */
  const captureBases = (): Map<string, Omit<NudgeState, "pcId">> => {
    const bases = new Map<string, Omit<NudgeState, "pcId">>();
    for (const id of selectedIds()) {
      const el = nudgeEl(id);
      if (el) bases.set(id, readNudge(el));
    }
    return bases;
  };

  /** Move every selected element by (dx, dy) mm from its base; persist debounced.
   *  `live` (a drag frame) writes ONLY the DOM — no setNudge/onSelect, which would re-render
   *  App + Inspector on every pointermove (60fps jank). The drag commits React state once on
   *  release (live=false). Keyboard nudges are always live=false (low frequency). */
  const applyDeltaToSelection = (bases: Map<string, Omit<NudgeState, "pcId">>, dx: number, dy: number, live = false) => {
    for (const [id, b] of bases) {
      const el = nudgeEl(id);
      if (!el) continue;
      const x = b.x + dx;
      const y = b.y + dy;
      el.style.transform = x || y ? `translate(${x.toFixed(1)}mm, ${y.toFixed(1)}mm)` : "";
    }
    if (!live) {
      const n = nudgeRef.current;
      if (n && bases.has(n.pcId)) {
        const b = bases.get(n.pcId)!;
        const next = { ...n, x: b.x + dx, y: b.y + dy };
        nudgeRef.current = next; // sync, so rapid key-repeat bursts accumulate correctly
        setNudge(next);
      }
      reportSelectionRef.current();
    }
    window.clearTimeout(persistTimer.current);
    persistTimer.current = window.setTimeout(() => {
      void persist(
        client.setElementStyles(
          [...bases].map(([id, b]) => ({ pcId: id, translateX: b.x + dx, translateY: b.y + dy, marginTop: b.marginTop })),
        ),
      );
    }, 500);
  };
  const applyDeltaRef = useRef(applyDeltaToSelection);
  applyDeltaRef.current = applyDeltaToSelection;
  const captureBasesRef = useRef(captureBases);
  captureBasesRef.current = captureBases;
  const onRequestDeleteRef = useRef(onRequestDelete);
  onRequestDeleteRef.current = onRequestDelete;

  const clearSelections = () => {
    // Cancel any pending debounced move-persist: without this, a drag/nudge followed within
    // 500ms by deselect/undo/delete re-writes the dragged position AFTER the newer state,
    // corrupting undo or writing styles for an element that's about to be deleted.
    window.clearTimeout(persistTimer.current);
    const doc = iframeRef.current?.contentDocument;
    doc?.querySelectorAll(".pc-nudge-active").forEach((el) => el.classList.remove("pc-nudge-active"));
    doc?.querySelectorAll("img.pc-active").forEach((el) => el.classList.remove("pc-active"));
    nudgeRef.current = null;
    extraIdsRef.current = [];
    setNudge(null);
    setActiveImage(null);
    setImgTool(null);
    setContentMode(false);
    onSelect(null);
    setLiveKey(cacheKeyRef.current); // catch up on any renders frozen during the edit
  };
  const clearSelectionsRef = useRef(clearSelections);
  clearSelectionsRef.current = clearSelections;
  // The delete flow lives in the Inspector — it needs to drop OUR selection when it
  // finishes, or the freeze above keeps showing the deleted element forever.
  useEffect(() => {
    registerClearSelection(() => clearSelectionsRef.current());
    return () => registerClearSelection(null);
  }, [registerClearSelection]);

  // ---- Canvas zoom: fit-to-width by default, explicit steps via palette/keys/wheel. ----
  const art = project.artboard ?? { w: 210, h: 297 };
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const canvasRef = useRef<HTMLDivElement>(null);
  const [containerW, setContainerW] = useState(0);
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setContainerW(el.clientWidth));
    ro.observe(el);
    setContainerW(el.clientWidth);
    return () => ro.disconnect();
  }, [mode]);
  const fitZoom = Math.min(1, Math.max(0.15, (containerW - 64) / (art.w * MM_TO_PX)));
  const zoomVal = zoom === "fit" ? (containerW ? fitZoom : 1) : zoom;
  const zoomValRef = useRef(zoomVal);
  zoomValRef.current = zoomVal;
  const stepZoom = (dir: 1 | -1) => {
    const cur = zoomValRef.current;
    const next =
      dir === 1
        ? (ZOOM_STEPS.find((s) => s > cur + 0.01) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1])
        : ([...ZOOM_STEPS].reverse().find((s) => s < cur - 0.01) ?? ZOOM_STEPS[0]);
    setZoom(next);
  };
  const stepZoomRef = useRef(stepZoom);
  stepZoomRef.current = stepZoom;
  const setZoomRef = useRef(setZoom);
  setZoomRef.current = setZoom;

  /** Position the floating image toolbar over an image inside the (CSS-zoomed) iframe,
   *  in parent screen coords for a position:fixed element. */
  const anchorImgTool = (imgEl: HTMLElement, id: string) => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    const ir = iframe.getBoundingClientRect();
    const z = zoomValRef.current;
    // Bound the mask FRAME (the visible crop box), not the img (which may overflow it).
    const box = (imgEl.parentElement ?? imgEl).getBoundingClientRect(); // iframe-internal px
    setImgTool({ id, top: ir.top + box.top * z, left: ir.left + box.left * z, width: box.width * z, height: box.height * z });
  };
  const anchorImgToolRef = useRef(anchorImgTool);
  anchorImgToolRef.current = anchorImgTool;

  /** Screen-space rect of a mask frame (position:fixed coords). */
  const frameScreenRect = (frame: HTMLElement): { top: number; left: number; width: number; height: number } => {
    const iframe = iframeRef.current!;
    const ir = iframe.getBoundingClientRect();
    const z = zoomValRef.current;
    const b = frame.getBoundingClientRect();
    return { top: ir.top + b.top * z, left: ir.left + b.left * z, width: b.width * z, height: b.height * z };
  };
  /** Reposition the overlay + toolbar by writing style directly — used DURING a drag so the
   *  frame tracks the cursor at 60fps without a React re-render. setImgTool syncs on mouseup. */
  const positionImgOverlayDirect = (r: { top: number; left: number; width: number; height: number }) => {
    const o = imgOverlayRef.current;
    if (o) {
      o.style.top = `${r.top}px`;
      o.style.left = `${r.left}px`;
      o.style.width = `${r.width}px`;
      o.style.height = `${r.height}px`;
    }
    const t = imgToolbarRef.current;
    if (t) {
      t.style.top = `${r.top - 8}px`;
      t.style.left = `${r.left + r.width / 2}px`;
    }
  };

  // Keep the image toolbar glued to its image as the canvas scrolls or zooms.
  useEffect(() => {
    const canvas = canvasRef.current;
    const reposition = () => {
      const id = activeImageRef.current;
      const doc = iframeRef.current?.contentDocument;
      if (!id || !doc) return;
      const img = doc.querySelector<HTMLElement>(`img[data-image-id="${id}"]`);
      if (img) anchorImgToolRef.current(img, id);
    };
    reposition();
    canvas?.addEventListener("scroll", reposition, { passive: true });
    window.addEventListener("resize", reposition);
    return () => {
      canvas?.removeEventListener("scroll", reposition);
      window.removeEventListener("resize", reposition);
    };
  }, [zoomVal, liveKey]);

  const liveImg = (id: string) =>
    iframeRef.current?.contentDocument?.querySelector<HTMLImageElement>(`img[data-image-id="${id}"]`) ?? null;


  const numMm = (v: string): number => {
    const n = Number((/(-?[\d.]+)mm/.exec(v || "") || [])[1] ?? NaN);
    return Number.isFinite(n) ? n : 0;
  };

  // ---- Compiled image geometry (docs/layer-model.md): the crop FRAME + inner photo LAYER. ----
  const frameEl = (id: string): HTMLElement | null =>
    iframeRef.current?.contentDocument?.querySelector<HTMLElement>(`[data-img-frame="${id}"]`) ?? null;
  const readFrameGeom = (f: HTMLElement): FrameGeom => ({
    leftMm: numMm(f.style.left),
    topMm: numMm(f.style.top),
    widthMm: numMm(f.style.width),
    heightMm: numMm(f.style.height),
  });
  const readLayerGeom = (img: HTMLImageElement): ImgLayerGeom => ({
    widthMm: numMm(img.style.width),
    leftMm: numMm(img.style.left),
    topMm: numMm(img.style.top),
  });
  const writeFrameGeom = (f: HTMLElement, g: FrameGeom) => {
    f.style.left = `${g.leftMm.toFixed(1)}mm`;
    f.style.top = `${g.topMm.toFixed(1)}mm`;
    f.style.width = `${g.widthMm.toFixed(1)}mm`;
    f.style.height = `${g.heightMm.toFixed(1)}mm`;
  };
  const writeLayerGeom = (img: HTMLImageElement, g: ImgLayerGeom) => {
    img.style.width = `${g.widthMm.toFixed(1)}mm`;
    img.style.left = `${g.leftMm.toFixed(1)}mm`;
    img.style.top = `${g.topMm.toFixed(1)}mm`;
  };
  const imgAspect = (img: HTMLImageElement): number =>
    img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : 1;
  /** Persist the current on-screen geometry of an image (frame and/or layer), debounced-free. */
  const persistImageGeom = (id: string, frame: HTMLElement | null, img: HTMLImageElement | null) => {
    void persist(
      client.setImageGeometry(id, {
        frame: frame ? readFrameGeom(frame) : undefined,
        layer: img ? readLayerGeom(img) : undefined,
      }),
    );
  };
  // Legacy projects (pre-0.21) have uncompiled images. compileOnArm() below normalizes them
  // ONCE on entry (while nothing is selected, so the iframe isn't frozen) — so by gesture time
  // the frame exists. This just reads it; no lazy render (that looped against the freeze).
  const ensureCompiledOrRender = (id: string): HTMLElement | null => frameEl(id);

  // Bounded so a compile that can't add a frame never loops. Reset per project.
  const compileTriesRef = useRef(0);
  useEffect(() => {
    compileTriesRef.current = 0;
  }, [project.slug]);

  /** Run a drag using POINTER CAPTURE. Capturing the pointer routes every pointermove/up to
   *  the grabbed element even when the cursor is over the live-edit iframe — without it, a
   *  release over the iframe is swallowed and the drag "sticks" (moves then freezes). */
  const dragWithCapture = (e: React.PointerEvent, onMove: (ev: PointerEvent) => void, onEnd: () => void) => {
    const el = e.currentTarget as HTMLElement;
    const pid = e.pointerId;
    try {
      el.setPointerCapture(pid);
    } catch {
      /* ignore */
    }
    const move = (ev: PointerEvent) => onMove(ev);
    const end = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", end);
      el.removeEventListener("pointercancel", end);
      try {
        el.releasePointerCapture(pid);
      } catch {
        /* ignore */
      }
      onEnd();
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  };

  /** Build the once-per-gesture coordinate context (deltas only need the zoom factor). */
  const gestureCtx = (): FrameCtx => ({ originX: 0, originY: 0, zoom: zoomValRef.current });

  /**
   * Drag a resize handle (docs/layer-model.md §5). CONTENT mode: a corner zooms the photo
   * inside a fixed frame. Default mode: a CORNER scales frame+photo proportionally (⌥/⌘ =
   * free stretch); an EDGE crops/reveals that one side (photo stays put on the page).
   */
  const startImgResize = (e: React.PointerEvent, h: ImgHandle) => {
    e.preventDefault();
    e.stopPropagation();
    const id = activeImageRef.current;
    if (!id) return;
    const img = liveImg(id);
    const frame = ensureCompiledOrRender(id);
    if (!img || !frame) return;
    const ctx = gestureCtx();
    const startFrame = readFrameGeom(frame);
    const startLayer = readLayerGeom(img);
    const aspect = imgAspect(img);

    if (contentModeRef.current) {
      // Zoom the photo within the fixed frame, anchored on the frame centre.
      const r = frameScreenRect(frame);
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const startDist = Math.hypot(e.clientX - cx, e.clientY - cy) || 1;
      dragWithCapture(
        e,
        (ev) => {
          const factor = Math.max(0.1, Math.min(12, Math.hypot(ev.clientX - cx, ev.clientY - cy) / startDist));
          writeLayerGeom(img, scaleContent(startLayer, factor, startFrame));
        },
        () => persistImageGeom(id, null, img),
      );
      return;
    }

    dragWithCapture(
      e,
      (ev) => {
        const { dxMm, dyMm } = screenDeltaToMm(ev.clientX - e.clientX, ev.clientY - e.clientY, ctx);
        let frameG: FrameGeom;
        let layerG: ImgLayerGeom;
        if (isCorner(h)) {
          const free = ev.altKey || ev.metaKey;
          frameG = resizeFrame(startFrame, h, dxMm, dyMm, { aspectLock: !free });
          // Proportional → frame+photo scale together; free stretch → re-cover the new box.
          layerG = free ? coverLayer(frameG, aspect) : scaleLayerWithFrame(startLayer, startFrame, frameG, h);
        } else {
          // Edge = crop one axis. Keep the photo visually put by shifting it opposite any
          // frame-origin move (west/north edges move the origin).
          frameG = resizeFrame(startFrame, h, dxMm, dyMm, {});
          layerG = {
            widthMm: startLayer.widthMm,
            leftMm: startLayer.leftMm - (frameG.leftMm - startFrame.leftMm),
            topMm: startLayer.topMm - (frameG.topMm - startFrame.topMm),
          };
        }
        writeFrameGeom(frame, frameG);
        writeLayerGeom(img, layerG);
        positionImgOverlayDirect(frameScreenRect(frame));
      },
      () => {
        anchorImgToolRef.current(img, id);
        persistImageGeom(id, frame, img);
      },
    );
  };

  /** Drag the image body: default = move the frame on the page; CONTENT mode = pan the photo. */
  const startImgBodyDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const id = activeImageRef.current;
    if (!id) return;
    const img = liveImg(id);
    const frame = ensureCompiledOrRender(id);
    if (!img || !frame) return;
    const ctx = gestureCtx();
    const startFrame = readFrameGeom(frame);
    const startLayer = readLayerGeom(img);

    if (contentModeRef.current) {
      dragWithCapture(
        e,
        (ev) => {
          const { dxMm, dyMm } = screenDeltaToMm(ev.clientX - e.clientX, ev.clientY - e.clientY, ctx);
          writeLayerGeom(img, { widthMm: startLayer.widthMm, leftMm: startLayer.leftMm + dxMm, topMm: startLayer.topMm + dyMm });
        },
        () => persistImageGeom(id, null, img),
      );
      return;
    }

    dragWithCapture(
      e,
      (ev) => {
        const { dxMm, dyMm } = screenDeltaToMm(ev.clientX - e.clientX, ev.clientY - e.clientY, ctx);
        writeFrameGeom(frame, { ...startFrame, leftMm: startFrame.leftMm + dxMm, topMm: startFrame.topMm + dyMm });
        positionImgOverlayDirect(frameScreenRect(frame));
      },
      () => {
        anchorImgToolRef.current(img, id);
        persistImageGeom(id, frame, null);
      },
    );
  };

  /** Shared zoom shortcuts: ⌘/Ctrl +, -, 0 (fit), 1 (100%). Returns true when handled. */
  const handleZoomKey = (ev: KeyboardEvent): boolean => {
    if (!(ev.metaKey || ev.ctrlKey)) return false;
    if (ev.key === "=" || ev.key === "+") stepZoomRef.current(1);
    else if (ev.key === "-") stepZoomRef.current(-1);
    else if (ev.key === "0") setZoomRef.current("fit");
    else if (ev.key === "1") setZoomRef.current(1);
    else return false;
    ev.preventDefault();
    return true;
  };
  const handleZoomKeyRef = useRef(handleZoomKey);
  handleZoomKeyRef.current = handleZoomKey;

  useEffect(() => {
    if (mode === "code") return;
    const onKey = (ev: KeyboardEvent) => {
      if (handleZoomKeyRef.current(ev)) return;
      // Nudge/Delete when focus is on the PARENT app (the iframe has its own copy of this for
      // when IT is focused). A keydown only reaches one document, so no double-firing. Skip
      // while typing in a field.
      if (mode !== "live") return;
      const t = ev.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      // Escape deselects even when focus is on the app chrome (the iframe handler only fires
      // when the canvas is focused — a keydown reaches one document, so no double-firing).
      if (ev.key === "Escape" && (activeImageRef.current || nudgeRef.current)) {
        ev.preventDefault();
        if (contentModeRef.current) setContentMode(false);
        else clearSelectionsRef.current();
        return;
      }
      // ⌘]/⌘[ reorder the selection (bring forward / send backward) — image or block.
      if ((ev.metaKey || ev.ctrlKey) && (ev.key === "]" || ev.key === "[") && (activeImageRef.current || nudgeRef.current)) {
        ev.preventDefault();
        reorderSelectedRef.current(ev.key === "]" ? "down" : "up");
        return;
      }
      // A selected image: Delete/Backspace removes it (blocks handled below via nudge).
      if ((ev.key === "Delete" || ev.key === "Backspace") && activeImageRef.current) {
        ev.preventDefault();
        deleteSelectedImageRef.current();
        return;
      }
      const n = nudgeRef.current;
      if (!n) return;
      if (ev.key === "Delete" || ev.key === "Backspace") {
        ev.preventDefault();
        onRequestDeleteRef.current([n.pcId, ...extraIdsRef.current]);
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
      applyDeltaRef.current(captureBasesRef.current(), d[0], d[1]);
    };
    window.addEventListener("keydown", onKey);
    const canvas = canvasRef.current;
    const onWheel = (ev: WheelEvent) => {
      if (!(ev.metaKey || ev.ctrlKey)) return; // plain wheel = pan/scroll
      ev.preventDefault();
      stepZoomRef.current(ev.deltaY < 0 ? 1 : -1);
    };
    canvas?.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      window.removeEventListener("keydown", onKey);
      canvas?.removeEventListener("wheel", onWheel);
    };
  }, [mode]);

  /** Figma-style alignment: 1 element aligns to the page body, 2+ align within the selection box. */
  const alignSelection = (op: AlignOp) => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc?.body || !nudgeRef.current) return;
    const els = selectedIds()
      .map((id) => nudgeEl(id))
      .filter((el): el is HTMLElement => Boolean(el));
    if (!els.length) return;
    if ((op === "distH" || op === "distV") && els.length < 3) return;
    const rects = els.map((el) => el.getBoundingClientRect());
    const ref =
      els.length === 1
        ? doc.body.getBoundingClientRect()
        : {
            left: Math.min(...rects.map((r) => r.left)),
            right: Math.max(...rects.map((r) => r.right)),
            top: Math.min(...rects.map((r) => r.top)),
            bottom: Math.max(...rects.map((r) => r.bottom)),
          };
    const jobs: { el: HTMLElement; dx: number; dy: number }[] = [];
    if (op === "distH" || op === "distV") {
      const horiz = op === "distH";
      const items = els
        .map((el, i) => ({ el, c: horiz ? rects[i].left + rects[i].width / 2 : rects[i].top + rects[i].height / 2 }))
        .sort((a, b) => a.c - b.c);
      const first = items[0].c;
      const gap = (items[items.length - 1].c - first) / (items.length - 1);
      items.forEach((it, i) => {
        const d = first + gap * i - it.c;
        jobs.push({ el: it.el, dx: horiz ? d : 0, dy: horiz ? 0 : d });
      });
    } else {
      els.forEach((el, i) => {
        const r = rects[i];
        let dx = 0;
        let dy = 0;
        if (op === "left") dx = ref.left - r.left;
        else if (op === "centerH") dx = (ref.left + ref.right) / 2 - (r.left + r.width / 2);
        else if (op === "right") dx = ref.right - r.right;
        else if (op === "top") dy = ref.top - r.top;
        else if (op === "centerV") dy = (ref.top + ref.bottom) / 2 - (r.top + r.height / 2);
        else if (op === "bottom") dy = ref.bottom - r.bottom;
        jobs.push({ el, dx, dy });
      });
    }
    const batch: { pcId: string; translateX: number; translateY: number; marginTop: number | null }[] = [];
    for (const { el, dx, dy } of jobs) {
      const id = el.getAttribute("data-pc-id")!;
      const b = readNudge(el);
      const x = b.x + dx * PX_TO_MM;
      const y = b.y + dy * PX_TO_MM;
      el.style.transform = x || y ? `translate(${x.toFixed(1)}mm, ${y.toFixed(1)}mm)` : "";
      const cur = nudgeRef.current;
      if (cur && cur.pcId === id) {
        const next: NudgeState = { ...cur, x, y };
        nudgeRef.current = next;
        setNudge(next);
      }
      batch.push({ pcId: id, translateX: x, translateY: y, marginTop: b.marginTop });
    }
    void client.setElementStyles(batch).then(() => setDirty(true));
    reportSelectionRef.current();
  };
  const alignRefLocal = useRef(alignSelection);
  alignRefLocal.current = alignSelection;
  useEffect(() => {
    registerAlign((op) => alignRefLocal.current(op));
    return () => registerAlign(null);
  }, [registerAlign]);

  /** One place all persistence flows through: mark dirty on success, surface failures instead
   *  of silently dropping the edit (a bridge hiccup used to revert the change on next reload). */
  const persist = (p: Promise<unknown>): Promise<void> =>
    p.then(() => setDirty(true)).catch((e) => {
      toast.error("Couldn't save that change", { description: e instanceof Error ? e.message : String(e) });
    });

  /** Apply property-panel styles to the LIVE element (so the frozen iframe updates in place)
   *  AND persist to page.html. Kebab-case props; "" removes a property. */
  const applyElementProps = (id: string, props: Record<string, string>) => {
    const el = nudgeEl(id);
    if (el) {
      for (const [k, v] of Object.entries(props)) {
        if (v === "") el.style.removeProperty(k);
        else el.style.setProperty(k, v);
      }
    }
    void persist(client.setElementProps(id, props));
    reportSelectionRef.current(); // refresh the panel's shown values from the new computed style
  };
  const applyPropsRef = useRef(applyElementProps);
  applyPropsRef.current = applyElementProps;
  useEffect(() => {
    registerApplyProps((id, props) => applyPropsRef.current(id, props));
    return () => registerApplyProps(null);
  }, [registerApplyProps]);

  /** Set a block's absolute position (the nudge translate + optional top margin) from the
   *  Inspector — patches the LIVE element so the frozen iframe reflects it immediately (the
   *  old path persisted only, so X/Y edits & Reset were invisible until deselect). */
  const setBlockPosition = (id: string, x: number, y: number, marginTop: number | null) => {
    const el = nudgeEl(id);
    if (el) {
      el.style.transform = x || y ? `translate(${x.toFixed(1)}mm, ${y.toFixed(1)}mm)` : "";
      if (marginTop === null) el.style.removeProperty("margin-top");
      else el.style.marginTop = `${marginTop.toFixed(1)}mm`;
    }
    const n = nudgeRef.current;
    if (n && n.pcId === id) {
      const next = { ...n, x, y, marginTop };
      nudgeRef.current = next;
      setNudge(next);
    }
    void persist(client.setElementStyle(id, { translateX: x, translateY: y, marginTop }));
    reportSelectionRef.current();
  };
  const setPositionRef = useRef(setBlockPosition);
  setPositionRef.current = setBlockPosition;
  useEffect(() => {
    registerSetPosition?.((id, x, y, mt) => setPositionRef.current(id, x, y, mt));
    return () => registerSetPosition?.(null);
  }, [registerSetPosition]);

  /** Select an element from the Layers panel by dispatching a click in the iframe (reuses
   *  the exact same selection path as a canvas click). */
  const selectLayerById = (id: string) => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;
    const el =
      doc.querySelector<HTMLElement>(`[data-pc-id="${id}"]`) ?? doc.querySelector<HTMLElement>(`img[data-image-id="${id}"]`);
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: doc.defaultView! }));
  };
  const selectLayerRef = useRef(selectLayerById);
  selectLayerRef.current = selectLayerById;
  useEffect(() => {
    registerSelectLayer?.((id) => selectLayerRef.current(id));
    return () => registerSelectLayer?.(null);
  }, [registerSelectLayer]);

  /** Read the live document's manipulable elements (in paint order) for the Layers panel. */
  const emitLayers = () => {
    const doc = iframeRef.current?.contentDocument;
    const win = doc?.defaultView;
    if (!doc || !win || !onLayers) return;
    const seen = new Set<string>();
    const items: LayerItem[] = [];
    doc.querySelectorAll<HTMLElement>("[data-pc-id], img[data-image-id]").forEach((el) => {
      if (el.hasAttribute("data-img-slot")) return; // the crop-slot wrapper isn't its own layer
      const imgId = el.getAttribute("data-image-id");
      const id = imgId ?? el.getAttribute("data-pc-id")!;
      if (!id || seen.has(id)) return;
      seen.add(id);
      const kind: LayerItem["kind"] = imgId ? "image" : el.querySelector("[data-pc-id], img[data-image-id]") ? "box" : "text";
      const label = imgId ?? el.textContent?.trim().slice(0, 28) ?? id;
      const z = win.getComputedStyle(el).zIndex;
      items.push({ id, kind, label: label || id, z: z && z !== "auto" ? z : "auto" });
    });
    onLayers(items);
  };
  const emitLayersRef = useRef(emitLayers);
  emitLayersRef.current = emitLayers;

  // After an undo/redo the iframe reloads — then we scroll to and flash what changed.
  const pendingFlashRef = useRef<string[] | null>(null);
  const announceHistory = (label: "Undo" | "Redo", changed: string[]) => {
    setDirty(true);
    pendingFlashRef.current = changed.length ? changed : null;
    toast(label, {
      description: changed.length
        ? `Changed ${changed.length === 1 ? "" : `${changed.length} elements: `}${changed.slice(0, 4).join(", ")}${changed.length > 4 ? "…" : ""}`
        : "Page state restored",
    });
  };
  /** ⌘]/⌘[ + Layers panel: reorder the selected element (image or block) in the flow, which
   *  changes paint/stacking order. Clears the selection so the frozen iframe reloads. */
  const reorderSelected = (dir: "up" | "down") => {
    const id = activeImageRef.current ?? nudgeRef.current?.pcId;
    if (!id) return;
    clearSelectionsRef.current();
    void client.moveElement(id, dir).then(() => setDirty(true)).catch(() => {});
  };
  const reorderSelectedRef = useRef(reorderSelected);
  reorderSelectedRef.current = reorderSelected;
  /** Delete the selected image (whole slot/frame/img). Returns true if it handled a selection. */
  const deleteSelectedImage = (): boolean => {
    const id = activeImageRef.current;
    if (!id) return false;
    clearSelectionsRef.current();
    void client.deleteImage(id).then(() => setDirty(true)).catch(() => {});
    return true;
  };
  const deleteSelectedImageRef = useRef(deleteSelectedImage);
  deleteSelectedImageRef.current = deleteSelectedImage;

  const doUndo = () => {
    clearSelectionsRef.current();
    void client.undoPage().then(({ changed }) => announceHistory("Undo", changed)).catch((e) => toast.error(e instanceof Error ? e.message : "Undo failed"));
  };
  const doRedo = () => {
    clearSelectionsRef.current();
    void client.redoPage().then(({ changed }) => announceHistory("Redo", changed)).catch((e) => toast.error(e instanceof Error ? e.message : "Redo failed"));
  };
  // Add a new element the generation didn't create. It lands at the page's top-left as a
  // freely-positioned block; the live reload flashes it and the user drags/edits from there.
  const addElement = (kind: "text" | "heading" | "rect" | "divider") => {
    void client
      .insertElement(kind)
      .then(({ id }) => {
        pendingFlashRef.current = [id];
        setDirty(true);
      })
      .catch((e) => toast.error("Couldn't add that element", { description: e instanceof Error ? e.message : String(e) }));
  };
  const doUndoRef = useRef(doUndo);
  doUndoRef.current = doUndo;
  const doRedoRef = useRef(doRedo);
  doRedoRef.current = doRedo;

  // ⌘Z / ⇧⌘Z from the app window (the iframe handles its own copy below).
  useEffect(() => {
    if (mode !== "live") return;
    const onKey = (ev: KeyboardEvent) => {
      if (!(ev.metaKey || ev.ctrlKey) || ev.key.toLowerCase() !== "z") return;
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return; // native field undo wins
      ev.preventDefault();
      if (ev.shiftKey) doRedoRef.current();
      else doUndoRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode]);

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

  // Leaving live mode drops the selection; entering code mode loads the source.
  useEffect(() => {
    if (mode !== "live") {
      clearSelectionsRef.current();
      onLayers?.([]); // the Layers panel only reflects the live document
    }
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
      /* box-shadow is stripped from the print/export PDF (Chromium renders its blur as a
         hard solid rectangle artifact), so strip it in live edit too — keeps the preview
         true WYSIWYG with the deliverable. The editor's own drop-indicator shadows below
         use a higher-specificity class selector, so they survive this reset. */
      * { box-shadow: none !important; }
      [data-pc-id]:hover { outline: 2px dashed rgba(245,158,11,.7); outline-offset: 2px; cursor: move; }
      .pc-nudge-active { outline: 2px solid rgba(245,158,11,1) !important; outline-offset: 2px; cursor: move !important; }
      [data-pc-id][contenteditable] { outline: 2px solid rgba(120,120,255,.95) !important; outline-offset: 2px; cursor: text !important; }
      .pc-drop-before { box-shadow: inset 0 4px 0 0 rgba(59,130,246,.9) !important; }
      .pc-drop-after { box-shadow: inset 0 -4px 0 0 rgba(59,130,246,.9) !important; }
      .pc-dragging { opacity: .6; }
      img[data-image-id]:hover { outline: 2px dashed rgba(52,199,89,.8); outline-offset: 2px; cursor: pointer; }
      img[data-image-id].pc-active { outline: 2px solid rgba(52,199,89,1); outline-offset: 2px; cursor: grab; }
      .pc-flash { outline: 3px solid rgba(59,130,246,.95) !important; outline-offset: 3px; }
    `;
    doc.head.appendChild(style);

    // Undo/redo landed a moment ago: show the user WHERE the change happened.
    const flashIds = pendingFlashRef.current;
    if (flashIds) {
      pendingFlashRef.current = null;
      const targets = flashIds
        .map((id) => doc.querySelector<HTMLElement>(`[data-pc-id="${id}"]`))
        .filter((el): el is HTMLElement => Boolean(el));
      if (targets.length) {
        // Flash the changed element in place. We deliberately do NOT scrollIntoView —
        // yanking the canvas on every undo/redo was jarring; the highlight is enough.
        targets.forEach((el) => el.classList.add("pc-flash"));
        setTimeout(() => targets.forEach((el) => el.classList.remove("pc-flash")), 1800);
      }
    }

    // An element holding other blocks must never become contenteditable: blurring it
    // would replace ALL of its children with flat text. Rule: ANY non-inline child.
    const INLINE_TAGS = new Set(["B", "I", "EM", "STRONG", "SPAN", "A", "BR", "SMALL", "SUP", "SUB", "CODE", "U", "MARK", "WBR", "TIME", "ABBR"]);
    const isStructural = (el: HTMLElement) =>
      Boolean(el.querySelector("[data-pc-id], [data-image-id], img")) ||
      [...el.children].some(
        (child) =>
          !INLINE_TAGS.has(child.tagName.toUpperCase()) ||
          doc.defaultView!.getComputedStyle(child).display !== "inline", // a block-displayed span is structure too
      );

    /** Select an element. additive (shift-click) grows/toggles the selection set. */
    const selectForNudge = (el: HTMLElement, additive = false) => {
      const id = el.getAttribute("data-pc-id")!;
      const current = nudgeRef.current;
      if (additive && current) {
        if (current.pcId === id || extraIdsRef.current.includes(id)) {
          // shift-click on an already-selected element toggles it OUT of the set
          el.classList.remove("pc-nudge-active");
          if (current.pcId === id) {
            const [nextId, ...rest] = extraIdsRef.current;
            if (!nextId) return clearSelectionsRef.current();
            extraIdsRef.current = rest;
            const nel = doc.querySelector<HTMLElement>(`[data-pc-id="${nextId}"]`);
            const next = { pcId: nextId, ...(nel ? readNudge(nel) : { x: 0, y: 0, marginTop: null }) };
            nudgeRef.current = next;
            setNudge(next);
          } else {
            extraIdsRef.current = extraIdsRef.current.filter((x) => x !== id);
          }
          reportSelectionRef.current();
          return;
        }
        el.classList.add("pc-nudge-active");
        extraIdsRef.current = [...extraIdsRef.current, id];
        reportSelectionRef.current();
        return;
      }
      doc.querySelectorAll(".pc-nudge-active").forEach((other) => other.classList.remove("pc-nudge-active"));
      doc.querySelectorAll("img.pc-active").forEach((other) => other.classList.remove("pc-active"));
      setActiveImage(null);
      extraIdsRef.current = [];
      el.classList.add("pc-nudge-active");
      const next = { pcId: id, ...readNudge(el) };
      nudgeRef.current = next; // sync, so keystrokes right after the click see the selection
      setNudge(next);
      reportSelectionRef.current();
    };

    const clearDropMarkers = () =>
      doc.querySelectorAll(".pc-drop-before, .pc-drop-after").forEach((el) => el.classList.remove("pc-drop-before", "pc-drop-after"));

    // Click-to-drill: the user clicked INSIDE a tagged block, on an element that has no
    // pc-id of its own (a stat number, a badge, a caption span…). Tag it on the spot so
    // it becomes independently editable, then operate on it instead of the ancestor.
    const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const pathOf = (node: HTMLElement): string => {
      const parts: string[] = [];
      let cur: HTMLElement | null = node;
      while (cur && cur.tagName !== "BODY") {
        const parent: HTMLElement | null = cur.parentElement;
        if (!parent) return "";
        parts.unshift(`*:nth-child(${Array.prototype.indexOf.call(parent.children, cur) + 1})`);
        cur = parent;
      }
      return cur ? `body > ${parts.join(" > ")}` : "";
    };
    const autoTag = async (node: HTMLElement): Promise<string | null> => {
      const path = pathOf(node);
      if (!path) return null;
      const base = slugify(node.className.toString().split(/\s+/)[0] || node.tagName) || "el";
      const id = `${base}-${Math.random().toString(36).slice(2, 6)}`;
      node.setAttribute("data-pc-id", id); // optimistic — the iframe copy is live immediately
      try {
        await client.tagElement(path, id);
        return id;
      } catch {
        node.removeAttribute("data-pc-id");
        return null;
      }
    };
    /** The precise element the user clicked, drilled below the handler's element. */
    const drillTarget = (ev: MouseEvent, el: HTMLElement): HTMLElement => {
      const raw = ev.target && (ev.target as Node).nodeType === 1 ? (ev.target as HTMLElement) : null; // realm-safe: iframe Element !== parent Element
      if (!raw || raw === el) return el;
      if (raw.hasAttribute("data-image-id") || raw.tagName === "BODY" || raw.tagName === "HTML") return el;
      return raw;
    };

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

    /** Collapse source-formatting whitespace (newlines + indentation) in the element's
     *  text nodes. Rendering already collapses it visually, but contenteditable exposes
     *  it as a phantom leading space/indent — and a committed edit would save it. */
    const normalizeWhitespace = (elm: HTMLElement) => {
      const walker = doc.createTreeWalker(elm, 4 /* NodeFilter.SHOW_TEXT — realm-safe constant */);
      const nodes: Text[] = [];
      while (walker.nextNode()) nodes.push(walker.currentNode as Text);
      nodes.forEach((n, i) => {
        let s = n.data.replace(/\s+/g, " ");
        if (i === 0) s = s.replace(/^ /, "");
        if (i === nodes.length - 1) s = s.replace(/ $/, "");
        if (s !== n.data) n.data = s;
      });
    };

    /** Begin an inline text edit with a one-shot blur commit (change-detected). */
    const beginTextEdit = (elm: HTMLElement) => {
      // Text editing and drag-selection are mutually exclusive — drop any block selection.
      doc.querySelectorAll(".pc-nudge-active").forEach((other) => other.classList.remove("pc-nudge-active"));
      nudgeRef.current = null;
      extraIdsRef.current = [];
      setNudge(null);
      normalizeWhitespace(elm);
      const cs = doc.defaultView!.getComputedStyle(elm);
      onSelect({
        kind: "text",
        id: elm.getAttribute("data-pc-id")!,
        tag: elm.tagName,
        text: elm.textContent ?? "",
        styles: { fontSize: cs.fontSize, fontWeight: cs.fontWeight, lineHeight: cs.lineHeight, color: cs.color, textAlign: cs.textAlign },
      });
      const original = elm.textContent ?? "";
      elm.setAttribute("contenteditable", "plaintext-only");
      elm.focus();
      elm.addEventListener(
        "blur",
        () => {
          elm.removeAttribute("contenteditable");
          const text = elm.textContent ?? "";
          if (text === original) return; // click-in, click-out: touch nothing
          void actions.updateCopy(elm.getAttribute("data-pc-id")!, text).then(() => setDirty(true));
        },
        { once: true },
      );
    };

    /** True while an inline text edit is open and the event landed inside it. */
    const insideOpenEdit = (ev: Event): boolean => {
      const editing = doc.querySelector<HTMLElement>("[contenteditable]");
      const t = ev.target && (ev.target as Node).nodeType === 1 ? (ev.target as Element) : null; // realm-safe
      return Boolean(editing && t && (editing === t || editing.contains(t)));
    };

    // Single click = select (shift adds to the set). Double click = edit text.
    doc.querySelectorAll<HTMLElement>("[data-pc-id]").forEach((el) => {
      el.addEventListener("click", (ev) => {
        ev.stopPropagation(); // innermost tagged block wins — never bubble to containers
        if (insideOpenEdit(ev)) return; // caret placement inside an open edit — leave it alone
        ev.preventDefault();
        const additive = ev.shiftKey;
        void (async () => {
          // Drill to the exact element under the cursor; tag it if it's untagged.
          let target = drillTarget(ev, el);
          if (target !== el && !target.hasAttribute("data-pc-id")) {
            const id = await autoTag(target);
            if (!id) target = el;
          }
          selectForNudge(target, additive);
        })();
      });
      el.addEventListener("dblclick", (ev) => {
        ev.stopPropagation();
        if (ev.shiftKey || insideOpenEdit(ev)) return;
        // The single-click leg already drilled and tagged; resolve the same target.
        const target = drillTarget(ev, el);
        const editable = target.hasAttribute("data-pc-id") ? target : el;
        if (isStructural(editable)) return; // containers stay selected — text editing is leaf-only
        ev.preventDefault();
        beginTextEdit(editable);
      });
    });

    // Drag, delegated at the document level so it works for any selected element —
    // including ones tagged a moment ago. Plain drag moves EVERY selected element
    // (smart-align + grid snap on the grabbed one); ⌥-drag (single selection only)
    // reorders in document flow.
    let drag: {
      el: HTMLElement;
      x: number; y: number;
      bases: Map<string, Omit<NudgeState, "pcId">>;
      reorder: boolean; target: HTMLElement | null; after: boolean;
      baseRect?: DOMRect; alignV?: number[]; alignH?: number[];
      lastDx?: number; lastDy?: number; // last committed delta (mm), for the on-release sync
    } | null = null;
    doc.addEventListener("mousedown", (ev) => {
      const n = nudgeRef.current;
      if (!n) return;
      const t = ev.target && (ev.target as Node).nodeType === 1 ? (ev.target as Element) : null; // realm-safe
      if (!t) return;
      const ids = [n.pcId, ...extraIdsRef.current];
      const els = ids.map((id) => doc.querySelector<HTMLElement>(`[data-pc-id="${id}"]`));
      const grabbed = els.find((el) => el && (el === t || el.contains(t)));
      if (!grabbed) return; // drag starts on a selected element
      ev.preventDefault();
      const bases = new Map<string, Omit<NudgeState, "pcId">>();
      els.forEach((el, i) => el && bases.set(ids[i], readNudge(el)));
      drag = { el: grabbed, x: ev.clientX, y: ev.clientY, bases, reorder: ev.altKey && ids.length === 1, target: null, after: false };
      if (drag.reorder) {
        grabbed.classList.add("pc-dragging");
      } else {
        drag.baseRect = grabbed.getBoundingClientRect();
        const v: number[] = [];
        const h: number[] = [];
        doc.querySelectorAll<HTMLElement>("[data-pc-id], img[data-image-id]").forEach((other) => {
          const otherId = other.getAttribute("data-pc-id");
          if (otherId && ids.includes(otherId)) return; // selected elements are moving — not align targets
          if (els.some((el) => el && (el.contains(other) || other.contains(el)))) return;
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
      if (!nudgeRef.current) return (drag = null) as unknown as void;
      if (drag.reorder) {
        clearDropMarkers();
        const under = doc.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>("[data-pc-id]");
        if (under && under !== drag.el && !drag.el.contains(under) && !under.contains(drag.el)) {
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
      let dxmm = dxPx * PX_TO_MM;
      let dymm = dyPx * PX_TO_MM;
      if (showGridRef.current) {
        // Snap the grabbed element's translate to the grid; the set moves in lockstep.
        const gb = drag.bases.get(drag.el.getAttribute("data-pc-id")!) ?? { x: 0, y: 0, marginTop: null };
        if (!vLines.length) {
          const g = Math.round((gb.x + dxmm) / GRID_MM) * GRID_MM;
          if (Math.abs(g - (gb.x + dxmm)) <= GRID_SNAP_MM) dxmm = g - gb.x;
        }
        if (!hLines.length) {
          const g = Math.round((gb.y + dymm) / GRID_MM) * GRID_MM;
          if (Math.abs(g - (gb.y + dymm)) <= GRID_SNAP_MM) dymm = g - gb.y;
        }
      }
      drag.lastDx = dxmm;
      drag.lastDy = dymm;
      applyDeltaRef.current(drag.bases, dxmm, dymm, true); // live: DOM only, no per-frame re-render
    });
    doc.addEventListener("mouseup", () => {
      if (!drag) return;
      const d = drag;
      drag = null;
      d.el.classList.remove("pc-dragging");
      clearDropMarkers();
      guides.clear();
      if (d.reorder && d.target) {
        const id = d.el.getAttribute("data-pc-id")!;
        const beforeId = d.target.getAttribute("data-pc-id")!;
        clearSelectionsRef.current();
        void persist(client.moveElementBefore(id, beforeId, d.after));
      } else if (d.lastDx !== undefined) {
        // Commit the final position to React state + Inspector once (drag frames skipped it).
        applyDeltaRef.current(d.bases, d.lastDx, d.lastDy ?? 0, false);
      }
    });

    // Keyboard: arrows nudge the whole selection, Escape ends an edit or deselects,
    // Delete asks to remove the selection, ⌘Z/⇧⌘Z undo/redo.
    doc.addEventListener("keydown", (ev) => {
      if (handleZoomKeyRef.current(ev)) return;
      if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "z") {
        if (doc.querySelector("[contenteditable]")) return; // let the browser handle in-edit undo
        ev.preventDefault();
        if (ev.shiftKey) doRedoRef.current();
        else doUndoRef.current();
        return;
      }
      if (ev.key === "Escape") {
        const editing = doc.querySelector<HTMLElement>("[contenteditable]");
        if (editing) return editing.blur(); // commit-on-blur ends the text edit
        if (contentModeRef.current) return setContentMode(false); // exit photo-adjust first
        clearSelectionsRef.current();
        return;
      }
      // ⌘]/⌘[ reorder the selection; a selected image deletes on Delete/Backspace.
      if ((ev.metaKey || ev.ctrlKey) && (ev.key === "]" || ev.key === "[") && (activeImageRef.current || nudgeRef.current)) {
        ev.preventDefault();
        reorderSelectedRef.current(ev.key === "]" ? "down" : "up");
        return;
      }
      if ((ev.key === "Delete" || ev.key === "Backspace") && activeImageRef.current) {
        ev.preventDefault();
        deleteSelectedImageRef.current();
        return;
      }
      const n = nudgeRef.current;
      if (!n) return; // text edits keep their keystrokes — selection is null while editing
      if (ev.key === "Delete" || ev.key === "Backspace") {
        ev.preventDefault();
        onRequestDelete([n.pcId, ...extraIdsRef.current]);
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
      applyDeltaRef.current(captureBases(), d[0], d[1]);
    });

    // Image slots: click selects. The parent overlay + toolbar then own move/crop/resize/
    // scale — all in the parent window so a drag survives the cursor leaving the image and
    // never re-renders React per frame.
    doc.querySelectorAll<HTMLImageElement>("img[data-image-id]").forEach((img) => {
      const id = img.getAttribute("data-image-id")!;
      img.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        doc.querySelectorAll(".pc-nudge-active").forEach((other) => other.classList.remove("pc-nudge-active"));
        nudgeRef.current = null;
        extraIdsRef.current = [];
        setNudge(null);
        doc.querySelectorAll("img.pc-active").forEach((other) => other.classList.remove("pc-active"));
        if (activeImageRef.current === id) {
          setActiveImage(null);
          setImgTool(null);
          setContentMode(false);
          onSelect(null);
        } else {
          img.classList.add("pc-active");
          setActiveImage(id);
          setContentMode(false);
          anchorImgToolRef.current(img, id);
          onSelect({ kind: "image", id, tag: "IMG" });
        }
      });
      // Double-click enters CONTENT mode — adjust the photo inside the frame (pan + zoom).
      img.addEventListener("dblclick", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (activeImageRef.current !== id) {
          img.classList.add("pc-active");
          setActiveImage(id);
          anchorImgToolRef.current(img, id);
          onSelect({ kind: "image", id, tag: "IMG" });
        }
        setContentMode(true);
      });
    });

    emitLayersRef.current(); // refresh the Layers panel for this (re)armed document

    // Legacy pages: normalize images to the layer form NOW (nothing is selected on a fresh
    // arm, so the iframe reloads freely). Bounded to avoid a loop if compile can't add a frame.
    const hasUncompiledImg = doc.querySelector("img[data-image-id]") && !doc.querySelector("[data-img-frame]");
    const busySelecting = Boolean(nudgeRef.current || activeImageRef.current);
    if (hasUncompiledImg && !busySelecting && compileTriesRef.current < 2) {
      compileTriesRef.current += 1;
      void actions.render().then(() => setDirty(false));
    }
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
    <main className="relative flex min-h-0 min-w-0 flex-col">
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
          <span className="hidden items-center gap-1.5 whitespace-nowrap text-[11px] text-muted-foreground xl:flex">
            <MousePointerClick className="size-3.5 shrink-0" />
            click selects · ⇧-click adds · double-click edits text
          </span>
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

      {mode !== "code" && (
        <div className="absolute left-3 top-1/2 z-10 flex -translate-y-1/2 flex-col items-center gap-0.5 rounded-lg border bg-background/95 p-1 shadow-md backdrop-blur">
          {mode === "live" && (
            <>
              <Button variant="ghost" size="icon-sm" title="Undo (⌘Z)" aria-label="Undo" disabled={project.history.undo === 0} onClick={doUndo}>
                <Undo2 />
              </Button>
              <Button variant="ghost" size="icon-sm" title="Redo (⇧⌘Z)" aria-label="Redo" disabled={project.history.redo === 0} onClick={doRedo}>
                <Redo2 />
              </Button>
              <div className="my-0.5 h-px w-5 bg-border" />
              <Button
                variant={showGrid ? "secondary" : "ghost"}
                size="icon-sm"
                title="5mm grid — drags snap to it (smart-align to neighbors always on)"
                aria-label="Toggle grid"
                onClick={() => setShowGrid(!showGrid)}
              >
                <Grid3x3 />
              </Button>
              <div className="my-0.5 h-px w-5 bg-border" />
              <Button variant="ghost" size="icon-sm" title="Add a text box" aria-label="Add text" onClick={() => addElement("text")}>
                <Type />
              </Button>
              <Button variant="ghost" size="icon-sm" title="Add a heading" aria-label="Add heading" onClick={() => addElement("heading")}>
                <Heading />
              </Button>
              <Button variant="ghost" size="icon-sm" title="Add a rectangle / tint block" aria-label="Add rectangle" onClick={() => addElement("rect")}>
                <Square />
              </Button>
              <Button variant="ghost" size="icon-sm" title="Add a divider line" aria-label="Add divider" onClick={() => addElement("divider")}>
                <Minus />
              </Button>
              <div className="my-0.5 h-px w-5 bg-border" />
            </>
          )}
          <Button variant="ghost" size="icon-sm" title="Zoom in (⌘+)" aria-label="Zoom in" onClick={() => stepZoom(1)}>
            <ZoomIn />
          </Button>
          <Button variant="ghost" size="icon-sm" title="Zoom out (⌘-)" aria-label="Zoom out" onClick={() => stepZoom(-1)}>
            <ZoomOut />
          </Button>
          <button
            className="w-full rounded px-0.5 py-0.5 text-center font-mono text-[9px] tabular-nums text-muted-foreground hover:bg-accent"
            title="Click: 100% (⌘1) · double-click: fit (⌘0)"
            onClick={() => setZoom(1)}
            onDoubleClick={() => setZoom("fit")}
          >
            {Math.round(zoomVal * 100)}%
          </button>
          <Button variant={zoom === "fit" ? "secondary" : "ghost"} size="icon-sm" title="Fit to width (⌘0)" aria-label="Fit to width" onClick={() => setZoom("fit")}>
            <Maximize />
          </Button>
        </div>
      )}

      {mode === "code" ? (
        source == null ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">loading source…</div>
        ) : (
          <div className="min-h-0 flex-1 overflow-hidden [&_.cm-editor]:h-full [&_.cm-editor]:text-xs [&_.cm-panel]:border-t [&_.cm-panel]:bg-muted [&_.cm-panel]:text-xs [&_.cm-panel_input]:rounded [&_.cm-panel_input]:border [&_.cm-panel_input]:bg-background [&_.cm-panel_input]:px-1 [&_.cm-scroller]:font-mono [&_.cm-textfield]:text-foreground">
            <CodeMirror
              value={source}
              height="100%"
              theme={currentTheme() === "dark" ? oneDark : "light"}
              extensions={[html(), search({ top: true }), keymap.of(searchKeymap)]}
              onChange={(v) => {
                setSource(v);
                setSourceDirty(true);
              }}
              className="h-full"
            />
          </div>
        )
      ) : (
        <div className="relative flex min-h-0 flex-1 flex-col">
        <div ref={canvasRef} className="flex-1 overflow-auto bg-muted/30">
          <div className="mx-auto w-fit p-6">
            {mode === "proof" ? (
              viewRound != null && !roundHasProof ? (
                <p className="text-sm text-muted-foreground">
                  {roundInfo?.verdict === "edit"
                    ? `Round ${viewRound} is a chat edit — its page state is archived (and branchable), but no proof was rendered.`
                    : `No archived proof for round ${viewRound} (older run) — its issues are listed on the left.`}
                </p>
              ) : pageCount > 0 ? (
                <img
                  className="h-auto rounded-sm bg-white shadow-lg ring-1 ring-black/10"
                  style={{ width: `${art.w}mm`, zoom: zoomVal }}
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
                // allow-same-origin WITHOUT allow-scripts: the editor (parent) keeps full
                // contentDocument access, but the agent-authored page's own <script>/inline
                // handlers can never run — it may contain content copied from fetched sites.
                // Belt to the bridge's CSP braces (script-src 'none' on /files/*).
                sandbox="allow-same-origin"
                className="shrink-0 rounded-sm border-0 bg-white shadow-lg ring-1 ring-black/10"
                style={{ width: `${art.w}mm`, minHeight: `${art.h}mm`, zoom: zoomVal }}
                src={client.fileUrl("page.html", liveKey)}
                onLoad={armLiveEditing}
              />
            )}
          </div>
        </div>
        {runState !== "idle" && viewRound == null && (() => {
          const canvasEmpty = mode === "proof" ? pageCount === 0 : !project.hasPage;
          const label = runState === "queued" ? "Queued — waiting for a slot…" : project.hasPage ? "Regenerating…" : "Designing your proof…";
          return canvasEmpty ? (
            <div className="absolute inset-0 flex items-center justify-center bg-muted/40 backdrop-blur-[1px]">
              <div className="flex w-64 flex-col items-center gap-4 rounded-xl border bg-background/95 px-8 py-7 text-center shadow-xl">
                <Sparkles className="size-7 animate-pulse text-primary" />
                <div className="flex flex-col gap-1">
                  <p className="text-sm font-medium">{label}</p>
                  <p className="text-xs text-muted-foreground">The agent is designing and press-checking your piece — this can take a minute.</p>
                </div>
                <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
                  <div className="h-full w-1/3 rounded-full bg-primary/70 animate-[pc-indeterminate_1.1s_ease-in-out_infinite]" />
                </div>
                {runState === "running" && (
                  <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => actions.cancel()}>
                    <X data-slot="icon" /> Cancel generation
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center">
              <div className="pointer-events-auto flex items-center gap-2 rounded-full border bg-background/95 px-3 py-1.5 text-xs shadow-md">
                <Loader2 className="size-3.5 animate-spin text-primary" />
                <span className="font-medium">{label}</span>
                {runState === "running" && (
                  <button
                    className="ml-1 rounded-full p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                    title="Cancel generation"
                    onClick={() => actions.cancel()}
                  >
                    <X className="size-3.5" />
                  </button>
                )}
              </div>
            </div>
          );
        })()}
        </div>
      )}

      {/* Selection overlay for the active image (docs/layer-model.md §5). Default mode: body
          moves the frame, corners scale proportionally, edges crop one side. CONTENT mode
          (double-click): body pans the photo, corners zoom it. All drags run in the parent
          window with direct-DOM updates — smooth, and unbroken when the cursor leaves the img. */}
      {mode === "live" && imgTool && activeImage === imgTool.id && runState === "idle" && (
        <div
          ref={imgOverlayRef}
          className="pointer-events-none fixed z-40"
          style={{ top: imgTool.top, left: imgTool.left, width: imgTool.width, height: imgTool.height }}
        >
          <div
            className={cn(
              "pointer-events-auto absolute inset-0 border-2",
              contentMode ? "border-dashed border-sky-500/90" : "border-emerald-500/90",
            )}
            style={{ cursor: contentMode ? "grab" : "move" }}
            onPointerDown={startImgBodyDrag}
          />
          {IMG_HANDLES.map((h) => {
            const p = handlePos(h);
            return (
              <div
                key={h.k}
                onPointerDown={(e) => startImgResize(e, h)}
                className="pointer-events-auto absolute flex size-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center"
                style={{ left: p.left, top: p.top, cursor: h.cur }}
              >
                <div
                  className={cn(
                    "size-2.5 border bg-white shadow-sm dark:bg-neutral-900",
                    contentMode ? "rounded-full border-sky-600" : "rounded-[2px] border-emerald-600",
                  )}
                />
              </div>
            );
          })}
          {/* Content-mode hint: a tiny badge telling the user corners now zoom the photo. */}
          {contentMode && (
            <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-full bg-sky-600/90 px-2 py-0.5 text-[10px] font-medium text-white shadow">
              <ZoomIn className="mr-0.5 inline size-3 align-[-2px]" /> drag to pan · corners zoom
            </div>
          )}
        </div>
      )}

      {mode === "live" && imgTool && activeImage === imgTool.id && runState === "idle" && (() => {
        const slot = project.images.find((s) => s.id === imgTool.id);
        const iconBtn = (Icon: typeof Plus, title: string, onClick: () => void, disabled = false) => (
          <button
            title={title}
            disabled={disabled}
            onClick={onClick}
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent disabled:opacity-40"
          >
            <Icon className="size-3.5" />
          </button>
        );
        return (
          <div
            ref={imgToolbarRef}
            className="fixed z-50 -translate-x-1/2 -translate-y-full"
            style={{ top: imgTool.top - 8, left: imgTool.left + imgTool.width / 2 }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-1 rounded-lg border bg-background/95 p-1 shadow-xl backdrop-blur">
              {/* One selection, no Move/Crop toggle. This button just enters/leaves the
                  photo-adjust (content) mode that double-click also toggles. */}
              <button
                title={contentMode ? "Done adjusting the photo (Esc)" : "Adjust the photo inside the frame (or double-click it)"}
                onClick={() => setContentMode((v) => !v)}
                className={cn(
                  "flex items-center gap-1 rounded px-2 py-1 text-[11px] transition-colors",
                  contentMode ? "bg-sky-600 font-medium text-white" : "text-muted-foreground hover:text-foreground hover:bg-accent",
                )}
              >
                <Crop className="size-3.5" /> {contentMode ? "Done" : "Adjust photo"}
              </button>
              {slot && slot.variants.length > 1 && (
                <>
                  <div className="mx-0.5 h-4 w-px bg-border" />
                  {iconBtn(ChevronLeft, "Previous variant", () => void actions.selectVariant(slot.id, slot.current! - 1), !slot.current || slot.current <= Math.min(...slot.variants))}
                  <span className="px-0.5 text-[10px] tabular-nums text-muted-foreground">v{slot.current ?? "?"}/{slot.variants.length}</span>
                  {iconBtn(ChevronRight, "Next variant", () => void actions.selectVariant(slot.id, slot.current! + 1), !slot.current || slot.current >= Math.max(...slot.variants))}
                </>
              )}
              <div className="mx-0.5 h-4 w-px bg-border" />
              <button
                title="Delete image (⌫)"
                onClick={() => deleteSelectedImageRef.current()}
                className="rounded p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          </div>
        );
      })()}
    </main>
  );
}
