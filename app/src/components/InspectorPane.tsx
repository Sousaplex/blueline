// Contextual inspector: top half of the right rail. Shows what's selected in
// Live edit (text / block / image / multi) with its properties and the actions
// that apply — edit copy, swap/generate image variants, nudge, reorder, align,
// delete.
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalDistributeCenter,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronLeft,
  ChevronRight,
  ImagePlus,
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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { EngineClient, ProjectState } from "../engine-client";
import type { AlignOp, SelectionInfo } from "../selection";

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
}: {
  selection: SelectionInfo | null;
  project: ProjectState;
  client: EngineClient;
  /** Set when the user pressed Delete in the preview — opens the confirm dialog. */
  deleteRequestIds: string[] | null;
  onDeleteHandled: () => void;
  onDeselect: () => void;
  onAlign: (op: AlignOp) => void;
}) {
  const [textDraft, setTextDraft] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string[] | null>(null);
  const uploadInput = useRef<HTMLInputElement>(null);

  const selId = selection && selection.kind !== "multi" ? selection.id : null;
  const selText = selection && selection.kind === "text" ? (selection.text ?? "") : "";

  useEffect(() => {
    setTextDraft(selText);
    setError(null);
  }, [selId, selText]);

  // Delete key pressed in the preview → same confirm dialog as the button.
  useEffect(() => {
    if (deleteRequestIds?.length) setConfirmDelete(deleteRequestIds);
  }, [deleteRequestIds]);

  const act = (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    void fn()
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(null));
  };

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
            <Button variant="ghost" size="icon-sm" className="size-6" title="Move earlier in the page" disabled={busy !== null}
              onClick={() => act("move", () => client.moveElement(selection.id, "up"))}>
              <ArrowUp />
            </Button>
            <Button variant="ghost" size="icon-sm" className="size-6" title="Move later in the page" disabled={busy !== null}
              onClick={() => act("move", () => client.moveElement(selection.id, "down"))}>
              <ArrowDown />
            </Button>
          </>
        )}
        {(isMulti || selection.kind !== "image") && (
          <Button variant="ghost" size="icon-sm" className="size-6" title={isMulti ? "Delete selected elements" : "Delete element"} disabled={busy !== null}
            onClick={() => setConfirmDelete(isMulti ? selection.ids : [selection.id])}>
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
            <div className="grid grid-cols-3 gap-2 rounded-md border bg-muted/30 p-2 font-mono">
              <div><span className="text-muted-foreground">x</span> {selection.nudge.x.toFixed(1)}mm</div>
              <div><span className="text-muted-foreground">y</span> {selection.nudge.y.toFixed(1)}mm</div>
              <div><span className="text-muted-foreground">top</span> {selection.nudge.marginTop != null ? `${selection.nudge.marginTop.toFixed(1)}mm` : "auto"}</div>
            </div>
            <AlignRow count={1} onAlign={onAlign} />
            <p className="text-muted-foreground">
              Arrow keys nudge (⇧ = 2mm) · drag to move · <strong>⌥-drag to reorder</strong> the page flow ·
              ⇧-click to select more · Delete removes it · double-click to edit its text.
            </p>
            <Button variant="outline" size="sm" className="h-6 text-xs" disabled={busy !== null}
              onClick={() => act("reset", () => client.setElementStyle(selection.id, { translateX: 0, translateY: 0, marginTop: null }))}>
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
            <p className="text-muted-foreground">Drag the photo in the page to reposition its crop; zoom persists from the crop drag.</p>
          </div>
        )}

        {error && <p className="break-words text-destructive">{error}</p>}
      </div>

      <AlertDialog open={confirmDelete !== null} onOpenChange={(o) => { if (!o) { setConfirmDelete(null); onDeleteHandled(); } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmDelete && confirmDelete.length > 1
                ? `Delete ${confirmDelete.length} elements from the page?`
                : `Delete “${confirmDelete?.[0]}” from the page?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              Removes {confirmDelete && confirmDelete.length > 1 ? "the elements and everything inside them" : "the element and everything inside it"} from
              page.html. Undo (⌘Z) brings it straight back, and earlier review rounds keep their archived copies.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => {
                const ids = confirmDelete!;
                setConfirmDelete(null);
                onDeleteHandled();
                act("delete", async () => {
                  // Deleting a parent removes nested selections with it — tolerate
                  // per-id misses instead of aborting the rest of the set.
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
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
