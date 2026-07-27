// Contextual inspector: top half of the right rail. Shows what's selected in
// Live edit (text / block / image / multi) with its properties and the actions
// that apply — edit copy, swap/generate image variants, nudge, reorder, align,
// delete.
import {
  AlignCenter,
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalDistributeCenter,
  ArrowDown,
  ArrowUp,
  Bold,
  Check,
  ChevronLeft,
  ChevronRight,
  ImagePlus,
  Italic,
  Layers,
  Loader2,
  MousePointerClick,
  Move,
  Sparkles,
  Trash2,
  Type,
  Image as ImageIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { EngineClient, ProjectState } from "../engine-client";
import type { AlignOp, SelectionInfo } from "../selection";

// ---- unit helpers (property panel) ----
const PX_PER_MM = 96 / 25.4;
const numFrom = (v: string | undefined): number => Number((/(-?[\d.]+)/.exec(v ?? "") || [])[1] ?? NaN);
const pxToPt = (px: number) => (px * 72) / 96;
const ptToPx = (pt: number) => (pt * 96) / 72;
/** "rgb(r, g, b)" / "rgba(...)" → "#rrggbb"; returns null for fully transparent. */
function rgbToHex(v: string | undefined): string | null {
  if (!v) return null;
  const m = /rgba?\(([^)]+)\)/.exec(v);
  if (!m) return v.startsWith("#") ? v : null;
  const [r, g, b, a] = m[1].split(",").map((s) => parseFloat(s.trim()));
  if (a === 0) return null;
  const hex = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/** A number input that commits on Enter/blur (not every keystroke) so undo isn't spammed. */
function NumberField({ label, value, unit, onCommit, step = 1, className }: {
  label: string;
  value: number;
  unit?: string;
  step?: number;
  className?: string;
  onCommit: (n: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(Number.isFinite(value) ? String(Math.round(value * 10) / 10) : ""), [value]);
  const commit = () => {
    const n = Number(draft);
    if (Number.isFinite(n)) onCommit(n);
  };
  return (
    <label className={cn("flex items-center gap-1 rounded-md border bg-transparent px-1.5 py-1", className)}>
      <span className="shrink-0 text-[10px] text-muted-foreground">{label}</span>
      <input
        type="number"
        step={step}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        className="w-full min-w-0 bg-transparent text-right font-mono text-xs tabular-nums outline-none"
      />
      {unit && <span className="shrink-0 text-[10px] text-muted-foreground">{unit}</span>}
    </label>
  );
}

const FONT_FAMILIES = [
  ["Sans (inherit)", ""],
  ["System UI", "system-ui, sans-serif"],
  ["Inter", '"Inter", sans-serif'],
  ["Plus Jakarta Sans", '"Plus Jakarta Sans", sans-serif'],
  ["Arial", "Arial, Helvetica, sans-serif"],
  ["Georgia", "Georgia, serif"],
  ["Times", '"Times New Roman", Times, serif'],
  ["Playfair Display", '"Playfair Display", serif'],
  ["Courier", '"Courier New", monospace'],
] as const;

/** Contextual property panel for a selected text/shape element (docs/layer-model.md slice 4). */
function ElementProps({ styles, units, apply }: {
  styles: Record<string, string>;
  units: "mm" | "px";
  /** Applies kebab-case props to the live element + persists (routed through PreviewPane). */
  apply: (props: Record<string, string>) => void;
}) {
  const sizePt = Math.round(pxToPt(numFrom(styles.fontSize)) * 10) / 10;
  const isBold = Number(styles.fontWeight) >= 600 || styles.fontWeight === "bold";
  const isItalic = styles.fontStyle === "italic";
  const align = styles.textAlign || "left";
  const textHex = rgbToHex(styles.color) ?? "#111111";
  const bgHex = rgbToHex(styles.backgroundColor);
  const radiusPx = numFrom(styles.borderRadius) || 0;
  const widthMm = numFrom(styles.widthMm) || 0;
  const toDisp = (mm: number) => (units === "mm" ? mm : mm * PX_PER_MM);
  const fromDisp = (v: number) => (units === "mm" ? v : v / PX_PER_MM);

  const alignBtns: [string, React.ReactNode][] = [
    ["left", <AlignLeft />],
    ["center", <AlignCenter />],
    ["right", <AlignRight />],
    ["justify", <AlignJustify />],
  ];

  return (
    <div className="space-y-2 rounded-md border bg-muted/20 p-2">
      {/* Font family + size */}
      <div className="flex gap-1.5">
        <select
          value={FONT_FAMILIES.find(([, v]) => v && styles.fontFamily?.includes(v.split(",")[0].replace(/"/g, "")))?.[1] ?? ""}
          onChange={(e) => apply({ "font-family": e.target.value })}
          className="min-w-0 flex-1 rounded-md border bg-transparent px-1.5 py-1 text-xs outline-none"
          title="Font family"
        >
          {FONT_FAMILIES.map(([label, v]) => (
            <option key={label} value={v}>{label}</option>
          ))}
        </select>
        <NumberField label="A" value={sizePt} unit="pt" step={0.5} className="w-24"
          onCommit={(n) => apply({ "font-size": `${Math.max(1, n).toFixed(1)}pt` })} />
      </div>

      {/* Weight / italic / alignment */}
      <div className="flex items-center gap-1">
        <button title="Bold" onClick={() => apply({ "font-weight": isBold ? "400" : "700" })}
          className={cn("flex size-6 items-center justify-center rounded border", isBold ? "bg-foreground text-background" : "hover:bg-accent")}>
          <Bold className="size-3.5" />
        </button>
        <button title="Italic" onClick={() => apply({ "font-style": isItalic ? "normal" : "italic" })}
          className={cn("flex size-6 items-center justify-center rounded border", isItalic ? "bg-foreground text-background" : "hover:bg-accent")}>
          <Italic className="size-3.5" />
        </button>
        <div className="mx-0.5 h-4 w-px bg-border" />
        {alignBtns.map(([a, icon]) => (
          <button key={a} title={`Align ${a}`} onClick={() => apply({ "text-align": a })}
            className={cn("flex size-6 items-center justify-center rounded border [&_svg]:size-3.5", align === a ? "bg-foreground text-background" : "hover:bg-accent")}>
            {icon}
          </button>
        ))}
      </div>

      {/* Colors */}
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-1.5" title="Text color">
          <span className="text-[10px] text-muted-foreground">Text</span>
          <input type="color" value={textHex} onChange={(e) => apply({ color: e.target.value })}
            className="size-6 cursor-pointer rounded border bg-transparent p-0" />
        </label>
        <label className="flex items-center gap-1.5" title="Background color">
          <span className="text-[10px] text-muted-foreground">Fill</span>
          <input type="color" value={bgHex ?? "#ffffff"} onChange={(e) => apply({ background: e.target.value })}
            className="size-6 cursor-pointer rounded border bg-transparent p-0" />
        </label>
        {bgHex && (
          <button className="text-[10px] text-muted-foreground underline hover:text-foreground" onClick={() => apply({ background: "" })}>
            clear
          </button>
        )}
      </div>

      {/* Corner radius + box width */}
      <div className="flex gap-1.5">
        <NumberField label="radius" value={Math.round((radiusPx / PX_PER_MM) * 10) / 10} unit="mm" step={0.5} className="flex-1"
          onCommit={(n) => apply({ "border-radius": n > 0 ? `${n.toFixed(1)}mm` : "" })} />
        <NumberField label="width" value={Math.round(toDisp(widthMm) * 10) / 10} unit={units} step={1} className="flex-1"
          onCommit={(n) => apply({ width: `${fromDisp(n).toFixed(1)}mm` })} />
      </div>
    </div>
  );
}

const STYLE_LABELS: Record<string, string> = {
  fontSize: "size",
  fontWeight: "weight",
  lineHeight: "leading",
  color: "color",
  textAlign: "align",
};

/** Figma-style alignment strip. A single selection aligns to the page. */
function AlignRow({ count, onAlign }: { count: number; onAlign: (op: AlignOp) => void }) {
  const ops: { op: AlignOp; icon: React.ReactNode; label: string; min: number }[] = [
    { op: "left", icon: <AlignStartVertical />, label: "Align left", min: 1 },
    { op: "centerH", icon: <AlignCenterVertical />, label: "Align horizontal centers", min: 1 },
    { op: "right", icon: <AlignEndVertical />, label: "Align right", min: 1 },
    { op: "top", icon: <AlignStartHorizontal />, label: "Align top", min: 1 },
    { op: "centerV", icon: <AlignCenterHorizontal />, label: "Align vertical centers", min: 1 },
    { op: "bottom", icon: <AlignEndHorizontal />, label: "Align bottom", min: 1 },
    { op: "distH", icon: <AlignHorizontalDistributeCenter />, label: "Distribute horizontally", min: 3 },
    { op: "distV", icon: <AlignVerticalDistributeCenter />, label: "Distribute vertically", min: 3 },
  ];
  return (
    <div>
      <div className="flex items-center gap-0.5 rounded-md border bg-muted/30 p-0.5">
        {ops.map(({ op, icon, label, min }) => (
          <Button
            key={op}
            variant="ghost"
            size="icon-sm"
            className="size-6"
            title={count === 1 && min === 1 ? `${label} (of page)` : label}
            disabled={count < min}
            onClick={() => onAlign(op)}
          >
            {icon}
          </Button>
        ))}
      </div>
      <p className="mt-1 text-[10px] text-muted-foreground">
        {count === 1 ? "aligns to the page" : "aligns within the selection"}
      </p>
    </div>
  );
}

export function InspectorPane({
  selection,
  project,
  client,
  deleteRequestIds,
  onDeleteHandled,
  onDeselect,
  onAlign,
  applyProps,
  setPosition,
}: {
  selection: SelectionInfo | null;
  project: ProjectState;
  client: EngineClient;
  /** Set when the user pressed Delete in the preview — opens the confirm dialog. */
  deleteRequestIds: string[] | null;
  onDeleteHandled: () => void;
  onDeselect: () => void;
  onAlign: (op: AlignOp) => void;
  /** Apply property-panel styles to the live element + persist (routed through PreviewPane). */
  applyProps: (id: string, props: Record<string, string>) => void;
  /** Set a block's exact position on the live element + persist (routed through PreviewPane). */
  setPosition: (id: string, x: number, y: number, marginTop: number | null) => void;
}) {
  const [textDraft, setTextDraft] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [units, setUnits] = useState<"mm" | "px">(() => (localStorage.getItem("bl-units") === "px" ? "px" : "mm"));
  const toggleUnits = () => setUnits((u) => {
    const next = u === "mm" ? "px" : "mm";
    localStorage.setItem("bl-units", next);
    return next;
  });
  const uploadInput = useRef<HTMLInputElement>(null);

  const selId = selection && selection.kind !== "multi" ? selection.id : null;
  const selText = selection && selection.kind === "text" ? (selection.text ?? "") : "";

  useEffect(() => {
    setTextDraft(selText);
    setError(null);
  }, [selId, selText]);

  const act = (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    void fn()
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(null));
  };

  // Delete right away — no confirmation popup; ⌘Z restores it.
  const doDelete = (ids: string[]) => {
    act("delete", async () => {
      let failed = 0;
      for (const id of ids) {
        try {
          await client.deleteElement(id);
        } catch {
          failed++;
        }
      }
      onDeselect();
      if (failed === ids.length) throw new Error("Nothing was deleted — the elements may already be gone.");
    });
  };

  // Delete key pressed in the preview → delete immediately.
  useEffect(() => {
    if (deleteRequestIds?.length) {
      doDelete(deleteRequestIds);
      onDeleteHandled();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deleteRequestIds]);

  if (!selection) {
    return (
      <div className="flex items-center gap-2 border-b px-4 py-3 text-xs text-muted-foreground">
        <MousePointerClick className="size-3.5 shrink-0" />
        Nothing selected — click an element to select it; ⇧-click adds more; double-click text to edit.
      </div>
    );
  }

  const isMulti = selection.kind === "multi";
  const slot = !isMulti && selection.kind === "image" ? project.images.find((s) => s.id === selection.id) : undefined;
  const canReorder = !isMulti && selection.kind !== "image";

  const onUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || isMulti) return;
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = String(reader.result).split(",")[1] ?? "";
      act("upload", () => client.uploadImageVariant(selection.id, base64));
    };
    reader.readAsDataURL(file);
  };

  return (
    <div className="flex h-1/2 min-h-0 flex-col border-b">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
        {isMulti ? (
          <Layers className="size-3.5" />
        ) : selection.kind === "text" ? (
          <Type className="size-3.5" />
        ) : selection.kind === "image" ? (
          <ImageIcon className="size-3.5" />
        ) : (
          <Move className="size-3.5" />
        )}
        <span className="font-mono text-xs font-medium">
          {isMulti ? `${selection.ids.length} selected` : selection.id}
        </span>
        {!isMulti && selection.tag && (
          <Badge variant="outline" className="h-4 px-1 text-[10px]">
            {selection.tag.toLowerCase()}
          </Badge>
        )}
        <div className="flex-1" />
        {canReorder && (
          <>
            {/* Deselect first: reorder rewrites page.html, and a live selection freezes the
                iframe — without dropping it the move is invisible until the user deselects. */}
            <Button variant="ghost" size="icon-sm" className="size-6" title="Move earlier in the page" disabled={busy !== null}
              onClick={() => act("move", async () => { const id = selection.id; onDeselect(); await client.moveElement(id, "up"); })}>
              <ArrowUp />
            </Button>
            <Button variant="ghost" size="icon-sm" className="size-6" title="Move later in the page" disabled={busy !== null}
              onClick={() => act("move", async () => { const id = selection.id; onDeselect(); await client.moveElement(id, "down"); })}>
              <ArrowDown />
            </Button>
          </>
        )}
        {(isMulti || selection.kind !== "image") && (
          <Button variant="ghost" size="icon-sm" className="size-6" title={isMulti ? "Delete selected elements" : "Delete element"} disabled={busy !== null}
            onClick={() => doDelete(isMulti ? selection.ids : [selection.id])}>
            <Trash2 className="text-destructive" />
          </Button>
        )}
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 text-xs">
        {isMulti && (
          <div className="space-y-2.5">
            <AlignRow count={selection.ids.length} onAlign={onAlign} />
            <div className="flex flex-wrap gap-1">
              {selection.ids.map((id) => (
                <Badge key={id} variant="outline" className="h-5 max-w-36 truncate px-1.5 font-mono text-[10px]">
                  {id}
                </Badge>
              ))}
            </div>
            <p className="text-muted-foreground">
              Drag or arrow-key to move the whole set together · ⇧-click a selected element to drop it from
              the selection · Delete removes them all.
            </p>
          </div>
        )}

        {!isMulti && selection.kind === "text" && (
          <>
            <textarea
              className="min-h-24 w-full rounded-md border bg-transparent p-2 text-sm leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={textDraft}
              onChange={(e) => setTextDraft(e.target.value)}
            />
            <Button
              size="sm"
              className="h-7 text-xs"
              disabled={busy !== null || textDraft === (selection.text ?? "")}
              onClick={() => act("copy", () => client.updateCopy(selection.id, textDraft))}
            >
              {busy === "copy" ? <Loader2 className="animate-spin" data-slot="icon" /> : <Check data-slot="icon" />} Apply copy
            </Button>
            {selection.styles && (
              <div className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-md border bg-muted/30 p-2 font-mono">
                {Object.entries(selection.styles).map(([k, v]) => (
                  <div key={k} className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground">{STYLE_LABELS[k] ?? k}</span>
                    <span className="flex items-center gap-1 truncate">
                      {k === "color" && <span className="inline-block size-2.5 rounded-sm border" style={{ background: v }} />}
                      {v}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {!isMulti && selection.kind === "block" && selection.nudge && (
          <div className="space-y-2.5">
            {/* Position (the nudge offset) with a mm/px toggle. */}
            {(() => {
              const disp = (mm: number) => (units === "mm" ? mm : mm * PX_PER_MM);
              const toMm = (v: number) => (units === "mm" ? v : v / PX_PER_MM);
              return (
                <div className="flex items-center gap-1.5">
                  <NumberField label="X" value={Math.round(disp(selection.nudge!.x) * 10) / 10} unit={units} className="flex-1"
                    onCommit={(n) => setPosition(selection.id, toMm(n), selection.nudge!.y, selection.nudge!.marginTop)} />
                  <NumberField label="Y" value={Math.round(disp(selection.nudge!.y) * 10) / 10} unit={units} className="flex-1"
                    onCommit={(n) => setPosition(selection.id, selection.nudge!.x, toMm(n), selection.nudge!.marginTop)} />
                  <button onClick={toggleUnits} title="Toggle mm / px"
                    className="shrink-0 rounded-md border px-2 py-1 text-[10px] font-medium text-muted-foreground hover:bg-accent">
                    {units}
                  </button>
                </div>
              );
            })()}

            {selection.styles && (
              <ElementProps styles={selection.styles} units={units} apply={(props) => applyProps(selection.id, props)} />
            )}

            <AlignRow count={1} onAlign={onAlign} />
            <p className="text-muted-foreground">
              Arrow keys nudge (⇧ = 2mm) · drag to move · <strong>⌥-drag to reorder</strong> the page flow ·
              ⇧-click to select more · double-click to edit its text.
            </p>
            <Button variant="outline" size="sm" className="h-6 text-xs" disabled={busy !== null}
              onClick={() => setPosition(selection.id, 0, 0, null)}>
              Reset position
            </Button>
          </div>
        )}

        {!isMulti && selection.kind === "image" && (
          <div className="space-y-2.5">
            {slot && (
              <div className="flex items-center gap-1.5">
                <Button variant="outline" size="icon-sm" className="size-6" disabled={busy !== null || !slot.current || slot.current <= Math.min(...slot.variants)}
                  onClick={() => act("variant", () => client.selectVariant(slot.id, slot.current! - 1))}>
                  <ChevronLeft />
                </Button>
                <span className="font-mono tabular-nums">v{slot.current ?? "?"} / {slot.variants.length}</span>
                <Button variant="outline" size="icon-sm" className="size-6" disabled={busy !== null || !slot.current || slot.current >= Math.max(...slot.variants)}
                  onClick={() => act("variant", () => client.selectVariant(slot.id, slot.current! + 1))}>
                  <ChevronRight />
                </Button>
              </div>
            )}
            <div className="flex gap-2">
              <Button variant="outline" size="sm" className="h-7 text-xs" disabled={busy !== null}
                onClick={() => act("gen", () => client.generateMoreImages(selection.id))}>
                {busy === "gen" ? <Loader2 className="animate-spin" data-slot="icon" /> : <Sparkles data-slot="icon" />} Generate more
              </Button>
              <Button variant="outline" size="sm" className="h-7 text-xs" disabled={busy !== null} onClick={() => uploadInput.current?.click()}>
                <ImagePlus data-slot="icon" /> Upload…
              </Button>
              <input ref={uploadInput} type="file" accept="image/*" hidden onChange={onUpload} />
            </div>
            <p className="text-muted-foreground">
              <strong className="text-foreground">Drag</strong> to move · <strong className="text-foreground">corner</strong> scales it ·{" "}
              <strong className="text-foreground">edge</strong> crops that side · <strong className="text-foreground">⌥corner</strong> stretches.{" "}
              <strong className="text-foreground">Double-click</strong> to adjust the photo inside (pan + zoom).
            </p>
          </div>
        )}

        {error && <p className="break-words text-destructive">{error}</p>}
      </div>

    </div>
  );
}
