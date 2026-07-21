// presscheck MCP server — lets external agents (Claude Code, Kimi CLI, …)
// drive presscheck: create projects, write briefs, queue design runs, read
// review verdicts. It is a thin stdio client of the engine bridge, so state
// is shared with the desktop app / viewer: what an agent does here shows up
// live in the UI.
//
// Register (Claude Code):
//   claude mcp add presscheck -- npx tsx /path/to/presscheck/toolkit/src/mcp/server.ts
// The bridge must be running (the desktop app, or `npm run serve` in toolkit/).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BRIDGE = process.env.PRESSCHECK_BRIDGE_URL ?? "http://localhost:7717";

async function api(path: string, body?: unknown): Promise<any> {
  let res: Response;
  try {
    res = await fetch(`${BRIDGE}${path}`, {
      method: body === undefined ? "GET" : "POST",
      // The client tag shows up in the app's System tab so humans can watch MCP drive it.
      headers: { "content-type": "application/json", "x-blueline-client": "mcp" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error(
      `presscheck bridge unreachable at ${BRIDGE} — start the presscheck app, or run \`npm run serve\` in the toolkit directory`,
    );
  }
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error ?? `${path}: HTTP ${res.status}`);
  return payload;
}

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

const server = new McpServer({ name: "blueline", version: "0.1.0" });

server.tool(
  "workspace_status",
  "Current workspace root, all projects with their run states (idle/queued/running), rounds and proof status.",
  {},
  async () => text(await api("/api/workspace")),
);

server.tool(
  "create_project",
  "Create a new project in the workspace with a brief (markdown). The brief drives the whole design: format (one-pager/poster/multipage + paper size), audience, goal, key messages, must-include elements, tone.",
  { name: z.string().describe("project name, will be slugified"), brief: z.string().describe("full brief.md content") },
  async ({ name, brief }) => {
    await api("/api/project/new", { name, brief });
    return text(`Project created and opened. Run it with run_project.`);
  },
);

server.tool(
  "update_brief",
  "Replace the brief.md of the currently open project.",
  { content: z.string() },
  async ({ content }) => {
    await api("/api/brief", { content });
    return text("Brief updated.");
  },
);

server.tool(
  "add_source",
  "Add a source file to the workspace (kind=context: facts/copy points/product docs; kind=style: brand & style guides that apply to every project). Content is plain text/markdown.",
  {
    kind: z.enum(["context", "style"]),
    filename: z.string().describe("e.g. product-facts.md"),
    content: z.string(),
  },
  async ({ kind, filename, content }) => {
    await api("/api/sources/upload", { kind, name: filename, dataBase64: Buffer.from(content, "utf8").toString("base64") });
    return text(`Added ${kind} source: ${filename}`);
  },
);

server.tool(
  "run_project",
  "Start (or queue) the autonomous design loop for a project: draft HTML -> generate images -> render PDF -> vision review -> fix, until the reviewer passes it or the round limit hits. Up to 2 projects run in parallel; extras queue. Returns immediately — poll run_status.",
  { slug: z.string().describe("project slug from workspace_status") },
  async ({ slug }) => {
    const { state } = await api("/api/run", { slug });
    return text(`"${slug}" is now ${state}. Poll run_status for progress; a full loop typically takes 3-6 minutes.`);
  },
);

server.tool(
  "run_status",
  "Run states for all projects plus review verdict trajectory for one optional slug.",
  { slug: z.string().optional() },
  async ({ slug }) => {
    const ws = await api("/api/workspace");
    const summary: Record<string, unknown> = {
      projects: ws.projects.map((p: any) => ({ slug: p.slug, runState: p.runState, rounds: p.rounds, hasProof: p.hasProof })),
    };
    if (slug) {
      const { reviews } = await api(`/api/reviews?slug=${encodeURIComponent(slug)}`);
      summary.reviews = reviews.map((r: any) => ({ round: r.round, verdict: r.verdict, issues: r.issues?.length ?? 0 }));
    }
    return text(summary);
  },
);

server.tool(
  "get_reviews",
  "Full review feedback (verdicts, per-page issues, notes) for a project.",
  { slug: z.string() },
  async ({ slug }) => text(await api(`/api/reviews?slug=${encodeURIComponent(slug)}`)),
);

server.tool(
  "branch_project",
  "Branch a project to explore an alternative — optionally from a specific review round's archived state (an 'alternate round N+1'). The branch copies the page, images and source selection; lineage is recorded.",
  {
    slug: z.string(),
    round: z.number().int().optional().describe("review round to branch from; omit = current state"),
    name: z.string().optional().describe("name for the branch project"),
  },
  async ({ slug, round, name }) => {
    const payload = await api("/api/project/fork", { slug, round, name, open: false });
    return text(`Branched "${slug}"${round != null ? ` from round ${round}` : ""} into "${payload.slug}". Run it with run_project.`);
  },
);

server.tool(
  "create_series",
  "Fan an approved project out into a document series ('6 like this for topics A-Z'): each subject becomes a sibling project that keeps the template's layout and adapts copy/imagery. Runs queue automatically unless run=false.",
  {
    slug: z.string().describe("template project — must have a finished page.html"),
    rootName: z.string().describe("series name; drives grouping and export filenames"),
    topics: z.array(z.string()).min(1).describe("one subject per document"),
    run: z.boolean().optional().describe("queue agent runs immediately (default true)"),
  },
  async ({ slug, rootName, topics, run }) => {
    const { created } = await api("/api/series", { slug, rootName, topics, run: run !== false });
    return text(created.map((c: { slug: string; state: string }) => `${c.slug}: ${c.state}`).join("\n"));
  },
);

server.tool(
  "set_project_meta",
  "Update the open project's metadata: display name, series, or page settings (pageSize/orientation/pages — the page count is mechanically enforced by the reviewer).",
  {
    displayName: z.string().optional(),
    series: z.string().nullable().optional(),
    settings: z
      .object({
        pageSize: z.string().optional(),
        orientation: z.enum(["portrait", "landscape"]).optional(),
        pages: z.number().int().min(1).max(24).optional(),
      })
      .optional(),
  },
  async (patch) => {
    const { meta } = await api("/api/meta", patch);
    return text(meta);
  },
);

server.tool(
  "open_project",
  "Open a project in the presscheck UI (switches what the human sees; not required for run_project).",
  { slug: z.string() },
  async ({ slug }) => {
    await api("/api/open", { projectDir: slug });
    return text(`Opened ${slug} in the UI.`);
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`blueline MCP server ready (bridge: ${BRIDGE})`);
