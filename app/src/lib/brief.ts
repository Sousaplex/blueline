// Structured brief <-> markdown. The form keeps the template's structure visible
// while editing (labels don't vanish the way a placeholder does); anything the
// parser doesn't recognize (variant directions, series subjects, freeform notes)
// is preserved verbatim in `extra`.
export interface BriefFields {
  title: string;
  audience: string;
  goal: string;
  messages: string[];
  mustInclude: string;
  tone: string;
  extra: string; // unrecognized sections, kept verbatim
}

export const EMPTY_BRIEF: BriefFields = {
  title: "",
  audience: "",
  goal: "",
  messages: [],
  mustInclude: "",
  tone: "",
  extra: "",
};

const KNOWN_SECTIONS = new Set(["key messages", "must include", "tone"]);

export function parseBrief(md: string): BriefFields {
  const fields: BriefFields = { ...EMPTY_BRIEF, messages: [] };
  const lines = md.split("\n");
  let section = "";
  const extras: string[] = [];
  for (const line of lines) {
    const h1 = /^#\s+Brief:\s*(.*)$/i.exec(line) ?? /^#\s+(.*)$/.exec(line);
    if (h1 && !fields.title) {
      fields.title = h1[1].trim();
      section = "";
      continue;
    }
    const h2 = /^##\s+(.*)$/.exec(line);
    if (h2) {
      section = h2[1].trim().toLowerCase();
      if (!KNOWN_SECTIONS.has(section)) extras.push(line);
      continue;
    }
    const audience = /^\*\*Audience:\*\*\s*(.*)$/i.exec(line);
    if (audience) { fields.audience = audience[1].trim(); continue; }
    const goal = /^\*\*Goal:\*\*\s*(.*)$/i.exec(line);
    if (goal) { fields.goal = goal[1].trim(); continue; }
    if (/^\*\*Format:\*\*/i.test(line)) continue; // format lives in Document settings now

    if (section === "key messages") {
      const m = /^\d+\.\s*(.*)$/.exec(line);
      if (m && m[1].trim() && !/^<.*>$/.test(m[1].trim())) fields.messages.push(m[1].trim());
    } else if (section === "must include") {
      const m = /^[-*]\s*(.*)$/.exec(line);
      if (m && m[1].trim() && !/^<.*>$/.test(m[1].trim())) {
        fields.mustInclude += (fields.mustInclude ? "\n" : "") + m[1].trim();
      }
    } else if (section === "tone") {
      if (line.trim() && !/^<.*>$/.test(line.trim())) fields.tone += (fields.tone ? " " : "") + line.trim();
    } else if (!KNOWN_SECTIONS.has(section) && section) {
      extras.push(line);
    }
  }
  fields.extra = extras.join("\n").trim();
  // strip template angle-bracket placeholders
  for (const k of ["title", "audience", "goal", "tone"] as const) {
    if (/^<.*>$/.test(fields[k])) fields[k] = "";
  }
  return fields;
}

export function composeBrief(f: BriefFields): string {
  const parts: string[] = [`# Brief: ${f.title.trim() || "untitled piece"}`, ""];
  if (f.audience.trim()) parts.push(`**Audience:** ${f.audience.trim()}`);
  if (f.goal.trim()) parts.push(`**Goal:** ${f.goal.trim()}`);
  const messages = f.messages.map((m) => m.trim()).filter(Boolean);
  if (messages.length) {
    parts.push("", "## Key messages");
    messages.forEach((m, i) => parts.push(`${i + 1}. ${m}`));
  }
  if (f.mustInclude.trim()) {
    parts.push("", "## Must include");
    f.mustInclude.split("\n").map((l) => l.trim()).filter(Boolean).forEach((l) => parts.push(`- ${l}`));
  }
  if (f.tone.trim()) parts.push("", "## Tone", f.tone.trim());
  if (f.extra.trim()) parts.push("", f.extra.trim());
  return parts.join("\n") + "\n";
}
