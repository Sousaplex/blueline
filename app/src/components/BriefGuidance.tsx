// Right-hand rail of the brief modals: what the brief drives and how to write
// one that gets a good first round. Static guidance, template-aware.
import { Lightbulb, LockKeyhole } from "lucide-react";

export function BriefGuidance({ templateName }: { templateName?: string | null }) {
  return (
    <aside className="space-y-3 rounded-md border bg-muted/30 p-3.5 text-xs leading-relaxed">
      {templateName && (
        <div className="rounded-md border border-primary/30 bg-primary/5 p-2.5">
          <p className="mb-1 flex items-center gap-1.5 font-medium">
            <LockKeyhole className="size-3.5" /> Template mode — {templateName}
          </p>
          <p className="text-muted-foreground">
            The layout is locked to the template; the agent only fills in your data. Use the brief for the
            <em> content</em>: names, dates, line items, amounts, subject matter — not design direction.
          </p>
        </div>
      )}

      <div>
        <p className="mb-1 flex items-center gap-1.5 font-medium">
          <Lightbulb className="size-3.5" /> How the brief is used
        </p>
        <p className="text-muted-foreground">
          The agent reads the brief first, then your Sources and Styles, and designs the piece from it.
          The brief is the contract — sources are supporting evidence.
        </p>
      </div>

      <div>
        <p className="mb-1 font-medium">What makes a strong brief</p>
        <ul className="list-disc space-y-1 pl-4 text-muted-foreground">
          <li><strong className="text-foreground">Piece</strong> — name the format: “trade-show one-pager”, “3-page proposal”.</li>
          <li><strong className="text-foreground">Audience</strong> — one specific reader beats a demographic.</li>
          <li><strong className="text-foreground">Goal</strong> — the action you want: “book a demo”, “pay this invoice”.</li>
          <li><strong className="text-foreground">Key messages</strong> — three max, ordered. The first becomes headline territory.</li>
          <li><strong className="text-foreground">Must include</strong> — hard requirements only: logo, legal line, CTA with contact info.</li>
          <li><strong className="text-foreground">Tone</strong> — two or three adjectives.</li>
        </ul>
      </div>

      <div>
        <p className="mb-1 font-medium">Leave out</p>
        <ul className="list-disc space-y-1 pl-4 text-muted-foreground">
          <li>Layout micro-instructions (“logo top-left”) — nudge those in Live edit after the first round.</li>
          <li>Long source content — drop files into Sources instead of pasting them here.</li>
        </ul>
      </div>

      <p className="border-t pt-2.5 text-muted-foreground">
        While it runs you can steer from the chat: <em>“make the headline punchier”</em>. Anything the brief
        doesn't pin down, the agent decides — and you can always edit the result.
      </p>
    </aside>
  );
}
