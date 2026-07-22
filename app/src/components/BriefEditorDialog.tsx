// Wide brief-editing modal: editor on the left, writing guidance on the right.
// Used from the left rail's Brief section (creation uses NewProjectDialog,
// which embeds the same guidance rail).
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
import { BriefForm } from "./BriefForm";
import { BriefGuidance } from "./BriefGuidance";

export function BriefEditorDialog({
  open,
  onOpenChange,
  initial,
  templateName,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: string;
  templateName?: string | null;
  onSave: (brief: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-seed the draft each time the dialog opens (the brief may have changed).
  useEffect(() => {
    if (open) {
      setDraft(initial);
      setError(null);
    }
  }, [open, initial]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave(draft);
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Edit brief</DialogTitle>
          <DialogDescription>The agent designs from this on the next run.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_280px]">
          <div className="max-h-[60vh] min-h-0 overflow-y-auto pr-1">
            {open && <BriefForm initial={initial} onChange={setDraft} />}
          </div>
          <div className="max-h-[60vh] overflow-y-auto">
            <BriefGuidance templateName={templateName} />
          </div>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => void save()} disabled={saving || !draft.trim()}>
            {saving ? "Saving…" : "Save brief"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
