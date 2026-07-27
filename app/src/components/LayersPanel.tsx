// Layers panel (docs/layer-model.md slice 5): every manipulable element in the live
// document, in paint order, with its z-index. Click to select; ↑/↓ reorder in the flow
// (which also changes stacking). Populated from the live iframe by PreviewPane.
import { ChevronDown, ChevronUp, Image as ImageIcon, Square, Type } from "lucide-react";
import { cn } from "@/lib/utils";
import type { EngineClient } from "../engine-client";
import type { LayerItem } from "../selection";

const KIND_ICON = { text: Type, image: ImageIcon, box: Square } as const;

export function LayersPanel({ layers, selectedId, client, onSelect, onReordered }: {
  layers: LayerItem[];
  selectedId: string | null;
  client: EngineClient;
  onSelect: (id: string) => void;
  onReordered: () => void;
}) {
  const move = (id: string, dir: "up" | "down") =>
    void client.moveElement(id, dir).then(onReordered).catch(() => {});

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <span className="text-xs font-medium">Layers</span>
        <span className="text-[10px] text-muted-foreground">{layers.length}</span>
      </div>
      {layers.length === 0 ? (
        <div className="p-3 text-xs text-muted-foreground">
          No layers yet — switch to <strong>Live edit</strong> to see the document's elements here.
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-1">
          {layers.map((l) => {
            const Icon = KIND_ICON[l.kind];
            const active = l.id === selectedId;
            return (
              <div
                key={l.id}
                onClick={() => onSelect(l.id)}
                className={cn(
                  "group flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-xs",
                  active ? "bg-primary/15 text-foreground" : "hover:bg-accent",
                )}
              >
                <Icon className={cn("size-3.5 shrink-0", active ? "text-primary" : "text-muted-foreground")} />
                <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{l.label}</span>
                {l.z !== "auto" && <span className="shrink-0 rounded bg-muted px-1 text-[9px] tabular-nums text-muted-foreground">z{l.z}</span>}
                <div className="flex shrink-0 opacity-0 group-hover:opacity-100">
                  <button className="rounded p-0.5 hover:bg-background" title="Bring forward (move down in flow)"
                    onClick={(e) => { e.stopPropagation(); move(l.id, "down"); }}>
                    <ChevronDown className="size-3" />
                  </button>
                  <button className="rounded p-0.5 hover:bg-background" title="Send backward (move up in flow)"
                    onClick={(e) => { e.stopPropagation(); move(l.id, "up"); }}>
                    <ChevronUp className="size-3" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
