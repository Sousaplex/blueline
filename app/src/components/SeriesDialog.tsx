// "Make N like this": clone the current (approved) design as the template for a
// document series — one subject per line, each becomes a sibling project that
// keeps the layout and adapts the content, queued through the parallel runner.
import { Layers, Loader2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { EngineClient } from "../engine-client";

export function SeriesDialog({
  client,
  slug,
  defaultRootName,
  hasPage,
}: {
  client: EngineClient;
  slug: string;
  defaultRootName: string;
  hasPage: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [rootName, setRootName] = useState(defaultRootName);
  const [topicsText, setTopicsText] = useState("");
  const [autoRun, setAutoRun] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const topics = topicsText
    .split("\n")
    .map((t) => t.trim())
    .filter(Boolean);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await client.createSeries(slug, rootName, topics, autoRun);
      setDone(`Created ${created.length} document${created.length === 1 ? "" : "s"}${autoRun ? " — runs queued" : ""}.`);
      setTopicsText("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) {
          setRootName(defaultRootName);
          setDone(null);
          setError(null);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" disabled={!hasPage} title={hasPage ? undefined : "Needs a finished page.html to use as the template"}>
          <Layers data-slot="icon" /> Series
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Make more like this</DialogTitle>
          <DialogDescription>
            Uses this document’s current design as the series template. Each subject becomes its own
            document that keeps the layout and adapts copy and imagery.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="series-root">Series name (drives grouping + export filenames)</Label>
            <Input id="series-root" value={rootName} onChange={(e) => setRootName(e.target.value)} placeholder="clinic-onepagers" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="series-topics">Subjects — one per line</Label>
            <Textarea
              id="series-topics"
              value={topicsText}
              onChange={(e) => setTopicsText(e.target.value)}
              placeholder={"Oncology\nCardiology\nNeurology"}
              className="min-h-28 font-mono text-sm"
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={autoRun} onCheckedChange={(c) => setAutoRun(c === true)} />
            Queue agent runs immediately
          </label>
          {error && <p className="text-sm text-destructive">{error}</p>}
          {done && <p className="text-sm text-emerald-600 dark:text-emerald-400">{done}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            {done ? "Close" : "Cancel"}
          </Button>
          <Button onClick={() => void create()} disabled={busy || !rootName.trim() || topics.length === 0}>
            {busy ? <Loader2 className="animate-spin" data-slot="icon" /> : <Layers data-slot="icon" />}
            Create {topics.length || ""} document{topics.length === 1 ? "" : "s"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
