import { LayoutTemplate } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DOC_TYPES, PAGE_SIZES, previewDims } from "@/lib/formats";
import type { EngineClient, TemplateInfo } from "../engine-client";
import { BriefForm } from "./BriefForm";
import { BriefGuidance } from "./BriefGuidance";

const BLANK = "__blank__";

export function NewProjectDialog({
  client,
  open,
  onOpenChange,
}: {
  client: EngineClient;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = useState("");
  const [brief, setBrief] = useState("");
  const [template, setTemplate] = useState(BLANK);
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [pageSize, setPageSize] = useState("A4");
  const [orientation, setOrientation] = useState<"portrait" | "landscape">("portrait");
  const [docType, setDocType] = useState("one-pager");
  const [pages, setPages] = useState(1);
  const [autoPages, setAutoPages] = useState(false);
  const [widthMm, setWidthMm] = useState(210);
  const [heightMm, setHeightMm] = useState(297);
  const [overrideSize, setOverrideSize] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pickSize = (v: string) => {
    setPageSize(v);
    // Slide decks are wide by nature — flip the default so the artboard matches expectations.
    if (v.startsWith("Slide")) setOrientation("landscape");
  };

  useEffect(() => {
    if (open) {
      setError(null);
      void client.listTemplates().then(setTemplates).catch(() => setTemplates([]));
    }
  }, [open, client]);

  const selected = template === BLANK ? undefined : templates.find((t) => t.slug === template);

  // Seed the format controls from the chosen template so an override starts from
  // the template's real size (and resets to locked each time the pick changes).
  useEffect(() => {
    if (!selected) return;
    const s = selected.settings;
    setPageSize(s.pageSize);
    setOrientation(s.orientation);
    setDocType(s.docType ?? "one-pager");
    setPages(s.pages);
    setAutoPages(s.autoPages ?? false);
    if (typeof s.widthMm === "number") setWidthMm(s.widthMm);
    if (typeof s.heightMm === "number") setHeightMm(s.heightMm);
    setOverrideSize(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template]);

  const create = async () => {
    setCreating(true);
    setError(null);
    try {
      // A template dictates the format unless the user overrides its size;
      // blank projects always take the picker's settings.
      const autoOn = autoPages && !pageSize.startsWith("Slide");
      const picked = { pageSize, orientation, docType, pages, autoPages: autoOn, ...(pageSize === "Custom" ? { widthMm, heightMm } : {}) };
      const settings = selected ? (overrideSize ? picked : undefined) : picked;
      await client.createProject(name, brief || undefined, selected?.slug, settings);
      setName("");
      setBrief("");
      setTemplate(BLANK);
      setPageSize("A4");
      setOrientation("portrait");
      setPages(1);
      setOverrideSize(false);
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            Creates projects/&lt;name&gt; in the workspace with a brief the agent will work from.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_280px]">
          <div className="max-h-[62vh] min-h-0 space-y-4 overflow-y-auto p-1 pr-3">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Name</Label>
                <Input
                  value={name}
                  autoFocus
                  placeholder="acme-onepager"
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="flex items-center gap-1.5">
                  <LayoutTemplate className="size-3.5" /> Start from
                </Label>
                <Select value={template} onValueChange={setTemplate}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={BLANK}>Blank — the agent designs from scratch</SelectItem>
                    {templates.map((t) => (
                      <SelectItem key={t.slug} value={t.slug}>
                        {t.name}
                        {t.description ? ` — ${t.description}` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {!templates.length && (
                  <p className="text-[11px] text-muted-foreground">
                    No templates yet — open a finished project and use “Save as template”.
                  </p>
                )}
              </div>
            </div>
            {selected && (
              <div className="space-y-2 rounded-md border bg-muted/30 p-2 text-xs text-muted-foreground">
                <div className="flex items-center justify-between gap-2">
                  <span>
                    {selected.settings.pageSize} {selected.settings.orientation}, {selected.settings.pages} pg ·
                    structure comes from the template.
                  </span>
                  <button
                    type="button"
                    onClick={() => setOverrideSize((v) => !v)}
                    className={`shrink-0 rounded-md border px-2 py-1 transition-colors ${
                      overrideSize ? "bg-accent font-medium text-foreground" : "hover:text-foreground"
                    }`}
                    title="Change the page size/count for this project — the template's layout is still copied in"
                  >
                    {overrideSize ? "Custom size on" : "Override size"}
                  </button>
                </div>
                {selected.guidance ? (
                  <p className="border-t pt-2 text-[11px]">Template instructions: {selected.guidance}</p>
                ) : null}
              </div>
            )}
            {(!selected || overrideSize) && (
              <div className="space-y-1.5">
                <Label>Type &amp; format</Label>
                <Select value={docType} onValueChange={setDocType}>
                  <SelectTrigger size="sm" className="h-8 w-full text-xs capitalize">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DOC_TYPES.map((t) => (
                      <SelectItem key={t} value={t} className="capitalize">
                        {t.replace("-", " ")}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="flex items-center gap-1.5">
                  <Select value={pageSize} onValueChange={pickSize}>
                    <SelectTrigger size="sm" className="h-8 flex-1 text-xs">
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
                  <Select value={orientation} onValueChange={(v) => setOrientation(v as "portrait" | "landscape")}>
                    <SelectTrigger size="sm" className="h-8 flex-1 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="portrait">portrait</SelectItem>
                      <SelectItem value="landscape">landscape</SelectItem>
                    </SelectContent>
                  </Select>
                  {autoPages && !pageSize.startsWith("Slide") ? (
                    <div className="flex h-8 w-16 items-center justify-center rounded-md border text-xs text-muted-foreground" title="The agent uses as many pages as the content needs">
                      Auto
                    </div>
                  ) : (
                    <Input
                      type="number"
                      min={1}
                      max={24}
                      value={pages}
                      className="h-8 w-16 text-xs"
                      title={pageSize.startsWith("Slide") ? "Number of slides" : "Target page count — enforced by the reviewer"}
                      onChange={(e) => setPages(Math.max(1, Math.min(24, Number(e.target.value) || 1)))}
                    />
                  )}
                  {!(autoPages && !pageSize.startsWith("Slide")) && (
                    <span className="text-xs text-muted-foreground">{pageSize.startsWith("Slide") ? "slides" : "pg"}</span>
                  )}
                  {!pageSize.startsWith("Slide") && (
                    <button
                      type="button"
                      onClick={() => setAutoPages((v) => !v)}
                      className={`h-8 rounded-md border px-2 text-xs transition-colors ${
                        autoPages ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:text-foreground"
                      }`}
                      title="Auto: let the content decide how many pages — good for formatting a document, letter, or report"
                    >
                      Auto
                    </button>
                  )}
                </div>
                {pageSize === "Custom" && (
                  <div className="flex items-center gap-1.5">
                    <Input type="number" min={50} max={2000} value={widthMm} className="h-8 flex-1 text-xs" title="Artboard width in mm"
                      onChange={(e) => setWidthMm(Number(e.target.value) || 210)} />
                    <span className="text-xs text-muted-foreground">×</span>
                    <Input type="number" min={50} max={2000} value={heightMm} className="h-8 flex-1 text-xs" title="Artboard height in mm"
                      onChange={(e) => setHeightMm(Number(e.target.value) || 297)} />
                    <span className="text-xs text-muted-foreground">mm</span>
                  </div>
                )}
                <p className="text-[11px] text-muted-foreground">
                  artboard {previewDims(pageSize, orientation, widthMm, heightMm).w}mm ×{" "}
                  {previewDims(pageSize, orientation, widthMm, heightMm).h}mm
                  {pageSize.startsWith("Slide") && " · slide deck: 1 page = 1 slide"}
                </p>
              </div>
            )}
            <div className="space-y-1.5">
              <Label>Brief{selected ? " — the data for this document" : " — fill what you know; edit any time"}</Label>
              <BriefForm
                initial=""
                onChange={setBrief}
                draft={(idea) =>
                  client.draftBrief(
                    idea,
                    selected
                      ? `${selected.settings.pageSize} ${selected.settings.orientation}, ${selected.settings.pages} page(s) (template: ${selected.name})`
                      : `${pageSize} ${orientation}, ${autoPages && !pageSize.startsWith("Slide") ? "auto page count" : `${pages} page(s)`}`,
                  )
                }
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
          <div className="max-h-[62vh] overflow-y-auto pr-1">
            <BriefGuidance templateName={selected?.name ?? null} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => void create()} disabled={creating || !name.trim()}>
            {creating ? "Creating…" : "Create project"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
