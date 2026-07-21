import {
  CheckCircle2,
  CircleAlert,
  File,
  FileText,
  FileType,
  Folder,
  GitBranch,
  Loader2,
  Palette,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import type { ContextFile, EngineClient, ProjectState, SourceKind } from "../engine-client";

const PAGE_SIZES = ["A4", "A5", "A3", "Letter", "Legal", "Tabloid"];

/** Resolve dropped items (files AND folders) into {relPath, file} pairs. */
async function resolveDrop(items: DataTransferItemList): Promise<{ relPath: string; file: File }[]> {
  const out: { relPath: string; file: File }[] = [];
  const walk = async (entry: any, prefix: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) => entry.file(res, rej));
      out.push({ relPath: prefix ? `${prefix}/${file.name}` : file.name, file });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      // readEntries returns batches of ≤100 — drain until empty
      for (;;) {
        const batch = await new Promise<any[]>((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const child of batch) await walk(child, prefix ? `${prefix}/${entry.name}` : entry.name);
      }
    }
  };
  const entries = [...items].map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null));
  const files = [...items].map((i) => i.getAsFile());
  for (let i = 0; i < entries.length; i++) {
    if (entries[i]) await walk(entries[i], "");
    else if (files[i]) out.push({ relPath: files[i]!.name, file: files[i]! });
  }
  return out;
}

function readBase64(file: File): Promise<string> {
  return new Promise((res, rej) => {
    const reader = new FileReader();
    reader.onload = () => res(String(reader.result).split(",")[1] ?? "");
    reader.onerror = rej;
    reader.readAsDataURL(file);
  });
}

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
  const [briefDraft, setBriefDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<"context" | "style" | null>(null);
  const [branching, setBranching] = useState<number | null>(null);
  const contextInput = useRef<HTMLInputElement>(null);
  const styleInput = useRef<HTMLInputElement>(null);
  const meta = project.meta;

  const act = (fn: () => Promise<unknown>) => {
    setError(null);
    void fn().catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };

  const saveBrief = () =>
    act(async () => {
      await client.updateBrief(briefDraft);
      setEditingBrief(false);
    });

  const toggleSource = (path: string, selected: boolean) => {
    const next = project.contextFiles.filter((f) => (f.path === path ? selected : f.selected)).map((f) => f.path);
    // all selected -> store null (default: everything, including future files)
    act(() => client.selectSources(next.length === project.contextFiles.length ? null : next));
  };

  const uploadFiles = (kind: "context" | "style", entries: { relPath: string; file: File }[]) =>
    act(async () => {
      for (const { relPath, file } of entries) {
        await client.uploadSource(kind, relPath, await readBase64(file));
      }
    });

  const onPick = (kind: "context" | "style") => (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])].map((file) => ({ relPath: file.name, file }));
    e.target.value = "";
    if (files.length) void uploadFiles(kind, files);
  };

  const dropProps = (kind: "context" | "style") => ({
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
              {(meta.parent || meta.kind === "variant") && (
                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                  <GitBranch className="size-3" />
                  {meta.kind === "variant" ? "variant of" : "branched from"} {meta.parent}
                  {meta.forkedFromRound != null && ` @ round ${meta.forkedFromRound}`}
                </p>
              )}
            </div>
          </section>
        )}

        <section>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Brief</h3>
            {!editingBrief && (
              <Button
                variant="ghost"
                size="icon-sm"
                className="size-6"
                aria-label="Edit brief"
                onClick={() => {
                  setBriefDraft(project.brief);
                  setEditingBrief(true);
                }}
              >
                <Pencil className="size-3.5" />
              </Button>
            )}
          </div>
          {editingBrief ? (
            <div className="space-y-2">
              <textarea
                className="min-h-64 w-full rounded-md border bg-transparent p-2.5 font-mono text-[11px] leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={briefDraft}
                autoFocus
                onChange={(e) => setBriefDraft(e.target.value)}
              />
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => setEditingBrief(false)}>
                  Cancel
                </Button>
                <Button size="sm" onClick={saveBrief} disabled={!briefDraft.trim()}>
                  Save
                </Button>
              </div>
            </div>
          ) : (
            <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-2.5 font-mono text-[11px] leading-relaxed">
              {project.brief || "(no brief.md)"}
            </pre>
          )}
        </section>

        <section
          {...dropProps("context")}
          className={cn("rounded-md transition-colors", dragOver === "context" && "bg-accent/60 ring-2 ring-primary/40")}
        >
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground" title="Shared by every project in this workspace">
              Sources <span className="normal-case tracking-normal">· workspace-wide</span>
            </h3>
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-6"
              aria-label="Add source files"
              onClick={() => contextInput.current?.click()}
            >
              <Plus className="size-3.5" />
            </Button>
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
          {...dropProps("style")}
          className={cn("rounded-md transition-colors", dragOver === "style" && "bg-accent/60 ring-2 ring-primary/40")}
        >
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Styles</h3>
            <Button variant="ghost" size="icon-sm" className="size-6" aria-label="Add style files" onClick={() => styleInput.current?.click()}>
              <Plus className="size-3.5" />
            </Button>
            <input ref={styleInput} type="file" multiple hidden onChange={onPick("style")} />
          </div>
          <ul className="space-y-1">
            {project.styleFiles.map((f) => (
              <li key={f.path} className="group flex items-center gap-2 text-sm text-muted-foreground">
                {f.kind === "image" ? (
                  <img src={client.sourceFileUrl("style", f.path, cacheKey)} alt="" className="size-6 shrink-0 rounded-sm border object-cover" loading="lazy" />
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
                  onClick={() => act(() => client.deleteSource("style", f.path))}
                >
                  <Trash2 className="size-3 text-destructive" />
                </Button>
              </li>
            ))}
            {!project.styleFiles.length && <li className="text-sm text-muted-foreground">No style guides yet — drop brand files here</li>}
          </ul>
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
                  ) : (
                    <CircleAlert className="size-4 text-amber-600 dark:text-amber-400" />
                  )}
                  Round {r.round}
                  <span className="flex-1" />
                  <Badge variant={r.verdict === "pass" ? "secondary" : "outline"} className="text-[10px]">
                    {r.verdict === "pass" ? "pass" : `${r.issues.length} issue${r.issues.length === 1 ? "" : "s"}`}
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
                Round {shown.round} — {shown.verdict}
              </p>
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
    </ScrollArea>
  );
}
