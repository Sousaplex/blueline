import {
  CheckCircle2,
  CircleAlert,
  File,
  FileText,
  FileType,
  Folder,
  GitBranch,
  LayoutTemplate,
  Loader2,
  Maximize2,
  Palette,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import type { ContextFile, EngineClient, ProjectState, SourceKind } from "../engine-client";
import { readBase64, resolveDrop } from "@/lib/upload";
import { AssetsDialog, type AssetTab } from "./AssetsDialog";
import { BriefEditorDialog } from "./BriefEditorDialog";

const PAGE_SIZES = ["A4", "A5", "A3", "Letter", "Legal", "Tabloid", "Slide 16:9", "Slide 4:3", "Square", "Custom"];

function KindIcon({ kind }: { kind: SourceKind }) {
  if (kind === "text") return <FileText className="size-3.5 shrink-0 text-muted-foreground" />;
  if (kind === "pdf") return <FileType className="size-3.5 shrink-0 text-muted-foreground" />;
  return <File className="size-3.5 shrink-0 text-muted-foreground" />;
}

/** One flat-path list rendered as a folder tree (folders are path prefixes). */
interface TreeFolder {
  folders: Map<string, TreeFolder>;
  files: ContextFile[];
}

function buildTree(files: ContextFile[]): TreeFolder {
  const root: TreeFolder = { folders: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (!node.folders.has(part)) node.folders.set(part, { folders: new Map(), files: [] });
      node = node.folders.get(part)!;
    }
    node.files.push(f);
  }
  return root;
}

export function LeftPane({
  project,
  client,
  cacheKey,
  viewRound,
  onViewRound,
}: {
  project: ProjectState;
  client: EngineClient;
  cacheKey: number;
  viewRound: number | null;
  onViewRound: (round: number | null) => void;
}) {
  const shown = project.rounds.find((r) => r.round === viewRound);
  const [editingBrief, setEditingBrief] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<"context" | "brand" | null>(null);
  const [branching, setBranching] = useState<number | null>(null);
  const [assetsTab, setAssetsTab] = useState<AssetTab | null>(null);
  const [templateDialog, setTemplateDialog] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const [templateDesc, setTemplateDesc] = useState("");
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const contextInput = useRef<HTMLInputElement>(null);
  const brandInput = useRef<HTMLInputElement>(null);
  const meta = project.meta;

  const act = (fn: () => Promise<unknown>) => {
    setError(null);
    void fn().catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };

  const saveAsTemplate = async () => {
    setSavingTemplate(true);
    setTemplateError(null);
    try {
      await client.saveTemplate(project.slug!, templateName, templateDesc || undefined);
      setTemplateDialog(false);
      setTemplateName("");
      setTemplateDesc("");
    } catch (e) {
      setTemplateError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingTemplate(false);
    }
  };

  const toggleSource = (path: string, selected: boolean) => {
    const next = project.contextFiles.filter((f) => (f.path === path ? selected : f.selected)).map((f) => f.path);
    // all selected -> store null (default: everything, including future files)
    act(() => client.selectSources(next.length === project.contextFiles.length ? null : next));
  };

  const uploadFiles = (kind: "context" | "brand", entries: { relPath: string; file: File }[]) =>
    act(async () => {
      for (const { relPath, file } of entries) {
        await client.uploadSource(kind, relPath, await readBase64(file));
      }
    });

  const onPick = (kind: "context" | "brand") => (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])].map((file) => ({ relPath: file.name, file }));
    e.target.value = "";
    if (files.length) void uploadFiles(kind, files);
  };

  const dropProps = (kind: "context" | "brand") => ({
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(kind);
    },
    onDragLeave: () => setDragOver(null),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(null);
      void resolveDrop(e.dataTransfer.items).then((entries) => entries.length && uploadFiles(kind, entries));
    },
  });

  const branchFrom = (round: number) => {
    setBranching(round);
    act(async () => {
      try {
        await client.forkProject(project.slug!, round);
      } finally {
        setBranching(null);
      }
    });
  };

  const renderFolder = (folder: TreeFolder, prefix: string, depth: number): React.ReactNode => (
    <>
      {[...folder.folders.entries()].map(([name, child]) => (
        <li key={`${prefix}${name}/`}>
          <div className="flex items-center gap-1.5 py-0.5 text-xs text-muted-foreground" style={{ paddingLeft: depth * 14 }}>
            <Folder className="size-3.5 shrink-0" /> {name}/
          </div>
          <ul>{renderFolder(child, `${prefix}${name}/`, depth + 1)}</ul>
        </li>
      ))}
      {folder.files.map((f) => (
        <li key={f.path} className="group flex items-center gap-2 py-0.5" style={{ paddingLeft: depth * 14 }}>
          <Checkbox id={`src-${f.path}`} checked={f.selected} onCheckedChange={(checked) => toggleSource(f.path, checked === true)} />
          {f.kind === "image" ? (
            <img
              src={client.sourceFileUrl("context", f.path, cacheKey)}
              alt=""
              className="size-6 shrink-0 rounded-sm border object-cover"
              loading="lazy"
            />
          ) : (
            <KindIcon kind={f.kind} />
          )}
          <label
            htmlFor={`src-${f.path}`}
            className={cn(
              "min-w-0 flex-1 cursor-pointer truncate text-sm",
              !f.selected && "text-muted-foreground line-through decoration-muted-foreground/50",
            )}
            title={`${f.path} · ${(f.size / 1024).toFixed(0)} KB`}
          >
            {f.path.split("/").pop()}
          </label>
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-5 opacity-0 transition-opacity group-hover:opacity-100"
            aria-label={`Delete ${f.path}`}
            onClick={() => act(() => client.deleteSource("context", f.path))}
          >
            <Trash2 className="size-3 text-destructive" />
          </Button>
        </li>
      ))}
    </>
  );

  return (
    <ScrollArea className="h-full min-h-0 border-r">
      <div className="flex flex-col gap-5 p-4">
        {error && <p className="text-xs text-destructive">{error}</p>}

        {meta && (
          <section>
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">Document</h3>
            <div className="space-y-2">
              <Input
                key={`name-${project.slug}-${meta.displayName}`}
                defaultValue={meta.displayName}
                className="h-7 text-sm"
                placeholder="Display name"
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v && v !== meta.displayName) act(() => client.updateMeta({ displayName: v }));
                }}
              />
              <Input
                key={`series-${project.slug}-${meta.series ?? ""}`}
                defaultValue={meta.series ?? ""}
                className="h-7 text-sm"
                placeholder="Series (optional)"
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v !== (meta.series ?? "")) act(() => client.updateMeta({ series: v || null }));
                }}
              />
              <div className="flex items-center gap-1.5">
                <Select value={meta.settings.pageSize} onValueChange={(v) => act(() => client.updateMeta({ settings: { pageSize: v } }))}>
                  <SelectTrigger size="sm" className="h-7 flex-1 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PAGE_SIZES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={meta.settings.orientation}
                  onValueChange={(v) => act(() => client.updateMeta({ settings: { orientation: v as "portrait" | "landscape" } }))}
                >
                  <SelectTrigger size="sm" className="h-7 flex-1 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="portrait">portrait</SelectItem>
                    <SelectItem value="landscape">landscape</SelectItem>
                  </SelectContent>
                </Select>
                <Input
                  key={`pages-${project.slug}-${meta.settings.pages}`}
                  type="number"
                  min={1}
                  max={24}
                  defaultValue={meta.settings.pages}
                  className="h-7 w-16 text-xs"
                  title="Target page count — enforced by the reviewer"
                  onBlur={(e) => {
                    const v = Number(e.target.value);
                    if (v >= 1 && v !== meta.settings.pages) act(() => client.updateMeta({ settings: { pages: v } }));
                  }}
                />
                <span className="text-xs text-muted-foreground">pg</span>
              </div>
              {meta.settings.pageSize === "Custom" && (
                <div className="flex items-center gap-1.5">
                  <Input
                    key={`w-${project.slug}-${meta.settings.widthMm}`}
                    type="number"
                    min={50}
                    max={2000}
                    defaultValue={meta.settings.widthMm ?? 210}
                    className="h-7 flex-1 text-xs"
                    title="Artboard width in mm"
                    onBlur={(e) => {
                      const v = Number(e.target.value);
                      if (v > 0 && v !== meta.settings.widthMm) act(() => client.updateMeta({ settings: { widthMm: v } }));
                    }}
                  />
                  <span className="text-xs text-muted-foreground">×</span>
                  <Input
                    key={`h-${project.slug}-${meta.settings.heightMm}`}
                    type="number"
                    min={50}
                    max={2000}
                    defaultValue={meta.settings.heightMm ?? 297}
                    className="h-7 flex-1 text-xs"
                    title="Artboard height in mm"
                    onBlur={(e) => {
                      const v = Number(e.target.value);
                      if (v > 0 && v !== meta.settings.heightMm) act(() => client.updateMeta({ settings: { heightMm: v } }));
                    }}
                  />
                  <span className="text-xs text-muted-foreground">mm</span>
                </div>
              )}
              {project.artboard && (
                <p className="text-[10px] text-muted-foreground">
                  artboard {project.artboard.w}mm × {project.artboard.h}mm
                  {meta.settings.pageSize.startsWith("Slide") && " · slide deck: 1 page = 1 slide"}
                </p>
              )}
              {(meta.parent || meta.kind === "variant") && (
                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                  <GitBranch className="size-3" />
                  {meta.kind === "variant" ? "variant of" : "branched from"} {meta.parent}
                  {meta.forkedFromRound != null && ` @ round ${meta.forkedFromRound}`}
                </p>
              )}
              {meta.template && (
                <p className="flex items-center gap-1 text-xs text-muted-foreground" title="Layout is locked to the template — the agent only fills in data">
                  <LayoutTemplate className="size-3" /> from template “{meta.template}”
                </p>
              )}
              <Button
                variant="outline"
                size="sm"
                className="h-6 w-full text-xs"
                disabled={!project.hasPage}
                title={project.hasPage ? "Freeze this design as a reusable workspace template" : "Needs a finished page.html first"}
                onClick={() => {
                  setTemplateName(meta.displayName);
                  setTemplateDesc("");
                  setTemplateError(null);
                  setTemplateDialog(true);
                }}
              >
                <LayoutTemplate data-slot="icon" /> Save as template
              </Button>
            </div>
          </section>
        )}

        <section>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Brief</h3>
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-6"
              aria-label="Edit brief"
              onClick={() => setEditingBrief(true)}
            >
              <Pencil className="size-3.5" />
            </Button>
          </div>
          <pre
            className="max-h-56 cursor-pointer overflow-y-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-2.5 font-mono text-[11px] leading-relaxed transition-colors hover:bg-muted/70"
            title="Click to edit the brief"
            onClick={() => setEditingBrief(true)}
          >
            {project.brief || "(no brief.md — click to write one)"}
          </pre>
          <BriefEditorDialog
            open={editingBrief}
            onOpenChange={setEditingBrief}
            initial={project.brief}
            templateName={meta?.template}
            onSave={(brief) => client.updateBrief(brief)}
          />
        </section>

        <section
          {...dropProps("context")}
          className={cn("rounded-md transition-colors", dragOver === "context" && "bg-accent/60 ring-2 ring-primary/40")}
        >
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground" title="Shared by every project in this workspace">
              Sources <span className="normal-case tracking-normal">· workspace-wide</span>
            </h3>
            <div className="flex items-center">
              <Button variant="ghost" size="icon-sm" className="size-6" aria-label="View all sources" title="Open the library view"
                onClick={() => setAssetsTab("sources")}>
                <Maximize2 className="size-3" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                className="size-6"
                aria-label="Add source files"
                onClick={() => contextInput.current?.click()}
              >
                <Plus className="size-3.5" />
              </Button>
            </div>
            <input ref={contextInput} type="file" multiple hidden onChange={onPick("context")} />
          </div>
          <ul className="space-y-0.5">
            {renderFolder(buildTree(project.contextFiles), "", 0)}
            {!project.contextFiles.length && (
              <li className="text-sm text-muted-foreground">Drop files or folders here — docs, images, existing collateral</li>
            )}
          </ul>
          {project.contextFiles.length > 0 && (
            <p className="mt-1.5 text-[10px] text-muted-foreground">drag & drop files or folders to add</p>
          )}
        </section>

        <section
          {...dropProps("brand")}
          className={cn("rounded-md transition-colors", dragOver === "brand" && "bg-accent/60 ring-2 ring-primary/40")}
        >
          <div className="mb-2 flex items-center justify-between">
            <h3
              className="text-xs font-medium uppercase tracking-wider text-muted-foreground"
              title="The workspace's persistent brand home — the agent always honors what lives here"
            >
              Brand <span className="normal-case tracking-normal">· guidelines &amp; assets</span>
            </h3>
            <div className="flex items-center">
              <Button variant="ghost" size="icon-sm" className="size-6" aria-label="View all brand files" title="Open the library view"
                onClick={() => setAssetsTab("brand")}>
                <Maximize2 className="size-3" />
              </Button>
              <Button variant="ghost" size="icon-sm" className="size-6" aria-label="Add brand files" onClick={() => brandInput.current?.click()}>
                <Plus className="size-3.5" />
              </Button>
            </div>
            <input ref={brandInput} type="file" multiple hidden onChange={onPick("brand")} />
          </div>
          <ul className="space-y-1">
            {project.brandFiles.map((f) => (
              <li key={f.path} className="group flex items-center gap-2 text-sm text-muted-foreground">
                {f.kind === "image" ? (
                  <img src={client.sourceFileUrl("brand", f.path, cacheKey)} alt="" className="size-6 shrink-0 rounded-sm border object-cover" loading="lazy" />
                ) : (
                  <Palette className="size-3.5 shrink-0" />
                )}
                <span className="min-w-0 flex-1 truncate" title={f.path}>
                  {f.path}
                </span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="size-5 opacity-0 transition-opacity group-hover:opacity-100"
                  aria-label={`Delete ${f.path}`}
                  onClick={() => act(() => client.deleteSource("brand", f.path))}
                >
                  <Trash2 className="size-3 text-destructive" />
                </Button>
              </li>
            ))}
            {!project.brandFiles.length && (
              <li className="text-sm text-muted-foreground">
                Drop brand guidelines (.md), logos, fonts &amp; colors here — the agent uses them on every project.
              </li>
            )}
          </ul>
          {project.brandFiles.length > 0 && (
            <p className="mt-1.5 text-[10px] text-muted-foreground">
              the agent uses the logo files as-is and never invents a logo
            </p>
          )}
        </section>

        <Separator />

        <section>
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">Rounds</h3>
          <div className="space-y-1">
            <button
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent",
                viewRound === null && "bg-accent font-medium",
              )}
              onClick={() => onViewRound(null)}
            >
              Latest
            </button>
            {[...project.rounds].reverse().map((r) => (
              <div key={r.round} className="group relative">
                <button
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent",
                    viewRound === r.round && "bg-accent font-medium",
                  )}
                  onClick={() => onViewRound(viewRound === r.round ? null : r.round)}
                >
                  {r.verdict === "pass" ? (
                    <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" />
                  ) : r.verdict === "edit" ? (
                    <Pencil className="size-4 text-blue-600 dark:text-blue-400" />
                  ) : (
                    <CircleAlert className="size-4 text-amber-600 dark:text-amber-400" />
                  )}
                  Round {r.round}
                  <span className="flex-1" />
                  <Badge variant={r.verdict === "pass" ? "secondary" : "outline"} className="text-[10px]">
                    {r.verdict === "pass" ? "pass" : r.verdict === "edit" ? "edit" : `${r.issues.length} issue${r.issues.length === 1 ? "" : "s"}`}
                  </Badge>
                </button>
                {r.hasHtml && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="absolute right-1 top-1/2 size-6 -translate-y-1/2 bg-background/80 opacity-0 transition-opacity group-hover:opacity-100"
                    aria-label={`Branch from round ${r.round}`}
                    title={`Branch from round ${r.round} — explore an alternate round ${r.round + 1}`}
                    disabled={branching !== null}
                    onClick={(e) => {
                      e.stopPropagation();
                      branchFrom(r.round);
                    }}
                  >
                    {branching === r.round ? <Loader2 className="size-3.5 animate-spin" /> : <GitBranch className="size-3.5" />}
                  </Button>
                )}
              </div>
            ))}
            {!project.rounds.length && <p className="px-2 text-sm text-muted-foreground">No reviews yet.</p>}
          </div>

          {shown && (
            <div className="mt-3 rounded-md border bg-muted/40 p-2.5 text-xs leading-relaxed">
              <p className="mb-1 font-medium">
                Round {shown.round} — {shown.verdict === "edit" ? "chat edit" : shown.verdict}
              </p>
              {shown.verdict === "edit" && shown.notes && (
                <p className="mb-1.5 text-muted-foreground">Prompt: “{shown.notes}”</p>
              )}
              <ul className="space-y-1.5">
                {shown.issues.map((issue, i) => (
                  <li key={i}>
                    <span className="text-muted-foreground">
                      p{issue.page} · {issue.region}:
                    </span>{" "}
                    {issue.problem} <span className="text-primary">→ {issue.fix}</span>
                  </li>
                ))}
                {!shown.issues.length && <li className="text-muted-foreground">no issues</li>}
              </ul>
              {shown.notes && <p className="mt-2 text-muted-foreground">{shown.notes}</p>}
            </div>
          )}
        </section>
      </div>

      <AssetsDialog
        client={client}
        project={project}
        cacheKey={cacheKey}
        open={assetsTab !== null}
        onOpenChange={(o) => !o && setAssetsTab(null)}
        initialTab={assetsTab ?? "sources"}
      />

      <Dialog open={templateDialog} onOpenChange={setTemplateDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Save as template</DialogTitle>
            <DialogDescription>
              Freezes the current page design as a workspace template. New projects started from it keep this
              structure exactly — the agent only fills in their data.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Template name</Label>
              <Input
                value={templateName}
                autoFocus
                placeholder="Invoice"
                onChange={(e) => setTemplateName(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Description (optional)</Label>
              <Input
                value={templateDesc}
                placeholder="Standard client invoice, Letter portrait"
                onChange={(e) => setTemplateDesc(e.target.value)}
              />
            </div>
            {templateError && <p className="text-sm text-destructive">{templateError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTemplateDialog(false)}>Cancel</Button>
            <Button onClick={() => void saveAsTemplate()} disabled={savingTemplate || !templateName.trim()}>
              {savingTemplate ? "Saving…" : "Save template"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ScrollArea>
  );
}
