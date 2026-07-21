import { useState } from "react";
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
import type { EngineClient } from "../engine-client";

const BRIEF_PLACEHOLDER = `# Brief: <what is this piece?>

**Format:** one-pager, A4 portrait, print (PDF)
**Audience:** <who will hold this in their hands?>
**Goal:** <what should they do after reading it?>

## Key messages
1. ...

## Must include
- ...

## Tone
...`;

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
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setCreating(true);
    setError(null);
    try {
      await client.createProject(name, brief || undefined);
      setName("");
      setBrief("");
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            Creates projects/&lt;name&gt; in the workspace with a brief the agent will work from.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Name</Label>
            <Input
              value={name}
              autoFocus
              placeholder="acme-onepager"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && name.trim() && void create()}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Brief (markdown — leave empty for a template to fill in later)</Label>
            <textarea
              className="min-h-48 w-full rounded-md border bg-transparent p-2.5 font-mono text-xs leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={brief}
              placeholder={BRIEF_PLACEHOLDER}
              onChange={(e) => setBrief(e.target.value)}
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
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
