import { CheckCircle2, CircleAlert, FileText, Palette } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import type { ProjectState } from "../engine-client";

export function LeftPane({
  project,
  viewRound,
  onViewRound,
}: {
  project: ProjectState;
  viewRound: number | null;
  onViewRound: (round: number | null) => void;
}) {
  const shown = project.rounds.find((r) => r.round === viewRound);
  return (
    <ScrollArea className="h-full min-h-0 border-r">
      <div className="flex flex-col gap-5 p-4">
        <section>
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">Brief</h3>
          <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-2.5 font-mono text-[11px] leading-relaxed">
            {project.brief || "(no brief.md)"}
          </pre>
        </section>

        <section>
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">Sources</h3>
          <ul className="space-y-1 text-sm">
            {project.contextFiles.map((f) => (
              <li key={f} className="flex items-center gap-2 text-muted-foreground">
                <FileText className="size-3.5" /> {f}
              </li>
            ))}
            {project.styleFiles.map((f) => (
              <li key={f} className="flex items-center gap-2 text-muted-foreground">
                <Palette className="size-3.5" /> {f}
              </li>
            ))}
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
