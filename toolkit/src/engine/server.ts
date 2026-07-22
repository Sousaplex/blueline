// Engine bridge: HTTP + WebSocket server the viewer (and the MCP server) talk to.
// Viewing and running are decoupled: each project gets its own Pi session and
// event buffer, up to MAX_CONCURRENT_RUNS execute in parallel, extras queue FIFO.
//
// Usage: npm run serve -- [projects/<slug>] [--port 7717]
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { WebSocketServer, type WebSocket } from "ws";
import { DATA_ROOT, REPO_ROOT, loadConfig, saveApiKeys, type BluelineConfig } from "./config.ts";
import { draftBrief } from "./brief-draft.ts";
import { gitClone, gitConnect, gitStatus, gitSync } from "./git-sync.ts";
import { generateImages } from "./images.ts";
import {
  deleteElement,
  tagElement,
  getElementStyle,
  listEditable,
  listImageSlots,
  moveElement,
  moveElementBefore,
  pageSource,
  selectVariant,
  setElementStyle,
  setImageStyle,
  updateCopy,
  writePageSource,
} from "./page-edit.ts";
import { Project, listSourceFiles, pageDims, safeRelPath, type ProjectMeta } from "./project.ts";
import { clearHistory, historyDepth, redoPage, snapshotPage, undoPage } from "./undo.ts";
import { PlaywrightBackend } from "./render.ts";
import { markRunStart } from "./review.ts";
import { resetSearchBudget } from "./search.ts";
import { createBluelineSession, type BluelineSession } from "./session.ts";
import { deleteTemplate, instantiateTemplate, listTemplates, saveTemplate, templateBrief } from "./templates.ts";
import { suggestDirections, variantBrief, type Direction } from "./variants.ts";
import { resetFetchBudget } from "./web-fetch.ts";
import { BRIEF_TEMPLATE, Workspace } from "./workspace.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".md": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
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
  private sessions = new Map<string, BluelineSession>(); // slug -> session
  private runStates = new Map<string, RunState>(); // slug -> queued|running
  // Chat requests in flight: when the agent finishes one and page.html changed,
  // the result is archived as an "edit" round — every AI edit is design history.
  private pendingEdits = new Map<string, { prompt: string; hash: string; rounds: number }>();
  private runQueue: string[] = [];
  private buffers = new Map<string, WireEvent[]>(); // slug -> recent events
  private systemFeed: WireEvent[] = []; // API/MCP actions, for the System tab
  private sockets = new Set<WebSocket>();
  private proofCache = new Map<string, { mtime: number; pages: Buffer[] }>();
  private registryRuntime?: ModelRuntime;
  readonly backend = new PlaywrightBackend(); // shared across all sessions
  config: BluelineConfig;
  workspace: Workspace;
  project?: Project;
  /** True until a workspace is persisted for the first time — drives onboarding. */
  fresh: boolean;

  constructor(workspace: Workspace, project?: Project, fresh = false) {
    this.workspace = workspace;
    this.project = project;
    this.fresh = fresh;
    this.config = loadConfig();
  }

  /** Onboarding status: never reveals key values, only which ones exist. */
  setupState() {
    return {
      fresh: this.fresh,
      workspaceRoot: this.workspace.root,
      defaultWorkspaceRoot: DATA_ROOT,
      keys: {
        GEMINI_API_KEY: Boolean(process.env.GEMINI_API_KEY),
        MOONSHOT_API_KEY: Boolean(process.env.MOONSHOT_API_KEY),
      },
      designer: `${this.config.designer.provider}/${this.config.designer.model}`,
    };
  }

  /** Finish onboarding: persist the chosen (or current) workspace. */
  completeSetup(): void {
    this.workspace.persist(this.project?.slug);
    this.fresh = false;
    this.broadcast({ type: "setup_changed" });
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

  /** Record an externally-triggered action (UI, MCP, raw API) for the System tab. */
  logSystem(source: string, action: string, detail: string): void {
    const event: WireEvent = { type: "system", source, action, detail, at: Date.now() };
    this.systemFeed.push(event);
    if (this.systemFeed.length > 300) this.systemFeed.splice(0, this.systemFeed.length - 300);
    this.broadcast(event);
  }

  systemEvents(): WireEvent[] {
    return this.systemFeed.slice(-200);
  }

  /** One Pi session per project, created on demand, events tagged with the slug. */
  private async ensureSession(slug: string): Promise<BluelineSession> {
    const existing = this.sessions.get(slug);
    if (existing) return existing;
    const project = this.project?.slug === slug ? this.project : new Project(slug, this.workspace);
    const pc = await createBluelineSession({ project, backend: this.backend });
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
          this.captureEditRound(slug);
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
      const project = this.project?.slug === slug ? this.project : new Project(slug, this.workspace);
      resetFetchBudget(project);
      resetSearchBudget(project);
      markRunStart(project); // review round cap is per run
      this.runStates.set(slug, "running");
      this.broadcast({ type: "run_state", project: slug, state: "running" });
      const prompt =
        kickoff ??
        "Produce the deliverable for this project. Start by reading brief.md, then follow your loop until the reviewer passes the piece or the round limit is hit.";
      // Every prompt the agent receives is visible in the feed — runs included.
      this.broadcast({ type: "chat", project: slug, text: prompt });
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

  private pageHash(project: Project): string {
    return existsSync(project.pageHtml) ? createHash("sha1").update(readFileSync(project.pageHtml)).digest("hex") : "";
  }

  /** Archive a finished chat edit as an "edit" round (page state + the prompt that caused it).
   *  Skipped when a review round already captured the state (full runs) or nothing changed. */
  private captureEditRound(slug: string): void {
    const marker = this.pendingEdits.get(slug);
    if (!marker) return;
    this.pendingEdits.delete(slug);
    try {
      const project = this.project?.slug === slug ? this.project : new Project(slug, this.workspace);
      if (project.completedRounds() > marker.rounds) return; // a review round already archived this work
      const hash = this.pageHash(project);
      if (!hash || hash === marker.hash) return; // the chat didn't touch the page
      const round = project.completedRounds() + 1;
      project.writeReview(round, { verdict: "edit", issues: [], notes: marker.prompt.slice(0, 300) });
      cpSync(project.pageHtml, project.roundHtml(round));
      this.logSystem("app", "edit_round", `${slug}: round ${round}`);
      this.broadcast({ type: "files_changed", project: slug });
    } catch {
      // archiving is best-effort — never let it break the run lifecycle
    }
  }

  /** Steering chat goes to the currently open project's session. */
  async chat(text: string): Promise<void> {
    const project = this.requireProject();
    const slug = project.slug;
    // Echo the user's message into the project feed (buffered, so it replays too) —
    // a prompt that vanishes into the void reads as a broken app.
    this.broadcast({ type: "chat", project: slug, text });
    this.pendingEdits.set(slug, { prompt: text, hash: this.pageHash(project), rounds: project.completedRounds() });
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

  async updateSettings(patch: Partial<BluelineConfig>): Promise<void> {
    // Guard the classic trap: pasting an actual API key where an env-var NAME belongs.
    // If it doesn't look like an env name, store it as a secret and point config at
    // the provider's standard variable instead.
    const PROVIDER_KEY_ENV: Record<string, string> = {
      google: "GEMINI_API_KEY",
      moonshotai: "MOONSHOT_API_KEY",
      "kimi-coding": "MOONSHOT_API_KEY",
      anthropic: "ANTHROPIC_API_KEY",
      openai: "OPENAI_API_KEY",
      openrouter: "OPENROUTER_API_KEY",
      groq: "GROQ_API_KEY",
      cerebras: "CEREBRAS_API_KEY",
      xai: "XAI_API_KEY",
      zai: "ZAI_API_KEY",
    };
    if (patch.designer) {
      const d = patch.designer as { provider?: string; apiKeyEnv?: string };
      const defaultEnv = PROVIDER_KEY_ENV[d.provider ?? this.config.designer.provider];
      if (typeof d.apiKeyEnv === "string" && d.apiKeyEnv.trim() && !/^[A-Z][A-Z0-9_]*$/.test(d.apiKeyEnv.trim())) {
        if (!defaultEnv) throw new Error("apiKeyEnv must be an environment variable NAME like MOONSHOT_API_KEY, not the key itself");
        saveApiKeys({ [defaultEnv]: d.apiKeyEnv.trim() });
        d.apiKeyEnv = defaultEnv;
      } else if (d.provider && !d.apiKeyEnv && defaultEnv) {
        d.apiKeyEnv = defaultEnv; // provider switches keep keys working without a manual field
      }
    }
    const configPath = resolve(DATA_ROOT, "config", "providers.json");
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
    return this.workspace.listProjects().map((p) => {
      const meta = new Project(p.dir, this.workspace).meta();
      const rounds = existsSync(join(p.dir, "review"))
        ? readdirSync(join(p.dir, "review"))
            .map((f) => /^round-(\d+)\.json$/.exec(f)?.[1])
            .filter(Boolean)
            .map(Number)
            .sort((a, b) => a - b)
        : [];
      const last = rounds.at(-1);
      let lastVerdict: string | null = null;
      if (last !== undefined) {
        try {
          lastVerdict = JSON.parse(readFileSync(join(p.dir, "review", `round-${last}.json`), "utf8")).verdict ?? null;
        } catch {
          lastVerdict = null;
        }
      }
      return {
        ...p,
        current: p.slug === this.project?.slug,
        runState: this.runState(p.slug),
        rounds: rounds.length,
        lastVerdict,
        hasProof: existsSync(join(p.dir, "out", "proof.pdf")),
        meta,
      };
    });
  }

  async openProject(projectDir: string): Promise<void> {
    const next = new Project(projectDir, this.workspace);
    this.project = next;
    this.workspace.persist(next.slug);
    this.broadcast({ type: "project_changed", slug: next.slug });
  }

  async createProject(name: string, brief?: string, meta?: Partial<ProjectMeta>, template?: string): Promise<void> {
    const initialBrief = brief?.trim() || (template ? templateBrief(this.workspace, template)?.trim() : undefined) || BRIEF_TEMPLATE;
    const { dir } = this.workspace.createProject(name, initialBrief);
    const project = new Project(dir, this.workspace);
    if (template) {
      const info = instantiateTemplate(this.workspace, template, dir);
      project.updateMeta({ template: info.slug, settings: info.settings });
    }
    project.updateMeta({ displayName: name.trim(), ...meta });
    this.broadcast({ type: "projects_changed" });
    await this.openProject(dir);
  }

  /** Create a project slug that doesn't collide, appending -2, -3… if needed. */
  private createUniqueProject(name: string, brief: string): { dir: string; slug: string } {
    for (let i = 0; i < 50; i++) {
      try {
        return this.workspace.createProject(i === 0 ? name : `${name}-${i + 1}`, brief);
      } catch (err) {
        if (!(err instanceof Error) || !err.message.includes("already exists")) throw err;
      }
    }
    throw new Error(`Could not find a free slug for "${name}"`);
  }

  /** Copy the design state (page + images + source selection) from one project dir to another. */
  private copyDesignState(base: Project, targetDir: string, pageHtmlSource?: string): void {
    const html = pageHtmlSource ?? base.pageHtml;
    if (existsSync(html)) cpSync(html, join(targetDir, "page.html"));
    if (existsSync(base.imagesDir)) cpSync(base.imagesDir, join(targetDir, "images"), { recursive: true });
    const sourcesJson = join(base.dir, "sources.json");
    if (existsSync(sourcesJson)) cpSync(sourcesJson, join(targetDir, "sources.json"));
  }

  /** Branch a project — optionally from a specific review round's archived state. */
  async forkProject(baseSlug: string, opts: { round?: number; name?: string } = {}): Promise<string> {
    const base = new Project(baseSlug, this.workspace);
    const baseMeta = base.meta();
    let pageSource: string | undefined;
    if (opts.round != null) {
      pageSource = base.roundHtml(opts.round);
      if (!existsSync(pageSource)) {
        throw new Error(`Round ${opts.round} has no archived page state (run predates branching) — it can't be branched`);
      }
    }
    const name = opts.name?.trim() || (opts.round != null ? `${baseSlug}-r${opts.round}-alt` : `${baseSlug}-fork`);
    const { dir, slug } = this.createUniqueProject(name, base.brief());
    this.copyDesignState(base, dir, pageSource);
    new Project(dir, this.workspace).updateMeta({
      displayName: opts.name?.trim() || `${baseMeta.displayName} (from round ${opts.round ?? "latest"})`,
      series: baseMeta.series,
      kind: "document",
      parent: baseSlug,
      forkedFromRound: opts.round ?? null,
      template: baseMeta.template,
      settings: baseMeta.settings,
    });
    this.broadcast({ type: "projects_changed" });
    return slug;
  }

  /** "Make N like this": clone an approved project as the template for a document series. */
  async createSeries(
    templateSlug: string,
    rootName: string,
    topics: string[],
    autoRun: boolean,
  ): Promise<{ slug: string; state: RunState }[]> {
    const template = new Project(templateSlug, this.workspace);
    if (!existsSync(template.pageHtml)) {
      throw new Error(`"${templateSlug}" has no page.html yet — a series template needs a finished design`);
    }
    const series = rootName.trim();
    if (!series) throw new Error("Series needs a root name");
    const cleanTopics = topics.map((t) => t.trim()).filter(Boolean);
    if (!cleanTopics.length) throw new Error("Series needs at least one subject");
    const templateMeta = template.meta();
    template.updateMeta({ series }); // the template groups with its children

    const created: { slug: string; state: RunState }[] = [];
    for (const topic of cleanTopics) {
      const brief = `${template.brief().trimEnd()}

## This document's subject
${topic}

This document is part of the "${series}" series. page.html already contains the approved
layout from the series template — keep its design system and structure; adapt the copy and
imagery to this subject.
`;
      const { dir, slug } = this.createUniqueProject(`${series}-${topic}`, brief);
      this.copyDesignState(template, dir);
      new Project(dir, this.workspace).updateMeta({
        displayName: topic,
        series,
        kind: "document",
        parent: templateSlug,
        template: templateMeta.template,
        settings: templateMeta.settings,
      });
      created.push({ slug, state: "idle" });
    }
    this.broadcast({ type: "projects_changed" });
    if (autoRun) {
      for (const entry of created) {
        entry.state = await this.run(
          entry.slug,
          "page.html contains the approved series template. Adapt it to this document's subject per brief.md: keep the layout and design system, replace the copy, and update images/prompts.json + regenerate images where the subject calls for different visuals. Then render and review until the piece passes.",
        );
      }
    }
    return created;
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
    clearHistory(dir);
    if (this.project?.slug === slug) await this.closeProject();
    rmSync(dir, { recursive: true, force: true });
    this.broadcast({ type: "projects_changed" });
  }

  /** Fan a project out into direction variants — sibling projects, queued to run. */
  async createVariants(baseSlug: string, directions: Direction[]): Promise<{ slug: string; state: RunState }[]> {
    const baseDir = join(this.workspace.projectsDir, baseSlug);
    if (!existsSync(join(baseDir, "brief.md"))) throw new Error(`"${baseSlug}" has no brief.md`);
    const baseBrief = readFileSync(join(baseDir, "brief.md"), "utf8");
    const baseMeta = new Project(baseDir, this.workspace).meta();
    const created: { slug: string; state: RunState }[] = [];
    for (const direction of directions) {
      if (!direction.label?.trim() || !direction.direction?.trim()) continue;
      const { dir, slug } = this.createUniqueProject(`${baseSlug}-${direction.label}`, variantBrief(baseBrief, direction));
      const sourcesJson = join(baseDir, "sources.json");
      if (existsSync(sourcesJson)) {
        writeFileSync(join(dir, "sources.json"), readFileSync(sourcesJson));
      }
      new Project(dir, this.workspace).updateMeta({
        displayName: direction.label,
        series: baseMeta.series,
        kind: "variant",
        parent: baseSlug,
        settings: baseMeta.settings,
      });
      created.push({ slug, state: "idle" });
    }
    if (!created.length) throw new Error("No valid directions provided");
    this.broadcast({ type: "projects_changed" });
    for (const entry of created) {
      entry.state = await this.run(entry.slug);
    }
    return created;
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
    this.fresh = false; // choosing a workspace completes first-run setup
    this.broadcast({ type: "workspace_changed", root: next.root, slug: null });
  }

  projectState() {
    const base = {
      workspaceRoot: this.workspace.root,
      running: this.project ? this.runState(this.project.slug) === "running" : false,
      runState: this.project ? this.runState(this.project.slug) : "idle",
      runStates: Object.fromEntries(this.runStates),
      designerModel: `${this.config.designer.provider}/${this.config.designer.model}`,
      brandFiles: listSourceFiles(this.workspace.brandDir),
    };
    const selected = this.project?.selectedSources() ?? null;
    const contextFiles = listSourceFiles(this.workspace.contextDir).map((f) => ({
      ...f,
      name: f.path, // legacy field name kept for the UI
      selected: selected === null || selected.includes(f.path),
    }));
    if (!this.project) {
      return { ...base, contextFiles, slug: null, meta: null, artboard: null, history: { undo: 0, redo: 0 }, brief: "", rounds: [], images: [], editable: [], hasPage: false, hasProof: false };
    }
    const rounds = readdirSync(this.project.reviewDir)
      .map((f) => /^round-(\d+)\.json$/.exec(f)?.[1])
      .filter(Boolean)
      .map(Number)
      .sort((a, b) => a - b)
      .map((n) => ({
        round: n,
        hasProof: existsSync(join(this.project!.reviewDir, `round-${n}.pdf`)),
        hasHtml: existsSync(this.project!.roundHtml(n)), // branchable?
        ...JSON.parse(readFileSync(join(this.project!.reviewDir, `round-${n}.json`), "utf8")),
      }));
    return {
      ...base,
      contextFiles,
      slug: this.project.slug,
      meta: this.project.meta(),
      artboard: pageDims(this.project.meta().settings),
      history: historyDepth(this.project),
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
  const { workspace, lastProject, fresh } = Workspace.load();
  let project: Project | undefined;
  const candidate = projectDirArg ?? lastProject;
  if (candidate) {
    try {
      project = new Project(candidate, workspace);
    } catch {
      project = undefined;
    }
  }
  const bridge = new Bridge(workspace, project, fresh && !projectDirArg);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    // Who is driving? The app sends nothing; the MCP server tags itself. Shown in the System tab.
    const source = String(req.headers["x-blueline-client"] ?? "app");
    const sys = (action: string, detail: string) => bridge.logSystem(source, action, detail);
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
          return json(res, 200, { blueline: "bridge running", note: "build the viewer (app: npm run build) to serve the UI here" });
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
        sys("open_project", String(body.projectDir));
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/project/new") {
        const body = await readBody(req);
        if (!body.name) return json(res, 400, { error: "name required" });
        await bridge.createProject(body.name, body.brief, body.meta, body.template ? String(body.template) : undefined);
        sys("create_project", `${body.name}${body.template ? ` (template: ${body.template})` : ""}`);
        return json(res, 200, { ok: true });
      }
      if (url.pathname === "/api/templates") {
        if (req.method === "POST") {
          const body = await readBody(req);
          if (!body.slug || !body.name) return json(res, 400, { error: "slug and name required" });
          const info = saveTemplate(new Project(String(body.slug), bridge.workspace), String(body.name), body.description ? String(body.description) : "");
          sys("save_template", `${body.slug} -> ${info.slug}`);
          return json(res, 200, { ok: true, template: info });
        }
        return json(res, 200, { templates: listTemplates(bridge.workspace) });
      }
      if (req.method === "POST" && url.pathname === "/api/templates/delete") {
        const body = await readBody(req);
        if (!body.slug) return json(res, 400, { error: "slug required" });
        deleteTemplate(bridge.workspace, String(body.slug));
        sys("delete_template", String(body.slug));
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
        sys("delete_project", String(body.slug));
        return json(res, 200, { ok: true });
      }

      if (req.method === "POST" && url.pathname === "/api/brief/draft") {
        const body = await readBody(req);
        if (typeof body.idea !== "string" || !body.idea.trim()) return json(res, 400, { error: "idea required" });
        const fields = await draftBrief(bridge.workspace, bridge.config, String(body.idea), body.format ? String(body.format) : undefined);
        sys("draft_brief", String(body.idea).slice(0, 80));
        return json(res, 200, { fields });
      }
      if (req.method === "POST" && url.pathname === "/api/brief") {
        const body = await readBody(req);
        if (typeof body.content !== "string" || !body.content.trim()) {
          return json(res, 400, { error: "content required" });
        }
        bridge.requireProject().writeBrief(body.content);
        sys("update_brief", `${bridge.project!.slug} (${String(body.content).length} chars)`);
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
        const kind = body.kind === "style" || body.kind === "brand" ? "brand" : "context";
        // name may carry a relative folder path (drag-dropped folders keep their structure)
        const rel = safeRelPath(String(body.name ?? ""));
        if (!body.dataBase64) return json(res, 400, { error: "name and dataBase64 required" });
        const dir = kind === "brand" ? bridge.workspace.brandDir : bridge.workspace.contextDir;
        const target = join(dir, rel);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, Buffer.from(String(body.dataBase64), "base64"));
        sys("upload_source", `${kind}/${rel}`);
        bridge.broadcast({ type: "files_changed", project: bridge.project?.slug });
        return json(res, 200, { ok: true, path: target });
      }
      // Serve a workspace source file (context/ or styles/) — used for image thumbnails.
      if (req.method === "GET" && url.pathname === "/api/source/file") {
        const kind = ["style", "brand"].includes(url.searchParams.get("kind") ?? "") ? "brand" : "context";
        const rel = safeRelPath(url.searchParams.get("path") ?? "");
        const file = join(kind === "brand" ? bridge.workspace.brandDir : bridge.workspace.contextDir, rel);
        if (!existsSync(file) || !statSync(file).isFile()) return json(res, 404, { error: "not found" });
        res.writeHead(200, {
          "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
          "access-control-allow-origin": "*",
          "cache-control": "no-store",
        });
        return res.end(readFileSync(file));
      }
      if (req.method === "POST" && url.pathname === "/api/sources/delete") {
        const body = await readBody(req);
        const kind = body.kind === "style" || body.kind === "brand" ? "brand" : "context";
        const rel = safeRelPath(String(body.path ?? ""));
        const file = join(kind === "brand" ? bridge.workspace.brandDir : bridge.workspace.contextDir, rel);
        if (!existsSync(file) || !statSync(file).isFile()) return json(res, 404, { error: "not found" });
        rmSync(file);
        bridge.broadcast({ type: "files_changed", project: bridge.project?.slug });
        return json(res, 200, { ok: true });
      }

      if (req.method === "POST" && url.pathname === "/api/meta") {
        const body = await readBody(req);
        const project = bridge.requireProject();
        const meta = project.updateMeta({
          ...(body.displayName !== undefined ? { displayName: String(body.displayName) } : {}),
          ...(body.series !== undefined ? { series: body.series === null ? null : String(body.series) } : {}),
          ...(body.settings ? { settings: body.settings } : {}),
        });
        sys("set_project_meta", project.slug);
        bridge.broadcast({ type: "files_changed", project: project.slug });
        bridge.broadcast({ type: "projects_changed" });
        return json(res, 200, { ok: true, meta });
      }

      if (req.method === "POST" && url.pathname === "/api/project/fork") {
        const body = await readBody(req);
        if (!body.slug) return json(res, 400, { error: "slug required" });
        const slug = await bridge.forkProject(String(body.slug), {
          round: body.round != null ? Number(body.round) : undefined,
          name: body.name ? String(body.name) : undefined,
        });
        sys("branch_project", `${body.slug}${body.round != null ? ` @ round ${body.round}` : ""} -> ${slug}`);
        if (body.open !== false) await bridge.openProject(slug);
        return json(res, 200, { ok: true, slug });
      }

      if (req.method === "POST" && url.pathname === "/api/series") {
        const body = await readBody(req);
        if (!body.slug || !body.rootName || !Array.isArray(body.topics)) {
          return json(res, 400, { error: "slug, rootName and topics[] required" });
        }
        const created = await bridge.createSeries(
          String(body.slug),
          String(body.rootName),
          body.topics.map(String),
          body.run !== false,
        );
        sys("create_series", `${body.rootName}: ${created.map((c: { slug: string }) => c.slug).join(", ")}`);
        return json(res, 200, { ok: true, created });
      }

      if (url.pathname === "/api/element/style") {
        const project = bridge.requireProject();
        if (req.method === "POST") {
          const body = await readBody(req);
          // batch = one gesture (multi-drag, align) → ONE undo snapshot for the set
          const entries = Array.isArray(body.batch) ? body.batch : body.pcId ? [body] : [];
          if (!entries.length) return json(res, 400, { error: "pcId or batch[] required" });
          snapshotPage(project);
          for (const e of entries) {
            setElementStyle(project, String(e.pcId), {
              translateX: e.translateX !== undefined ? Number(e.translateX) : undefined,
              translateY: e.translateY !== undefined ? Number(e.translateY) : undefined,
              marginTop: e.marginTop === null ? null : e.marginTop !== undefined ? Number(e.marginTop) : undefined,
            });
          }
          bridge.broadcast({ type: "files_changed", project: project.slug });
          return json(res, 200, { ok: true });
        }
        const pcId = url.searchParams.get("pcId");
        if (!pcId) return json(res, 400, { error: "pcId required" });
        return json(res, 200, getElementStyle(project, pcId));
      }

      if (req.method === "POST" && url.pathname === "/api/copy") {
        const body = await readBody(req);
        const project = bridge.requireProject();
        snapshotPage(project);
        updateCopy(project, body.pcId, body.text);
        bridge.broadcast({ type: "files_changed", project: project.slug });
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/variant") {
        const body = await readBody(req);
        const project = bridge.requireProject();
        snapshotPage(project);
        selectVariant(project, body.imageId, Number(body.variant));
        bridge.broadcast({ type: "files_changed", project: project.slug });
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/images/generate") {
        const body = await readBody(req);
        if (!body.imageId) return json(res, 400, { error: "imageId required" });
        const project = bridge.requireProject();
        const summaries = await generateImages(project, bridge.config, [body.imageId]);
        bridge.broadcast({ type: "files_changed", project: project.slug });
        return json(res, 200, { ok: true, generated: summaries[0]?.files.length ?? 0, errors: summaries[0]?.errors ?? [] });
      }
      if (req.method === "POST" && url.pathname === "/api/images/upload") {
        const body = await readBody(req);
        if (!body.imageId || !body.dataBase64) return json(res, 400, { error: "imageId and dataBase64 required" });
        const project = bridge.requireProject();
        const dir = join(project.imagesDir, String(body.imageId).replace(/[/\\]/g, ""));
        if (!existsSync(dir)) return json(res, 404, { error: `no such image slot: ${body.imageId}` });
        const nums = readdirSync(dir)
          .map((f) => /^v(\d+)\.png$/.exec(f)?.[1])
          .filter(Boolean)
          .map(Number);
        const next = nums.length ? Math.max(...nums) + 1 : 1;
        writeFileSync(join(dir, `v${next}.png`), Buffer.from(String(body.dataBase64), "base64"));
        selectVariant(project, body.imageId, next);
        bridge.broadcast({ type: "files_changed", project: project.slug });
        return json(res, 200, { ok: true, variant: next });
      }
      if (req.method === "POST" && url.pathname === "/api/images/style") {
        const body = await readBody(req);
        if (!body.imageId) return json(res, 400, { error: "imageId required" });
        const project = bridge.requireProject();
        snapshotPage(project);
        setImageStyle(project, body.imageId, { objectPosition: body.objectPosition, zoom: body.zoom });
        bridge.broadcast({ type: "files_changed", project: project.slug });
        return json(res, 200, { ok: true });
      }

      if (url.pathname === "/api/workspace") {
        if (req.method === "POST") {
          const body = await readBody(req);
          const root = body.useDefault ? DATA_ROOT : body.root;
          if (!root) return json(res, 400, { error: "root required" });
          await bridge.setWorkspace(root);
          return json(res, 200, { ok: true, root: bridge.workspace.root });
        }
        return json(res, 200, { root: bridge.workspace.root, projects: bridge.listProjects() });
      }

      if (url.pathname === "/api/setup") {
        if (req.method === "POST") {
          bridge.completeSetup();
          return json(res, 200, { ok: true });
        }
        return json(res, 200, bridge.setupState());
      }
      if (req.method === "POST" && url.pathname === "/api/keys") {
        const body = await readBody(req);
        const keys: Record<string, string> = {};
        for (const name of ["GEMINI_API_KEY", "MOONSHOT_API_KEY"] as const) {
          if (typeof body[name] === "string" && body[name].trim()) keys[name] = body[name];
        }
        if (!Object.keys(keys).length) return json(res, 400, { error: "no keys provided" });
        const saved = saveApiKeys(keys);
        // Idle sessions recreate so the new key is picked up by their model runtimes.
        await bridge.updateSettings({});
        return json(res, 200, { ok: true, saved });
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

      if (req.method === "POST" && url.pathname === "/api/variants/suggest") {
        const body = await readBody(req);
        const slug = body.slug ?? bridge.requireProject().slug;
        const project = new Project(slug, bridge.workspace);
        const directions = await suggestDirections(project, bridge.config, Math.min(Number(body.count ?? 3), 4));
        return json(res, 200, { directions });
      }
      if (req.method === "POST" && url.pathname === "/api/variants") {
        const body = await readBody(req);
        const slug = body.slug ?? bridge.requireProject().slug;
        if (!Array.isArray(body.directions) || !body.directions.length) {
          return json(res, 400, { error: "directions[] required" });
        }
        const created = await bridge.createVariants(slug, body.directions);
        sys("create_variants", `${slug} -> ${created.map((c: any) => c.slug).join(", ")}`);
        return json(res, 200, { created });
      }
      if (req.method === "POST" && url.pathname === "/api/run") {
        const body = await readBody(req);
        const state = await bridge.run(body.slug, body.prompt);
        sys("run_project", `${body.slug ?? bridge.project?.slug}: ${state}`);
        return json(res, 200, { ok: true, state });
      }
      if (req.method === "POST" && url.pathname === "/api/chat") {
        const body = await readBody(req);
        if (!body.text) return json(res, 400, { error: "text required" });
        await bridge.chat(body.text);
        sys("chat", String(body.text).slice(0, 120));
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/render") {
        await bridge.render();
        return json(res, 200, { ok: true });
      }



      if (req.method === "POST" && url.pathname === "/api/element/tag") {
        const body = await readBody(req);
        if (!body.path || !body.pcId) return json(res, 400, { error: "path and pcId required" });
        const project = bridge.requireProject();
        snapshotPage(project);
        tagElement(project, String(body.path), String(body.pcId));
        // No files_changed broadcast: the client already applied the attribute locally,
        // and a reload here would interrupt the edit the user is about to make.
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/element/delete") {
        const body = await readBody(req);
        if (!body.pcId) return json(res, 400, { error: "pcId required" });
        const project = bridge.requireProject();
        snapshotPage(project);
        deleteElement(project, String(body.pcId));
        sys("delete_element", `${project.slug}: ${body.pcId}`);
        bridge.broadcast({ type: "files_changed", project: project.slug });
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/element/move") {
        const body = await readBody(req);
        if (!body.pcId) return json(res, 400, { error: "pcId required" });
        const project = bridge.requireProject();
        snapshotPage(project);
        if (body.beforePcId) moveElementBefore(project, String(body.pcId), String(body.beforePcId), body.after === true);
        else if (body.direction === "up" || body.direction === "down") moveElement(project, String(body.pcId), body.direction);
        else return json(res, 400, { error: "direction or beforePcId required" });
        bridge.broadcast({ type: "files_changed", project: project.slug });
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/page/undo") {
        const project = bridge.requireProject();
        const depth = undoPage(project);
        sys("undo", `${project.slug} (${depth.undo} left)`);
        bridge.broadcast({ type: "files_changed", project: project.slug });
        return json(res, 200, { ok: true, ...depth });
      }
      if (req.method === "POST" && url.pathname === "/api/page/redo") {
        const project = bridge.requireProject();
        const depth = redoPage(project);
        sys("redo", `${project.slug} (${depth.redo} left)`);
        bridge.broadcast({ type: "files_changed", project: project.slug });
        return json(res, 200, { ok: true, ...depth });
      }
      if (url.pathname === "/api/page/source") {
        const project = bridge.requireProject();
        if (req.method === "POST") {
          const body = await readBody(req);
          snapshotPage(project);
          writePageSource(project, String(body.content ?? ""));
          sys("edit_source", `${project.slug}: page.html (${String(body.content ?? "").length} chars)`);
          bridge.broadcast({ type: "files_changed", project: project.slug });
          return json(res, 200, { ok: true });
        }
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "access-control-allow-origin": "*", "cache-control": "no-store" });
        return res.end(pageSource(project));
      }

      if (url.pathname === "/api/system") {
        return json(res, 200, { events: bridge.systemEvents() });
      }
      if (url.pathname === "/api/git/status") {
        return json(res, 200, await gitStatus(bridge.workspace.root));
      }
      if (req.method === "POST" && url.pathname === "/api/git/connect") {
        const body = await readBody(req);
        if (!body.url) return json(res, 400, { error: "url required" });
        const status = await gitConnect(bridge.workspace.root, String(body.url));
        sys("git_connect", String(body.url));
        return json(res, 200, { ok: true, status });
      }
      if (req.method === "POST" && url.pathname === "/api/git/sync") {
        const body = await readBody(req);
        const result = await gitSync(bridge.workspace.root, body.message ? String(body.message) : undefined);
        sys("git_sync", result.summary);
        bridge.broadcast({ type: "files_changed", project: bridge.project?.slug });
        return json(res, 200, { ok: true, ...result });
      }
      if (req.method === "POST" && url.pathname === "/api/git/clone") {
        const body = await readBody(req);
        if (!body.url || !body.dest) return json(res, 400, { error: "url and dest required" });
        await gitClone(String(body.url), String(body.dest));
        await bridge.setWorkspace(String(body.dest));
        sys("git_clone", `${body.url} -> ${body.dest}`);
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
    `Blueline bridge — workspace=${bridge.workspace.root} project=${bridge.project?.slug ?? "(none)"} http://localhost:${port}`,
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
