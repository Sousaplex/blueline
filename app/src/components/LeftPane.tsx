import { CheckCircle2, CircleAlert, Palette, Pencil, Plus } from "lucide-react";
import { useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import type { EngineClient, ProjectState } from "../engine-client";

export function LeftPane({
  project,
  client,
  viewRound,
  onViewRound,
}: {
  project: ProjectState;
  client: EngineClient;
  viewRound: number | null;
  onViewRound: (round: number | null) => void;
}) {
  const shown = project.rounds.find((r) => r.round === viewRound);
  const [editingBrief, setEditingBrief] = useState(false);
  const [briefDraft, setBriefDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const contextInput = useRef<HTMLInputElement>(null);
  const styleInput = useRef<HTMLInputElement>(null);

  const act = (fn: () => Promise<unknown>) => {
    setError(null);
    void fn().catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };

  const saveBrief = () =>
    act(async () => {
      await client.updateBrief(briefDraft);
      setEditingBrief(false);
    });

  const toggleSource = (name: string, selected: boolean) => {
    const next = project.contextFiles.filter((f) => (f.name === name ? selected : f.selected)).map((f) => f.name);
    // all selected -> store null (default: everything, including future files)
    act(() => client.selectSources(next.length === project.contextFiles.length ? null : next));
  };

  const upload = (kind: "context" | "style") => (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])];
    e.target.value = "";
    for (const file of files) {
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = String(reader.result).split(",")[1] ?? "";
        act(() => client.uploadSource(kind, file.name, base64));
      };
      reader.readAsDataURL(file);
    }
  };

  return (
    <ScrollArea className="h-full min-h-0 border-r">
      <div className="flex flex-col gap-5 p-4">
        {error && <p className="text-xs text-destructive">{error}</p>}

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

        <section>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Sources</h3>
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-6"
              aria-label="Add source files"
              onClick={() => contextInput.current?.click()}
            >
              <Plus className="size-3.5" />
            </Button>
            <input ref={contextInput} type="file" multiple hidden onChange={upload("context")} />
          </div>
          <ul className="space-y-1.5 text-sm">
            {project.contextFiles.map((f) => (
              <li key={f.name} className="flex items-center gap-2">
                <Checkbox
                  id={`src-${f.name}`}
                  checked={f.selected}
                  onCheckedChange={(checked) => toggleSource(f.name, checked === true)}
                />
                <label
                  htmlFor={`src-${f.name}`}
                  className={cn("cursor-pointer truncate", !f.selected && "text-muted-foreground line-through decoration-muted-foreground/50")}
                  title={f.name}
                >
                  {f.name}
                </label>
              </li>
            ))}
            {!project.contextFiles.length && <li className="text-muted-foreground">No source files — add some with +</li>}
          </ul>
        </section>

        <section>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Styles</h3>
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-6"
              aria-label="Add style files"
              onClick={() => styleInput.current?.click()}
            >
              <Plus className="size-3.5" />
            </Button>
            <input ref={styleInput} type="file" multiple hidden onChange={upload("style")} />
          </div>
          <ul className="space-y-1 text-sm">
            {project.styleFiles.map((f) => (
              <li key={f} className="flex items-center gap-2 text-muted-foreground">
                <Palette className="size-3.5 shrink-0" /> <span className="truncate">{f}</span>
              </li>
            ))}
            {!project.styleFiles.length && <li className="text-muted-foreground">No style guides yet</li>}
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
              <button
                key={r.round}
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
