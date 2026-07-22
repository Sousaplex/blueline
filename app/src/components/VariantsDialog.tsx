import { Sparkles } from "lucide-react";
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
import type { EngineClient } from "../engine-client";

interface Row {
  label: string;
  direction: string;
}

export function VariantsDialog({
  client,
  slug,
  open,
  onOpenChange,
}: {
  client: EngineClient;
  slug: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [rows, setRows] = useState<Row[]>([
    { label: "", direction: "" },
    { label: "", direction: "" },
    { label: "", direction: "" },
  ]);
  const [busy, setBusy] = useState<"suggest" | "create" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const valid = rows.filter((r) => r.label.trim() && r.direction.trim());

  const suggest = async () => {
    setBusy("suggest");
    setError(null);
    try {
      const directions = await client.suggestVariants(slug, 3);
      setRows(directions);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const create = async () => {
    setBusy("create");
    setError(null);
    try {
      await client.createVariants(slug, valid);
      onOpenChange(false); // variants appear as sibling tabs and run in the background
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Design variants for “{slug}”</DialogTitle>
          <DialogDescription>
            Each direction becomes its own project sharing this brief and sources, and is queued to run
            (2 at a time). Compare proofs on the home screen; keep the winner, delete the rest.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <Button variant="secondary" size="sm" onClick={() => void suggest()} disabled={busy !== null}>
            <Sparkles data-slot="icon" /> {busy === "suggest" ? "Thinking…" : "Suggest 3 distinct directions"}
          </Button>

          {rows.map((row, i) => (
            <div key={i} className="space-y-1.5 rounded-md border p-3">
              <Input
                value={row.label}
                placeholder={`direction-${i + 1} label (e.g. bold-editorial)`}
                onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, label: e.target.value } : r)))}
              />
              <textarea
                className="min-h-20 w-full rounded-md border bg-transparent p-2 text-xs leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={row.direction}
                placeholder="What makes this direction different — layout structure, imagery mood, type emphasis, palette usage…"
                onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, direction: e.target.value } : r)))}
              />
            </div>
          ))}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => void create()} disabled={busy !== null || valid.length === 0}>
            {busy === "create" ? "Creating…" : `Create & run ${valid.length || ""} variant${valid.length === 1 ? "" : "s"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
