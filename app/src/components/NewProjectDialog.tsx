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
import { PAGE_SIZES, previewDims } from "@/lib/formats";
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
  const [pages, setPages] = useState(1);
  const [widthMm, setWidthMm] = useState(210);
  const [heightMm, setHeightMm] = useState(297);
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

  const create = async () => {
    setCreating(true);
    setError(null);
    try {
      // A template dictates the format; blank projects take the picker's settings.
      const settings = selected
        ? undefined
        : { pageSize, orientation, pages, ...(pageSize === "Custom" ? { widthMm, heightMm } : {}) };
      await client.createProject(name, brief || undefined, selected?.slug, settings);
      setName("");
      setBrief("");
      setTemplate(BLANK);
      setPageSize("A4");
      setOrientation("portrait");
      setPages(1);
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
          <div className="max-h-[62vh] min-h-0 space-y-4 overflow-y-auto pr-3">
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
            {selected ? (
              <p className="rounded-md border bg-muted/30 p-2 text-xs text-muted-foreground">
                {selected.settings.pageSize} {selected.settings.orientation}, {selected.settings.pages} pg ·
                structure comes from the template; the agent fills it with this project's data.
              </p>
            ) : (
              <div className="space-y-1.5">
                <Label>Format</Label>
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
                  <Input
                    type="number"
                    min={1}
                    max={24}
                    value={pages}
                    className="h-8 w-16 text-xs"
                    title={pageSize.startsWith("Slide") ? "Number of slides" : "Target page count — enforced by the reviewer"}
                    onChange={(e) => setPages(Math.max(1, Math.min(24, Number(e.target.value) || 1)))}
                  />
                  <span className="text-xs text-muted-foreground">{pageSize.startsWith("Slide") ? "slides" : "pg"}</span>
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
              <BriefForm initial="" onChange={setBrief} />
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
