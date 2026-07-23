import { html } from "@codemirror/lang-html";
import { oneDark } from "@codemirror/theme-one-dark";
import CodeMirror from "@uiw/react-codemirror";
import { ChevronLeft, ChevronRight, Code2, Grid3x3, History, Loader2, Maximize, MousePointerClick, Redo2, RefreshCw, Save, Sparkles, Undo2, X, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { currentTheme } from "@/lib/theme";
import type { EngineClient, ProjectState } from "../engine-client";
import type { AlignOp, SelectionInfo } from "../selection";

type Mode = "proof" | "live" | "code";

const PX_TO_MM = 25.4 / 96;
const MM_TO_PX = 96 / 25.4;
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3];

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
  registerAlign,
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
  /** Hands the Inspector a way to trigger alignment on the current selection. */
  registerAlign: (fn: ((op: AlignOp) => void) | null) => void;
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

  const reportBlock = (n: NudgeState, tag?: string) =>
    onSelect({ kind: "block", id: n.pcId, tag, nudge: { x: n.x, y: n.y, marginTop: n.marginTop } });

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

  /** Move every selected element by (dx, dy) mm from its base; persist debounced. */
  const applyDeltaToSelection = (bases: Map<string, Omit<NudgeState, "pcId">>, dx: number, dy: number) => {
    for (const [id, b] of bases) {
      const el = nudgeEl(id);
      if (!el) continue;
      const x = b.x + dx;
      const y = b.y + dy;
      el.style.transform = x || y ? `translate(${x.toFixed(1)}mm, ${y.toFixed(1)}mm)` : "";
    }
    const n = nudgeRef.current;
    if (n && bases.has(n.pcId)) {
      const b = bases.get(n.pcId)!;
      const next = { ...n, x: b.x + dx, y: b.y + dy };
      nudgeRef.current = next; // sync, so rapid key-repeat bursts accumulate correctly
      setNudge(next);
    }
    reportSelectionRef.current();
    window.clearTimeout(persistTimer.current);
    persistTimer.current = window.setTimeout(() => {
      void client
        .setElementStyles(
          [...bases].map(([id, b]) => ({ pcId: id, translateX: b.x + dx, translateY: b.y + dy, marginTop: b.marginTop })),
        )
        .then(() => setDirty(true));
    }, 500);
  };
  const applyDeltaRef = useRef(applyDeltaToSelection);
  applyDeltaRef.current = applyDeltaToSelection;

  const clearSelections = () => {
    const doc = iframeRef.current?.contentDocument;
    doc?.querySelectorAll(".pc-nudge-active").forEach((el) => el.classList.remove("pc-nudge-active"));
    doc?.querySelectorAll("img.pc-active").forEach((el) => el.classList.remove("pc-active"));
    nudgeRef.current = null;
    extraIdsRef.current = [];
    setNudge(null);
    setActiveImage(null);
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
    const onKey = (ev: KeyboardEvent) => void handleZoomKeyRef.current(ev);
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
  const doUndo = () => {
    clearSelectionsRef.current();
    void client.undoPage().then(({ changed }) => announceHistory("Undo", changed)).catch(() => {});
  };
  const doRedo = () => {
    clearSelectionsRef.current();
    void client.redoPage().then(({ changed }) => announceHistory("Redo", changed)).catch(() => {});
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
        targets[0].scrollIntoView({ behavior: "smooth", block: "center" });
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
      applyDeltaRef.current(drag.bases, dxmm, dymm);
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
        void client.moveElementBefore(id, beforeId, d.after).then(() => setDirty(true));
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
        clearSelectionsRef.current();
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
        extraIdsRef.current = [];
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
          <div className="min-h-0 flex-1 overflow-hidden [&_.cm-editor]:h-full [&_.cm-editor]:text-xs [&_.cm-scroller]:font-mono">
            <CodeMirror
              value={source}
              height="100%"
              theme={currentTheme() === "dark" ? oneDark : "light"}
              extensions={[html()]}
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
