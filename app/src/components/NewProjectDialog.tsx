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
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      await client.createProject(name, brief || undefined, selected?.slug);
      setName("");
      setBrief("");
      setTemplate(BLANK);
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
            {selected && (
              <p className="rounded-md border bg-muted/30 p-2 text-xs text-muted-foreground">
                {selected.settings.pageSize} {selected.settings.orientation}, {selected.settings.pages} pg ·
                structure comes from the template; the agent fills it with this project's data.
              </p>
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
