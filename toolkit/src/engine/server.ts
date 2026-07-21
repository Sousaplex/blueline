// Engine bridge: HTTP + WebSocket server the viewer (and the MCP server) talk to.
// Viewing and running are decoupled: each project gets its own Pi session and
// event buffer, up to MAX_CONCURRENT_RUNS execute in parallel, extras queue FIFO.
//
// Usage: npm run serve -- [projects/<slug>] [--port 7717]
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { WebSocketServer, type WebSocket } from "ws";
import { REPO_ROOT, loadConfig, type PresscheckConfig } from "./config.ts";
import { listEditable, listImageSlots, selectVariant, updateCopy } from "./page-edit.ts";
import { Project } from "./project.ts";
import { PlaywrightBackend } from "./render.ts";
import { createPresscheckSession, type PresscheckSession } from "./session.ts";
import { resetFetchBudget } from "./web-fetch.ts";
import { BRIEF_TEMPLATE, Workspace } from "./workspace.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
  ".pdf": "application/pdf",
  ".woff2": "font/woff2",
};

const MAX_CONCURRENT_RUNS = 2;

interface WireEvent {
  type: string;
  project?: string;
  [k: string]: unknown;
}

export type RunState = "idle" | "queued" | "running";

class Bridge {
  private sessions = new Map<string, PresscheckSession>(); // slug -> session
  private runStates = new Map<string, RunState>(); // slug -> queued|running
  private runQueue: string[] = [];
  private buffers = new Map<string, WireEvent[]>(); // slug -> recent events
  private sockets = new Set<WebSocket>();
  private proofCache = new Map<string, { mtime: number; pages: Buffer[] }>();
  private registryRuntime?: ModelRuntime;
  readonly backend = new PlaywrightBackend(); // shared across all sessions
  config: PresscheckConfig;
  workspace: Workspace;
  project?: Project;

  constructor(workspace: Workspace, project?: Project) {
    this.workspace = workspace;
    this.project = project;
    this.config = loadConfig();
  }

  requireProject(): Project {
    if (!this.project) throw new Error("No project open — create or open a project first");
    return this.project;
  }

  runState(slug: string): RunState {
    return this.runStates.get(slug) ?? "idle";
  }

  private runningCount(): number {
    return [...this.runStates.values()].filter((s) => s === "running").length;
  }

  broadcast(event: WireEvent): void {
    if (event.project) {
      const buffer = this.buffers.get(event.project) ?? [];
      buffer.push(event);
      if (buffer.length > 500) buffer.splice(0, buffer.length - 500);
      this.buffers.set(event.project, buffer);
    }
    const msg = JSON.stringify(event);
    for (const ws of this.sockets) if (ws.readyState === ws.OPEN) ws.send(msg);
  }

  attach(ws: WebSocket): void {
    this.sockets.add(ws);
    ws.send(
      JSON.stringify({
        type: "hello",
        project: this.project?.slug ?? null,
        runStates: Object.fromEntries(this.runStates),
        replay: this.project ? (this.buffers.get(this.project.slug) ?? []).slice(-200) : [],
      }),
    );
    ws.on("close", () => this.sockets.delete(ws));
  }

  feedFor(slug: string): WireEvent[] {
    return this.buffers.get(slug) ?? [];
  }

  /** One Pi session per project, created on demand, events tagged with the slug. */
  private async ensureSession(slug: string): Promise<PresscheckSession> {
    const existing = this.sessions.get(slug);
    if (existing) return existing;
    const project = this.project?.slug === slug ? this.project : new Project(slug, this.workspace);
    const pc = await createPresscheckSession({ project, backend: this.backend });
    this.sessions.set(slug, pc);
    pc.session.subscribe((event: any) => {
      switch (event.type) {
        case "message_update": {
          const e = event.assistantMessageEvent;
          if (e?.type === "text_delta") this.broadcast({ type: "text_delta", project: slug, delta: e.delta });
          break;
        }
        case "tool_execution_start":
          this.broadcast({ type: "tool_start", project: slug, tool: event.toolName ?? event.name, args: event.args ?? {} });
          break;
        case "tool_execution_end": {
          const summary = event.result?.content?.find((c: any) => c.type === "text")?.text ?? "";
          this.broadcast({ type: "tool_end", project: slug, tool: event.toolName ?? event.name, summary: summary.slice(0, 4000) });
          this.broadcast({ type: "files_changed", project: slug });
          break;
        }
        case "agent_start":
          this.runStates.set(slug, "running");
          this.broadcast({ type: "run_state", project: slug, state: "running" });
          break;
        case "agent_end":
          this.runStates.delete(slug);
          this.broadcast({ type: "run_state", project: slug, state: "idle" });
          this.pumpQueue();
          break;
      }
    });
    return pc;
  }

  private pumpQueue(): void {
    while (this.runningCount() < MAX_CONCURRENT_RUNS && this.runQueue.length) {
      const slug = this.runQueue.shift()!;
      if (this.runStates.get(slug) !== "queued") continue;
      void this.startRun(slug);
    }
  }

  private async startRun(slug: string, kickoff?: string): Promise<void> {
    try {
      const pc = await this.ensureSession(slug);
      resetFetchBudget(this.project?.slug === slug ? this.project : new Project(slug, this.workspace));
      this.runStates.set(slug, "running");
      this.broadcast({ type: "run_state", project: slug, state: "running" });
      const prompt =
        kickoff ??
        "Produce the deliverable for this project. Start by reading brief.md, then follow your loop until the reviewer passes the piece or the round limit is hit.";
      void pc.session.prompt(prompt).catch((err) => {
        this.runStates.delete(slug);
        this.broadcast({ type: "error", project: slug, message: err instanceof Error ? err.message : String(err) });
        this.broadcast({ type: "run_state", project: slug, state: "idle" });
        this.pumpQueue();
      });
    } catch (err) {
      this.runStates.delete(slug);
      this.broadcast({ type: "error", project: slug, message: err instanceof Error ? err.message : String(err) });
      this.broadcast({ type: "run_state", project: slug, state: "idle" });
      this.pumpQueue();
    }
  }

  /** Start (or queue) a run for a project — defaults to the currently open one. */
  async run(slug?: string, kickoff?: string): Promise<RunState> {
    const target = slug ?? this.requireProject().slug;
    if (this.runState(target) !== "idle") throw new Error(`"${target}" is already ${this.runState(target)}`);
    if (!existsSync(join(this.workspace.projectsDir, target, "brief.md"))) {
      throw new Error(`"${target}" has no brief.md yet`);
    }
    if (this.runningCount() >= MAX_CONCURRENT_RUNS) {
      this.runStates.set(target, "queued");
      this.runQueue.push(target);
      this.broadcast({ type: "run_state", project: target, state: "queued" });
      return "queued";
    }
    await this.startRun(target, kickoff);
    return "running";
  }

  /** Steering chat goes to the currently open project's session. */
  async chat(text: string): Promise<void> {
    const slug = this.requireProject().slug;
    const pc = await this.ensureSession(slug);
    const opts = pc.session.isStreaming ? { streamingBehavior: "steer" as const } : undefined;
    void pc.session.prompt(text, opts).catch((err) => {
      this.broadcast({ type: "error", project: slug, message: err instanceof Error ? err.message : String(err) });
    });
  }

  async render(): Promise<void> {
    const project = this.requireProject();
    await this.backend.renderPdf(project.pageHtml, project.proofPdf, this.config.render);
    this.broadcast({ type: "files_changed", project: project.slug });
  }

  async proofPages(round?: number): Promise<Buffer[]> {
    const project = this.requireProject();
    const path = round != null ? join(project.reviewDir, `round-${round}.pdf`) : project.proofPdf;
    if (!existsSync(path)) return [];
    const mtime = statSync(path).mtimeMs;
    const cached = this.proofCache.get(path);
    if (cached?.mtime === mtime) return cached.pages;
    const { pdf } = await import("pdf-to-img");
    const doc = await pdf(path, { scale: 2 });
    const pages: Buffer[] = [];
    for await (const page of doc) pages.push(Buffer.from(page));
    this.proofCache.set(path, { mtime, pages });
    if (this.proofCache.size > 8) this.proofCache.delete(this.proofCache.keys().next().value!);
    return pages;
  }

  async modelRegistry(): Promise<{ id: string; models: string[] }[]> {
    this.registryRuntime ??= await ModelRuntime.create();
    return this.registryRuntime
      .getProviders()
      .map((p) => ({ id: p.id, models: this.registryRuntime!.getModels(p.id).map((m) => m.id) }))
      .filter((p) => p.models.length > 0);
  }

  async updateSettings(patch: Partial<PresscheckConfig>): Promise<void> {
    const configPath = resolve(REPO_ROOT, "config", "providers.json");
    const current: Record<string, unknown> = existsSync(configPath)
      ? JSON.parse(readFileSync(configPath, "utf8"))
      : { ...this.config };
    for (const key of ["designer", "reviewer", "images", "render", "webFetch"] as const) {
      if (patch[key]) current[key] = { ...(current[key] as object | undefined), ...patch[key] };
    }
    writeFileSync(configPath, JSON.stringify(current, null, 2) + "\n");
    this.config = loadConfig();
    // Idle sessions pick up the new models on recreation; running ones finish on the old config.
    for (const [slug, pc] of this.sessions) {
      if (this.runState(slug) === "idle") {
        await pc.dispose();
        this.sessions.delete(slug);
      }
    }
    this.broadcast({ type: "settings_changed" });
  }

  listProjects() {
    return this.workspace.listProjects().map((p) => ({
      ...p,
      current: p.slug === this.project?.slug,
      runState: this.runState(p.slug),
      rounds: existsSync(join(p.dir, "review"))
        ? readdirSync(join(p.dir, "review")).filter((f) => /^round-\d+\.json$/.test(f)).length
        : 0,
      hasProof: existsSync(join(p.dir, "out", "proof.pdf")),
    }));
  }

  async openProject(projectDir: string): Promise<void> {
    const next = new Project(projectDir, this.workspace);
    this.project = next;
    this.workspace.persist(next.slug);
    this.broadcast({ type: "project_changed", slug: next.slug });
  }

  async createProject(name: string, brief?: string): Promise<void> {
    const { dir } = this.workspace.createProject(name, brief?.trim() || BRIEF_TEMPLATE);
    this.broadcast({ type: "projects_changed" });
    await this.openProject(dir);
  }

  async closeProject(): Promise<void> {
    this.project = undefined;
    this.workspace.persist(undefined);
    this.broadcast({ type: "project_changed", slug: null });
  }

  async deleteProject(slug: string): Promise<void> {
    if (!/^[a-z0-9-]+$/.test(slug)) throw new Error(`Invalid project slug: ${slug}`);
    if (this.runState(slug) !== "idle") throw new Error(`"${slug}" is ${this.runState(slug)} — stop it before deleting`);
    const dir = join(this.workspace.projectsDir, slug);
    if (!existsSync(dir)) throw new Error(`No such project: ${slug}`);
    const session = this.sessions.get(slug);
    if (session) {
      await session.dispose();
      this.sessions.delete(slug);
    }
    this.buffers.delete(slug);
    if (this.project?.slug === slug) await this.closeProject();
    rmSync(dir, { recursive: true, force: true });
    this.broadcast({ type: "projects_changed" });
  }

  async setWorkspace(root: string): Promise<void> {
    if (this.runningCount() > 0 || this.runQueue.length > 0) {
      throw new Error("Runs are active — wait for them to finish before switching workspaces");
    }
    const next = new Workspace(root).ensure();
    for (const pc of this.sessions.values()) await pc.dispose();
    this.sessions.clear();
    this.buffers.clear();
    this.runStates.clear();
    this.workspace = next;
    this.project = undefined;
    next.persist(undefined);
    this.broadcast({ type: "workspace_changed", root: next.root, slug: null });
  }

  projectState() {
    const base = {
      workspaceRoot: this.workspace.root,
      running: this.project ? this.runState(this.project.slug) === "running" : false,
      runState: this.project ? this.runState(this.project.slug) : "idle",
      runStates: Object.fromEntries(this.runStates),
      designerModel: `${this.config.designer.provider}/${this.config.designer.model}`,
      styleFiles: existsSync(this.workspace.stylesDir)
        ? readdirSync(this.workspace.stylesDir).filter((f) => !f.startsWith("."))
        : [],
    };
    const allContext = existsSync(this.workspace.contextDir)
      ? readdirSync(this.workspace.contextDir).filter((f) => !f.startsWith("."))
      : [];
    const selected = this.project?.selectedSources() ?? null;
    const contextFiles = allContext.map((name) => ({
      name,
      selected: selected === null || selected.includes(name),
    }));
    if (!this.project) {
      return { ...base, contextFiles, slug: null, brief: "", rounds: [], images: [], editable: [], hasPage: false, hasProof: false };
    }
    const rounds = readdirSync(this.project.reviewDir)
      .map((f) => /^round-(\d+)\.json$/.exec(f)?.[1])
      .filter(Boolean)
      .map(Number)
      .sort((a, b) => a - b)
      .map((n) => ({
        round: n,
        hasProof: existsSync(join(this.project!.reviewDir, `round-${n}.pdf`)),
        ...JSON.parse(readFileSync(join(this.project!.reviewDir, `round-${n}.json`), "utf8")),
      }));
    return {
      ...base,
      contextFiles,
      slug: this.project.slug,
      brief: existsSync(join(this.project.dir, "brief.md")) ? this.project.brief() : "",
      rounds,
      images: listImageSlots(this.project),
      editable: listEditable(this.project),
      hasPage: existsSync(this.project.pageHtml),
      hasProof: existsSync(this.project.proofPdf),
    };
  }

  /** Slug-addressable review data (for the MCP server — no UI switching needed). */
  reviewsFor(slug: string) {
    const dir = join(this.workspace.projectsDir, slug, "review");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .map((f) => /^round-(\d+)\.json$/.exec(f)?.[1])
      .filter(Boolean)
      .map(Number)
      .sort((a, b) => a - b)
      .map((n) => ({ round: n, ...JSON.parse(readFileSync(join(dir, `round-${n}.json`), "utf8")) }));
  }

  async dispose() {
    for (const pc of this.sessions.values()) await pc.dispose();
    await this.backend.close();
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

export async function startServer(projectDirArg: string | undefined, port: number): Promise<void> {
  const { workspace, lastProject } = Workspace.load();
  let project: Project | undefined;
  const candidate = projectDirArg ?? lastProject;
  if (candidate) {
    try {
      project = new Project(candidate, workspace);
    } catch {
      project = undefined;
    }
  }
  const bridge = new Bridge(workspace, project);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,OPTIONS",
          "access-control-allow-headers": "content-type",
        });
        return res.end();
      }

      // Built viewer (app/dist) as web root.
      const appDist = join(REPO_ROOT, "app", "dist");
      if (req.method === "GET" && !url.pathname.startsWith("/api") && !url.pathname.startsWith("/files") && url.pathname !== "/ws") {
        const rel = url.pathname === "/" ? "index.html" : normalize(decodeURIComponent(url.pathname.slice(1)));
        const file = join(appDist, rel);
        if (!rel.startsWith("..") && existsSync(file) && statSync(file).isFile()) {
          res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
          return res.end(readFileSync(file));
        }
        if (url.pathname === "/") {
          return json(res, 200, { presscheck: "bridge running", note: "build the viewer (app: npm run build) to serve the UI here" });
        }
      }

      // Static project files for the live preview iframe.
      if (url.pathname.startsWith("/files/")) {
        if (!bridge.project) return json(res, 404, { error: "no project open" });
        const rel = normalize(decodeURIComponent(url.pathname.slice("/files/".length)));
        if (rel.startsWith("..")) return json(res, 403, { error: "forbidden" });
        const file = join(bridge.project.dir, rel);
        if (!existsSync(file) || !statSync(file).isFile()) return json(res, 404, { error: "not found" });
        res.writeHead(200, {
          "content-type": MIME[extname(file)] ?? "application/octet-stream",
          "access-control-allow-origin": "*",
          "cache-control": "no-store",
        });
        return res.end(readFileSync(file));
      }

      if (url.pathname === "/api/project") return json(res, 200, bridge.projectState());
      if (url.pathname === "/api/projects") return json(res, 200, { projects: bridge.listProjects() });
      if (url.pathname === "/api/feed") {
        const slug = url.searchParams.get("slug");
        if (!slug) return json(res, 400, { error: "slug required" });
        return json(res, 200, { feed: bridge.feedFor(slug).slice(-200) });
      }
      if (url.pathname === "/api/reviews") {
        const slug = url.searchParams.get("slug");
        if (!slug) return json(res, 400, { error: "slug required" });
        return json(res, 200, { reviews: bridge.reviewsFor(slug) });
      }

      if (req.method === "POST" && url.pathname === "/api/open") {
        const body = await readBody(req);
        if (!body.projectDir) return json(res, 400, { error: "projectDir required" });
        await bridge.openProject(body.projectDir);
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/project/new") {
        const body = await readBody(req);
        if (!body.name) return json(res, 400, { error: "name required" });
        await bridge.createProject(body.name, body.brief);
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/project/close") {
        await bridge.closeProject();
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/project/delete") {
        const body = await readBody(req);
        if (!body.slug) return json(res, 400, { error: "slug required" });
        await bridge.deleteProject(body.slug);
        return json(res, 200, { ok: true });
      }

      if (req.method === "POST" && url.pathname === "/api/brief") {
        const body = await readBody(req);
        if (typeof body.content !== "string" || !body.content.trim()) {
          return json(res, 400, { error: "content required" });
        }
        bridge.requireProject().writeBrief(body.content);
        bridge.broadcast({ type: "files_changed", project: bridge.project!.slug });
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/sources/select") {
        const body = await readBody(req);
        bridge.requireProject().setSelectedSources(Array.isArray(body.files) ? body.files : null);
        bridge.broadcast({ type: "files_changed", project: bridge.project!.slug });
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/sources/upload") {
        const body = await readBody(req);
        const kind = body.kind === "style" ? "style" : "context";
        const name = String(body.name ?? "").split(/[/\\]/).pop();
        if (!name || !body.dataBase64) return json(res, 400, { error: "name and dataBase64 required" });
        const dir = kind === "style" ? bridge.workspace.stylesDir : bridge.workspace.contextDir;
        writeFileSync(join(dir, name), Buffer.from(String(body.dataBase64), "base64"));
        bridge.broadcast({ type: "files_changed", project: bridge.project?.slug });
        return json(res, 200, { ok: true, path: join(dir, name) });
      }

      if (url.pathname === "/api/workspace") {
        if (req.method === "POST") {
          const body = await readBody(req);
          if (!body.root) return json(res, 400, { error: "root required" });
          await bridge.setWorkspace(body.root);
          return json(res, 200, { ok: true });
        }
        return json(res, 200, { root: bridge.workspace.root, projects: bridge.listProjects() });
      }

      if (url.pathname === "/api/proof/meta") {
        const round = url.searchParams.get("round");
        const pages = await bridge.proofPages(round ? Number(round) : undefined);
        return json(res, 200, { pages: pages.length });
      }
      const pageMatch = /^\/api\/proof\/page\/(\d+)$/.exec(url.pathname);
      if (pageMatch) {
        const round = url.searchParams.get("round");
        const pages = await bridge.proofPages(round ? Number(round) : undefined);
        const idx = Number(pageMatch[1]);
        if (idx < 0 || idx >= pages.length) return json(res, 404, { error: "no such page" });
        res.writeHead(200, { "content-type": "image/png", "access-control-allow-origin": "*", "cache-control": "no-store" });
        return res.end(pages[idx]);
      }

      if (url.pathname === "/api/settings") {
        if (req.method === "POST") {
          await bridge.updateSettings(await readBody(req));
          return json(res, 200, { ok: true });
        }
        return json(res, 200, {
          config: bridge.config,
          registry: await bridge.modelRegistry(),
          suggestions: {
            reviewer: ["gemini-3.5-flash", "gemini-3.1-pro-preview", "gemini-2.5-flash"],
            images: ["gemini-3.1-flash-image", "gemini-3-pro-image", "gemini-2.5-flash-image"],
          },
        });
      }

      if (req.method === "POST" && url.pathname === "/api/run") {
        const body = await readBody(req);
        const state = await bridge.run(body.slug, body.prompt);
        return json(res, 200, { ok: true, state });
      }
      if (req.method === "POST" && url.pathname === "/api/chat") {
        const body = await readBody(req);
        if (!body.text) return json(res, 400, { error: "text required" });
        await bridge.chat(body.text);
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/render") {
        await bridge.render();
        return json(res, 200, { ok: true });
      }

      json(res, 404, { error: `no route: ${url.pathname}` });
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (ws) => bridge.attach(ws));

  await new Promise<void>((resolve) => server.listen(port, resolve));
  console.log(
    `presscheck bridge — workspace=${bridge.workspace.root} project=${bridge.project?.slug ?? "(none)"} http://localhost:${port}`,
  );

  const shutdown = async () => {
    await bridge.dispose();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// CLI entry — project arg optional; falls back to the persisted workspace state.
const isMain = process.argv[1]?.endsWith("server.ts");
if (isMain) {
  const args = process.argv.slice(2);
  let projectDir: string | undefined;
  let port = 7717;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port") port = Number(args[++i]);
    else if (!args[i].startsWith("--")) projectDir = args[i];
  }
  await startServer(projectDir, port);
}
