// Asset library modal: a big, browsable view of everything the agent works from —
// Sources (per-piece material, selectable per project) and Brand (guidelines +
// assets). Grid of cards with previews; click a card to inspect it full-size.
import { File, FileText, FileType, Palette, Plus, Trash2, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { readBase64, resolveDrop } from "@/lib/upload";
import type { EngineClient, ProjectState, SourceKind } from "../engine-client";

export type AssetTab = "sources" | "brand";

interface AssetFile {
  path: string;
  kind: SourceKind;
  size: number;
  selected?: boolean; // sources only
}

function KindGlyph({ kind, brand }: { kind: SourceKind; brand: boolean }) {
  if (kind === "text") return brand ? <Palette className="size-8 text-muted-foreground" /> : <FileText className="size-8 text-muted-foreground" />;
  if (kind === "pdf") return <FileType className="size-8 text-muted-foreground" />;
  return <File className="size-8 text-muted-foreground" />;
}

export function AssetsDialog({
  client,
  project,
  cacheKey,
  open,
  onOpenChange,
  initialTab,
}: {
  client: EngineClient;
  project: ProjectState;
  cacheKey: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialTab: AssetTab;
}) {
  const [tab, setTab] = useState<AssetTab>(initialTab);
  const [preview, setPreview] = useState<AssetFile | null>(null);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setTab(initialTab);
      setPreview(null);
      setError(null);
    }
  }, [open, initialTab]);

  const kind = tab === "brand" ? ("brand" as const) : ("context" as const);
  const files: AssetFile[] = tab === "brand" ? project.brandFiles : project.contextFiles;

  // Text preview loads lazily when a text card is opened.
  useEffect(() => {
    setTextContent(null);
    if (!preview || preview.kind !== "text") return;
    let cancelled = false;
    void fetch(client.sourceFileUrl(kind, preview.path, cacheKey))
      .then((r) => r.text())
      .then((t) => !cancelled && setTextContent(t.slice(0, 8000)))
      .catch(() => !cancelled && setTextContent("(failed to load)"));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview?.path, kind]);

  const act = (fn: () => Promise<unknown>) => {
    setError(null);
    void fn().catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };

  const uploadFiles = (entries: { relPath: string; file: File }[]) =>
    act(async () => {
      for (const { relPath, file } of entries) {
        await client.uploadSource(kind, relPath, await readBase64(file));
      }
    });

  const toggleSource = (path: string, selected: boolean) => {
    const next = project.contextFiles.filter((f) => (f.path === path ? selected : f.selected)).map((f) => f.path);
    act(() => client.selectSources(next.length === project.contextFiles.length ? null : next));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-5xl"
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          void resolveDrop(e.dataTransfer.items).then((entries) => entries.length && uploadFiles(entries));
        }}
      >
        <DialogHeader>
          <DialogTitle>Library</DialogTitle>
          <DialogDescription>
            Everything the agent works from. Sources are material for the pieces; Brand is the persistent
            identity (guidelines, logos, fonts) honored on every project.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-3">
          <Tabs value={tab} onValueChange={(v) => { setTab(v as AssetTab); setPreview(null); }}>
            <TabsList className="h-8">
              <TabsTrigger value="sources" className="text-xs">Sources ({project.contextFiles.length})</TabsTrigger>
              <TabsTrigger value="brand" className="text-xs">Brand ({project.brandFiles.length})</TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="flex-1" />
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => fileInput.current?.click()}>
            <Plus data-slot="icon" /> Add files
          </Button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              const entries = [...(e.target.files ?? [])].map((file) => ({ relPath: file.name, file }));
              e.target.value = "";
              if (entries.length) void uploadFiles(entries);
            }}
          />
        </div>

        <div
          className={cn(
            "grid max-h-[58vh] min-h-64 gap-4 rounded-md transition-colors md:grid-cols-[minmax(0,1fr)_300px]",
            dragOver && "bg-accent/40 ring-2 ring-primary/40",
          )}
        >
          <div className="grid auto-rows-min grid-cols-3 gap-3 overflow-y-auto pr-1 lg:grid-cols-4">
            {files.map((f) => (
              <button
                key={f.path}
                className={cn(
                  "group relative flex flex-col overflow-hidden rounded-md border text-left transition-colors hover:border-primary/50",
                  preview?.path === f.path && "border-primary ring-1 ring-primary/40",
                )}
                onClick={() => setPreview(f)}
              >
                <div className="flex h-24 w-full items-center justify-center bg-muted/40">
                  {f.kind === "image" ? (
                    <img src={client.sourceFileUrl(kind, f.path, cacheKey)} alt="" className="h-full w-full object-cover" loading="lazy" />
                  ) : (
                    <KindGlyph kind={f.kind} brand={tab === "brand"} />
                  )}
                </div>
                <div className="flex items-center gap-1.5 px-2 py-1.5">
                  {tab === "sources" && f.selected !== undefined && (
                    <Checkbox
                      checked={f.selected}
                      title="Include for this project's next run"
                      onClick={(e) => e.stopPropagation()}
                      onCheckedChange={(checked) => toggleSource(f.path, checked === true)}
                    />
                  )}
                  <span
                    className={cn("min-w-0 flex-1 truncate text-xs", tab === "sources" && f.selected === false && "text-muted-foreground line-through")}
                    title={f.path}
                  >
                    {f.path}
                  </span>
                </div>
                <Button
                  variant="secondary"
                  size="icon-sm"
                  className="absolute right-1 top-1 size-6 opacity-0 transition-opacity group-hover:opacity-100"
                  aria-label={`Delete ${f.path}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (preview?.path === f.path) setPreview(null);
                    act(() => client.deleteSource(kind, f.path));
                  }}
                >
                  <Trash2 className="size-3 text-destructive" />
                </Button>
              </button>
            ))}
            {!files.length && (
              <div className="col-span-full flex h-40 flex-col items-center justify-center gap-2 rounded-md border border-dashed text-sm text-muted-foreground">
                <Upload className="size-5" />
                {tab === "brand"
                  ? "Drop brand guidelines, logos, fonts & colors here"
                  : "Drop docs, images and existing collateral here"}
              </div>
            )}
          </div>

          <div className="hidden min-h-0 flex-col overflow-hidden rounded-md border bg-muted/20 md:flex">
            {preview ? (
              <>
                <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-xs" title={preview.path}>{preview.path}</span>
                  <Badge variant="outline" className="h-4 px-1 text-[10px]">{preview.kind}</Badge>
                  <span className="text-[10px] text-muted-foreground">{(preview.size / 1024).toFixed(0)} KB</span>
                </div>
                <div className="min-h-0 flex-1 overflow-auto p-3">
                  {preview.kind === "image" ? (
                    <img src={client.sourceFileUrl(kind, preview.path, cacheKey)} alt={preview.path} className="max-w-full rounded-sm border" />
                  ) : preview.kind === "text" ? (
                    <pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed">{textContent ?? "loading…"}</pre>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      No inline preview for this file type — the agent reads it directly during runs.
                    </p>
                  )}
                </div>
              </>
            ) : (
              <div className="flex flex-1 items-center justify-center p-4 text-center text-xs text-muted-foreground">
                Click a card to preview it here. Drag & drop anywhere to add files to this tab.
              </div>
            )}
          </div>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}
      </DialogContent>
    </Dialog>
  );
}
