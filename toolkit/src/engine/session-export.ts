// Export a project's full Pi conversation for analysis. A project accumulates MULTIPLE
// session threads on disk (one JSONL per app launch/run, under ~/.pi/agent/sessions/<cwd>/),
// so we enumerate every thread — not just the one currently in memory — and flatten each
// entry into an analyzable shape that preserves prompts, tool calls WITH arguments, tool
// results, thinking, and model/compaction events. The original entry is kept under `raw`
// so nothing is lost. The system prompt is included too (it's the top of every thread's
// context but isn't itself a session entry).
import { readFileSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { BluelineConfig } from "./config.ts";
import { buildSystemPrompt } from "./prompt.ts";
import type { Project } from "./project.ts";

export interface ExportedEntry {
  type: string; // "message" | "compaction" | "model_change" | "thinking_level_change" | ...
  role?: string; // user | assistant | tool (for message entries)
  timestamp?: string;
  text?: string; // assistant/user visible text
  thinking?: string; // model reasoning, when present
  tool?: string; // tool call name (assistant tool_use)
  args?: unknown; // tool call arguments — the key thing for debugging what the agent did
  result?: string; // tool result text (tool message)
  note?: string; // compaction summary / model change / etc.
  raw: unknown; // full original entry, lossless
}

export interface ExportedThread {
  id: string;
  path: string;
  created: string;
  modified: string;
  cwd: string;
  counts: { user: number; assistant: number; toolCalls: number; toolResults: number; total: number };
  entries: ExportedEntry[];
}

export interface SessionBundle {
  format: "blueline-session-export/1";
  exportedAt: string;
  project: { slug: string; dir: string; displayName: string };
  model: string;
  systemPrompt: string;
  totals: { threads: number; entries: number; toolCalls: number };
  threads: ExportedThread[];
}

/** Best-effort text extraction from a tool_result content part (string | array | object). */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c: any) => (typeof c === "string" ? c : c?.type === "text" ? c.text : c?.text ?? ""))
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object") {
    const c = content as any;
    if (typeof c.text === "string") return c.text;
  }
  return "";
}

/** Flatten one raw session-file entry (already JSON-parsed) into an ExportedEntry.
 *  Exported for unit testing the content-part extraction. */
export function flatten(entry: any): ExportedEntry {
  const out: ExportedEntry = { type: entry?.type ?? "unknown", timestamp: entry?.timestamp, raw: entry };
  if (entry?.type === "compaction") {
    out.note = `[compaction] ${entry.summary ?? ""} (tokensBefore=${entry.tokensBefore ?? "?"})`;
    return out;
  }
  if (entry?.type === "model_change") {
    out.note = `[model → ${entry.provider}/${entry.modelId}]`;
    return out;
  }
  if (entry?.type === "thinking_level_change") {
    out.note = `[thinking level → ${entry.thinkingLevel}]`;
    return out;
  }
  if (entry?.type === "branch_summary") {
    out.note = `[branch summary] ${entry.summary ?? ""}`;
    return out;
  }
  if (entry?.type !== "message") return out;

  const msg = entry.message ?? {};
  out.role = msg.role;
  const texts: string[] = [];
  const results: string[] = [];
  const content = msg.content;
  if (typeof content === "string") {
    texts.push(content);
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === "string") {
        texts.push(part);
        // Tool calls: this Pi build uses {type:"toolCall", name, arguments}; older/other
        // shapes use tool_use/tool_call with input/args. Accept all.
      } else if (part?.type === "text") {
        if (part.text) texts.push(part.text);
      } else if (part?.type === "thinking" || part?.type === "reasoning") {
        out.thinking = part.thinking ?? part.text ?? out.thinking;
      } else if (part?.type === "toolCall" || part?.type === "tool_use" || part?.type === "tool_call") {
        out.tool = part.name ?? part.toolName;
        out.args = part.arguments ?? part.input ?? part.args;
      } else if (part?.type === "toolResult" || part?.type === "tool_result") {
        results.push(resultText(part.content ?? part.result));
      } else if (part?.type === "image") {
        results.push(`[image: ${part.mimeType ?? "image"}${part.data ? `, ${part.data.length} b64 chars` : ""}]`);
      }
    }
  }
  // A toolResult-role message carries the result as plain text/image parts.
  if (msg.role === "toolResult" || msg.role === "tool") {
    const joined = [...texts, ...results].filter(Boolean).join("\n");
    if (joined) out.result = joined;
  } else {
    if (texts.length) out.text = texts.join("\n");
    if (results.length) out.result = results.join("\n");
  }
  return out;
}

/** Read a thread JSONL file into { header, entries } of parsed lines. Tolerant of blank/bad lines. */
function readThreadFile(path: string): { header: any; entries: any[] } {
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim().length > 0);
  const parsed: any[] = [];
  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line));
    } catch {
      /* skip a corrupt line rather than fail the whole export */
    }
  }
  const header = parsed[0]?.type === "session" ? parsed[0] : null;
  const entries = header ? parsed.slice(1) : parsed;
  return { header, entries };
}

/** Enumerate a project's thread files (oldest → newest), with SessionManager metadata. */
async function listThreadPaths(project: Project): Promise<Array<{ path: string; id: string; created: Date; modified: Date; cwd: string }>> {
  const infos = await SessionManager.list(project.dir).catch(() => []);
  return infos
    .map((i) => ({ path: i.path, id: i.id, created: i.created, modified: i.modified, cwd: i.cwd }))
    .sort((a, b) => a.created.getTime() - b.created.getTime());
}

/** Build the full analyzable bundle across every thread for a project. */
export async function buildSessionBundle(project: Project, config: BluelineConfig): Promise<SessionBundle> {
  const meta = project.meta();
  const threadPaths = await listThreadPaths(project);
  const threads: ExportedThread[] = [];
  let totalEntries = 0;
  let totalToolCalls = 0;

  for (const info of threadPaths) {
    let parsed: { header: any; entries: any[] };
    try {
      parsed = readThreadFile(info.path);
    } catch {
      continue; // file vanished / unreadable — skip
    }
    const entries = parsed.entries.map(flatten);
    const counts = { user: 0, assistant: 0, toolCalls: 0, toolResults: 0, total: entries.length };
    for (const e of entries) {
      if (e.role === "user") counts.user++;
      else if (e.role === "assistant") counts.assistant++;
      if (e.tool) counts.toolCalls++;
      if (e.result != null) counts.toolResults++;
    }
    totalEntries += entries.length;
    totalToolCalls += counts.toolCalls;
    threads.push({
      id: info.id,
      path: info.path,
      created: info.created.toISOString(),
      modified: info.modified.toISOString(),
      cwd: info.cwd || parsed.header?.cwd || project.dir,
      counts,
      entries,
    });
  }

  return {
    format: "blueline-session-export/1",
    exportedAt: new Date().toISOString(),
    project: { slug: project.slug, dir: project.dir, displayName: meta.displayName },
    model: `${config.designer.provider}/${config.designer.model}`,
    systemPrompt: buildSystemPrompt(project, config),
    totals: { threads: threads.length, entries: totalEntries, toolCalls: totalToolCalls },
    threads,
  };
}

/** Raw concatenation of every thread's JSONL (each line prefixed with nothing — valid NDJSON).
 *  A `# thread: <path>` comment line separates threads for readability. */
export async function buildRawJsonl(project: Project): Promise<string> {
  const threadPaths = await listThreadPaths(project);
  const chunks: string[] = [];
  for (const info of threadPaths) {
    chunks.push(`{"_thread":"${info.id}","_path":${JSON.stringify(info.path)},"_created":"${info.created.toISOString()}"}`);
    try {
      chunks.push(readFileSync(info.path, "utf8").trimEnd());
    } catch {
      /* skip unreadable thread */
    }
  }
  return chunks.join("\n") + "\n";
}
