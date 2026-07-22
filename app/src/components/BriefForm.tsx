// Structured brief editor: labeled fields that keep the template's shape visible
// (unlike a placeholder that vanishes on the first keystroke), with a Markdown
// tab for freeform editing. Unrecognized sections survive round-trips.
import { useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { composeBrief, parseBrief, type BriefFields } from "@/lib/brief";

export function BriefForm({ initial, onChange }: { initial: string; onChange: (md: string) => void }) {
  const [tab, setTab] = useState<"form" | "markdown">("form");
  const [fields, setFields] = useState<BriefFields>(() => parseBrief(initial));
  const [raw, setRaw] = useState(initial);
  const rawDirty = useRef(false);

  const update = (patch: Partial<BriefFields>) => {
    const next = { ...fields, ...patch };
    setFields(next);
    const md = composeBrief(next);
    setRaw(md);
    onChange(md);
  };

  const switchTab = (next: "form" | "markdown") => {
    if (next === "form" && rawDirty.current) {
      setFields(parseBrief(raw)); // fold manual markdown edits back into the form
      rawDirty.current = false;
    }
    setTab(next);
  };

  const messagesText = fields.messages.join("\n");

  return (
    <div className="space-y-2">
      <div className="flex gap-1">
        {(["form", "markdown"] as const).map((t) => (
          <button
            key={t}
            className={cn(
              "rounded-md px-2 py-0.5 text-[11px] font-medium capitalize",
              tab === t ? "bg-accent" : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => switchTab(t)}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "markdown" ? (
        <textarea
          className="min-h-64 w-full rounded-md border bg-transparent px-3 py-2.5 font-mono text-[11px] leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring"
          value={raw}
          onChange={(e) => {
            setRaw(e.target.value);
            rawDirty.current = true;
            onChange(e.target.value);
          }}
        />
      ) : (
        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-[11px]">What is this piece?</Label>
            <Input className="h-8 px-2.5 text-xs" value={fields.title} placeholder="Trade-show one-pager for …"
              onChange={(e) => update({ title: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label className="text-[11px]">Audience — who holds this in their hands?</Label>
            <Input className="h-8 px-2.5 text-xs" value={fields.audience} placeholder="Clinic ops leads evaluating vendors"
              onChange={(e) => update({ audience: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label className="text-[11px]">Goal — what should they do after reading?</Label>
            <Input className="h-8 px-2.5 text-xs" value={fields.goal} placeholder="Book a demo"
              onChange={(e) => update({ goal: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label className="text-[11px]">Key messages — one per line, most important first</Label>
            <textarea
              className="min-h-16 w-full rounded-md border bg-transparent px-2.5 py-2 text-xs leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={messagesText}
              placeholder={"The one thing they must remember\nSupporting point\nSupporting point"}
              onChange={(e) => update({ messages: e.target.value.split("\n") })}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-[11px]">Must include — one per line</Label>
            <textarea
              className="min-h-12 w-full rounded-md border bg-transparent px-2.5 py-2 text-xs leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={fields.mustInclude}
              placeholder={"Logo\nCTA with contact info"}
              onChange={(e) => update({ mustInclude: e.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-[11px]">Tone</Label>
            <Input className="h-8 px-2.5 text-xs" value={fields.tone} placeholder="confident / playful / clinical / warm"
              onChange={(e) => update({ tone: e.target.value })} />
          </div>
          {fields.extra && (
            <p className="rounded-md border bg-muted/30 p-2 text-[10.5px] leading-relaxed text-muted-foreground">
              Extra sections kept as-is (edit in Markdown): {fields.extra.split("\n")[0].slice(0, 60)}…
            </p>
          )}
        </div>
      )}
    </div>
  );
}
