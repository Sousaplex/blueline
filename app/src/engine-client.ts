// EngineClient is the ONLY seam between the renderer and the engine.
// Browser mode: HTTP + WebSocket against the toolkit bridge (vite-proxied).
// Electron mode (M3): an IPC-backed implementation with the same interface.

export interface ReviewIssue {
  page: number;
  region: string;
  problem: string;
  fix: string;
}

export interface RoundInfo {
  round: number;
  verdict: "pass" | "revise" | "edit";
  issues: ReviewIssue[];
  notes?: string;
  hasProof: boolean;
  hasHtml: boolean; // archived page state exists — the round can be branched
}

export interface PageSettings {
  pageSize: string;
  orientation: "portrait" | "landscape";
  pages: number;
  autoPages?: boolean; // let content decide the page count — reviewer skips the count gate
  widthMm: number | null;
  heightMm: number | null;
  docType?: string;
}

export interface ProjectMeta {
  id: string; // stable unique document id (folder name: readable slug + random suffix)
  displayName: string;
  series: string | null;
  kind: "document" | "variant";
  parent: string | null;
  forkedFromRound: number | null;
  template: string | null;
  settings: PageSettings;
}

export interface TemplateInfo {
  slug: string;
  name: string;
  description: string;
  settings: PageSettings;
  sourceProject: string | null;
  createdAt: string;
}

export type SourceKind = "text" | "image" | "pdf" | "other";

export interface ContextFile {
  path: string;
  name: string; // same as path (legacy field)
  kind: SourceKind;
  size: number;
  selected: boolean;
}

export interface BrandFile {
  path: string;
  kind: SourceKind;
  size: number;
}

export interface ElementNudge {
  translateX: number;
  translateY: number;
  marginTop: number | null;
}

export interface ImageSlot {
  id: string;
  variants: number[];
  current: number | null;
}

export interface ProjectState {
  workspaceRoot: string;
  slug: string | null;
  meta: ProjectMeta | null;
  /** Resolved artboard size in mm (orientation applied) — null when no project. */
  artboard: { w: number; h: number } | null;
  history: { undo: number; redo: number };
  brief: string;
  contextFiles: ContextFile[];
  brandFiles: BrandFile[];
  rounds: RoundInfo[];
  images: ImageSlot[];
  editable: { pcId: string; text: string }[];
  hasPage: boolean;
  hasProof: boolean;
  running: boolean;
  runState: RunState;
  runStates: Record<string, RunState>;
  designerModel: string;
}

export interface EngineSettings {
  config: {
    designer: { provider: string; model: string; thinkingLevel?: string; apiKeyEnv?: string };
    reviewer: { provider: string; model: string; maxRounds: number; apiKeyEnv?: string };
    images: { provider: string; model: string; variantsPerPrompt: number; apiKeyEnv?: string };
    runs?: { maxConcurrent: number };
  };
  registry: { id: string; models: string[] }[];
  suggestions: { reviewer: string[]; images: string[] };
  /** Live from the Google API — the models this key can actually use (or the error explaining why not). */
  available?: { generate: string[]; image: string[]; error?: string };
}

export type SettingsPatch = {
  designer?: Partial<EngineSettings["config"]["designer"]>;
  reviewer?: Partial<EngineSettings["config"]["reviewer"]>;
  images?: Partial<EngineSettings["config"]["images"]>;
  runs?: { maxConcurrent: number };
};

export type RunState = "idle" | "queued" | "running";

/** Image geometry edits. img-level: objectPosition (pan) + zoom (scale within crop).
 *  frame-level: width/height (resize the box) + translate (move it on the page). */
/** Compiled image geometry (see docs/layer-model.md): the crop FRAME + the inner photo LAYER. */
export interface ImageGeometry {
  frame?: { leftMm: number; topMm: number; widthMm: number; heightMm: number };
  layer?: { widthMm: number; leftMm: number; topMm: number };
}

export interface SystemEvent {
  type: "system";
  source: string; // "app" | "mcp" | custom client tag
  action: string;
  detail: string;
  at: number;
}

export interface GitStatus {
  isRepo: boolean;
  remote: string | null;
  branch: string | null;
  dirty: number;
  ahead: number;
  behind: number;
}

export interface DocConflict {
  docId: string;
  displayName: string;
  files: string[];
}
export interface SyncResult {
  pulled: boolean;
  committed: boolean;
  pushed: boolean;
  summary: string;
  conflicts?: DocConflict[];
}
export interface ResolveResult {
  pushed: boolean;
  forked: { fromDocId: string; newDocId: string; displayName: string }[];
  summary: string;
}

export interface SetupState {
  fresh: boolean;
  workspaceRoot: string;
  defaultWorkspaceRoot: string;
  keys: { GEMINI_API_KEY: boolean; MOONSHOT_API_KEY: boolean };
  designer: string;
}

/** Live context-window usage of a project's Pi session. tokens/percent are null right after
 *  a compaction (before the next model response re-establishes the count). */
export interface ContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export interface SessionStats {
  totalMessages: number;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost: number;
  contextUsage?: ContextUsage;
}

export interface ArchiveImportResult {
  kind: "document" | "project";
  imported: { slug: string; displayName: string }[];
  open: string;
  notes: string[];
}

export type EngineEvent =
  | { type: "hello"; project: string | null; runStates: Record<string, RunState>; replay: EngineEvent[] }
  | { type: "text_delta"; project?: string; delta: string }
  | { type: "context_usage"; project?: string; tokens: number | null; contextWindow: number; percent: number | null }
  | { type: "chat"; project?: string; text: string }
  | { type: "tool_start"; project?: string; tool: string; args: Record<string, unknown> }
  | { type: "tool_end"; project?: string; tool: string; summary: string }
  | { type: "run_state"; project: string; state: RunState }
  | { type: "run_cost"; project: string; designer: number; images: number; imageCount: number; review: number; search: number; total: number }
  | { type: "files_changed"; project?: string }
  | { type: "settings_changed" }
  | { type: "project_changed"; slug: string | null }
  | { type: "workspace_changed"; root: string; slug: string | null }
  | { type: "projects_changed" }
  | { type: "setup_changed" }
  | SystemEvent
  | { type: "error"; project?: string; message: string };

export interface ProjectListing {
  dir: string;
  slug: string;
  hasBrief: boolean;
  current: boolean;
  rounds: number;
  lastVerdict: "pass" | "revise" | "edit" | null;
  hasProof: boolean;
  runState: RunState;
  meta: ProjectMeta;
}

/** Injected by the Electron preload script; absent in browser mode. */
declare global {
  interface Window {
    blueline?: {
      exportPdf(): Promise<string | null>;
      saveTextFile(defaultName: string, content: string): Promise<string | null>;
      saveBinaryFile(defaultName: string, base64: string): Promise<string | null>;
      openArchiveFile(): Promise<{ name: string; base64: string } | null>;
      chooseDirectory(): Promise<string | null>;
      revealInFinder(path: string): Promise<void>;
      openPath(path: string): Promise<void>;
      setApiKeys(keys: Record<string, string>): Promise<string[]>;
      keychainAvailable(): Promise<boolean>;
      downloadUpdate(): Promise<void>;
      installUpdate(): Promise<void>;
      onUpdateAvailable(cb: (version: string) => void): () => void;
      onUpdateProgress(cb: (percent: number) => void): () => void;
      onUpdateDownloaded(cb: (version: string) => void): () => void;
      onUpdateError(cb: (message: string) => void): () => void;
      isElectron: true;
    };
  }
}

export interface EngineClient {
  getProject(): Promise<ProjectState>;
  listProjects(): Promise<ProjectListing[]>;
  openProject(projectDir: string): Promise<void>;
  createProject(name: string, brief?: string, template?: string, settings?: Partial<PageSettings>): Promise<void>;
  listTemplates(): Promise<TemplateInfo[]>;
  /** Freeze a project's current design as a workspace template. */
  saveTemplate(slug: string, name: string, description?: string): Promise<void>;
  deleteTemplate(slug: string): Promise<void>;
  closeProject(): Promise<void>;
  deleteProject(slug: string): Promise<void>;
  updateBrief(content: string): Promise<void>;
  /** AI-draft structured brief fields from a rough idea (mustInclude joined with newlines). */
  draftBrief(idea: string, format?: string): Promise<{ title: string; audience: string; goal: string; messages: string[]; mustInclude: string; tone: string }>;
  suggestVariants(slug: string, count: number): Promise<{ label: string; direction: string }[]>;
  createVariants(slug: string, directions: { label: string; direction: string }[]): Promise<void>;
  selectSources(files: string[] | null): Promise<void>;
  /** name may include a relative folder path ("photos/team.jpg") — folders are created. */
  uploadSource(kind: "context" | "brand", name: string, dataBase64: string): Promise<void>;
  deleteSource(kind: "context" | "brand", path: string): Promise<void>;
  sourceFileUrl(kind: "context" | "brand", path: string, cacheKey: number): string;
  updateMeta(patch: { displayName?: string; series?: string | null; settings?: Partial<PageSettings> }): Promise<void>;
  /** Branch a project; round-specific when round is given. Opens the new project. */
  forkProject(slug: string, round?: number, name?: string): Promise<string>;
  createSeries(slug: string, rootName: string, topics: string[], run: boolean): Promise<{ slug: string; state: RunState }[]>;
  setElementStyle(pcId: string, style: { translateX?: number; translateY?: number; marginTop?: number | null }): Promise<void>;
  /** One gesture, one undo step: apply several elements' styles atomically. */
  setElementStyles(batch: { pcId: string; translateX?: number; translateY?: number; marginTop?: number | null }[]): Promise<void>;
  getElementStyle(pcId: string): Promise<ElementNudge>;
  /** Assign a data-pc-id to an untagged element (path = strict body>nth-child chain). */
  tagElement(path: string, pcId: string): Promise<void>;
  deleteElement(pcId: string): Promise<void>;
  insertElement(kind: "text" | "heading" | "rect" | "divider"): Promise<{ id: string }>;
  moveElement(pcId: string, direction: "up" | "down"): Promise<void>;
  moveElementBefore(pcId: string, beforePcId: string, after?: boolean): Promise<void>;
  getPageSource(): Promise<string>;
  savePageSource(content: string): Promise<void>;
  undoPage(): Promise<{ changed: string[] }>;
  redoPage(): Promise<{ changed: string[] }>;
  /** System-tab replay: recent API/MCP-triggered actions. */
  getSystemEvents(): Promise<SystemEvent[]>;
  /** Live token/context-window stats for a project's session (null if not currently loaded). */
  getSessionStats(slug: string): Promise<{ stats: SessionStats | null; contextUsage: ContextUsage | null }>;
  /** Export the project's full Pi conversation (all threads). Saves to disk in Electron
   *  (returns the path), or triggers a browser download (returns null path). */
  exportSession(slug: string, format: "json" | "jsonl"): Promise<{ path: string | null }>;
  /** Export a portable archive: kind=file (.blueline, one document) or kind=project
   *  (.blueproject, the whole family + shared assets). Electron saves + returns the path. */
  exportArchive(slug: string, kind: "file" | "project"): Promise<{ path: string | null; filename: string }>;
  /** Import a .blueline/.blueproject archive (base64). Returns what was imported + which to open. */
  importArchive(base64: string): Promise<ArchiveImportResult>;
  gitStatus(): Promise<GitStatus>;
  gitConnect(url: string): Promise<GitStatus>;
  gitDisconnect(wipeHistory?: boolean): Promise<GitStatus>;
  gitSync(message?: string): Promise<SyncResult>;
  /** Resolve an in-progress merge conflict, per document: keep mine / keep theirs / fork (keep both). */
  resolveConflicts(resolutions: { docId: string; choice: "mine" | "theirs" | "fork" }[]): Promise<ResolveResult>;
  /** DESTRUCTIVE escape hatch: force one side to win. push = remote←local, pull = local←remote. */
  forceOverwrite(direction: "push" | "pull"): Promise<{ summary: string }>;
  gitClone(url: string, dest: string): Promise<void>;
  /** Pick a workspace dir (native dialog in Electron, path prompt in browser) and switch to it. */
  chooseWorkspace(): Promise<boolean>;
  /** First-run state: whether onboarding should run, which API keys exist (booleans only). */
  getSetup(): Promise<SetupState>;
  /** Mark onboarding finished (persists the current workspace). */
  completeSetup(): Promise<void>;
  /** Store API keys in the engine's .env — applied live, no relaunch. */
  saveKeys(keys: { GEMINI_API_KEY?: string; MOONSHOT_API_KEY?: string }): Promise<void>;
  /** Use the app-managed default workspace location. */
  useDefaultWorkspace(): Promise<void>;
  /** Returns the saved path (Electron printToPDF) or null (browser fallback opened the proof). */
  exportPdf(): Promise<string | null>;
  /** Export the rendered proof as an image (png/jpeg). Electron saves + returns the path. */
  exportImage(format: "png" | "jpeg"): Promise<{ path: string | null; filename: string }>;
  getSettings(): Promise<EngineSettings>;
  /** Live model list from Google (fetched separately so Settings opens instantly). */
  listModels(): Promise<{ generate: string[]; image: string[]; error?: string }>;
  /** Support dump: version, configured models, key presence, live model list (or its error), recent events. */
  diagnostics(): Promise<Record<string, unknown>>;
  updateSettings(patch: SettingsPatch): Promise<void>;
  run(slug?: string, prompt?: string): Promise<void>;
  cancelRun(slug?: string): Promise<void>;
  chat(text: string): Promise<void>;
  getFeed(slug: string): Promise<EngineEvent[]>;
  render(): Promise<void>;
  updateCopy(pcId: string, text: string): Promise<void>;
  selectVariant(imageId: string, variant: number): Promise<void>;
  generateMoreImages(imageId: string): Promise<void>;
  uploadImageVariant(imageId: string, dataBase64: string): Promise<void>;
  setImageGeometry(imageId: string, geom: ImageGeometry): Promise<void>;
  /** Delete an image (its whole slot/frame/img block). */
  deleteImage(imageId: string): Promise<void>;
  /** Set whitelisted inline style props (font/color/weight/align/background/border/width…). */
  setElementProps(pcId: string, props: Record<string, string>): Promise<void>;
  proofMeta(round?: number): Promise<{ pages: number }>;
  proofPageUrl(index: number, cacheKey: number, round?: number): string;
  fileUrl(rel: string, cacheKey: number): string;
  subscribe(listener: (event: EngineEvent) => void): () => void;
}

/** Base64-encode bytes in chunks (String.fromCharCode(...bigArray) overflows the stack). */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function post(path: string, body?: unknown): Promise<void> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({})) as any).error ?? `${path}: HTTP ${res.status}`);
}

export class BrowserEngineClient implements EngineClient {
  private listeners = new Set<(event: EngineEvent) => void>();
  private ws?: WebSocket;
  private closed = false;

  constructor() {
    this.connect();
  }

  private connect(): void {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    this.ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws.onmessage = (msg) => {
      this.emit(JSON.parse(msg.data) as EngineEvent);
    };
    this.ws.onclose = () => {
      if (!this.closed) setTimeout(() => this.connect(), 2000);
    };
  }

  private emit(event: EngineEvent): void {
    for (const l of this.listeners) l(event);
  }

  subscribe(listener: (event: EngineEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async getProject(): Promise<ProjectState> {
    const res = await fetch("/api/project");
    if (!res.ok) throw new Error(`bridge unreachable (HTTP ${res.status}) — is \`npm run serve\` running in toolkit/?`);
    return res.json();
  }

  async getSettings(): Promise<EngineSettings> {
    const res = await fetch("/api/settings");
    if (!res.ok) throw new Error(`settings: HTTP ${res.status}`);
    return res.json();
  }

  async listModels(): Promise<{ generate: string[]; image: string[]; error?: string }> {
    const res = await fetch("/api/models");
    if (!res.ok) throw new Error(`models: HTTP ${res.status}`);
    return res.json();
  }

  async diagnostics(): Promise<Record<string, unknown>> {
    const res = await fetch("/api/diagnostics");
    if (!res.ok) throw new Error(`diagnostics: HTTP ${res.status}`);
    return res.json();
  }

  async listProjects(): Promise<ProjectListing[]> {
    const res = await fetch("/api/projects");
    return (await res.json()).projects;
  }

  openProject(projectDir: string) { return post("/api/open", { projectDir }); }

  createProject(name: string, brief?: string, template?: string, settings?: Partial<PageSettings>) {
    return post("/api/project/new", { name, brief, template, meta: settings ? { settings } : undefined });
  }
  async listTemplates(): Promise<TemplateInfo[]> {
    const res = await fetch("/api/templates");
    return (await res.json()).templates ?? [];
  }
  saveTemplate(slug: string, name: string, description?: string) { return post("/api/templates", { slug, name, description }); }
  deleteTemplate(slug: string) { return post("/api/templates/delete", { slug }); }
  closeProject() { return post("/api/project/close"); }
  deleteProject(slug: string) { return post("/api/project/delete", { slug }); }
  updateBrief(content: string) { return post("/api/brief", { content }); }
  async draftBrief(idea: string, format?: string) {
    const res = await fetch("/api/brief/draft", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idea, format }),
    });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error ?? `draft: HTTP ${res.status}`);
    const f = payload.fields;
    return { ...f, mustInclude: (f.mustInclude ?? []).join("\n") };
  }

  async suggestVariants(slug: string, count: number): Promise<{ label: string; direction: string }[]> {
    const res = await fetch("/api/variants/suggest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug, count }),
    });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error ?? `suggest: HTTP ${res.status}`);
    return payload.directions;
  }

  createVariants(slug: string, directions: { label: string; direction: string }[]) {
    return post("/api/variants", { slug, directions });
  }
  selectSources(files: string[] | null) { return post("/api/sources/select", { files }); }
  uploadSource(kind: "context" | "brand", name: string, dataBase64: string) {
    return post("/api/sources/upload", { kind, name, dataBase64 });
  }
  deleteSource(kind: "context" | "brand", path: string) { return post("/api/sources/delete", { kind, path }); }
  sourceFileUrl(kind: "context" | "brand", path: string, cacheKey: number): string {
    return `/api/source/file?kind=${kind}&path=${encodeURIComponent(path)}&k=${cacheKey}`;
  }
  updateMeta(patch: { displayName?: string; series?: string | null; settings?: Partial<PageSettings> }) {
    return post("/api/meta", patch);
  }

  async forkProject(slug: string, round?: number, name?: string): Promise<string> {
    const res = await fetch("/api/project/fork", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug, round, name }),
    });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error ?? `fork: HTTP ${res.status}`);
    return payload.slug;
  }

  async createSeries(slug: string, rootName: string, topics: string[], run: boolean) {
    const res = await fetch("/api/series", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug, rootName, topics, run }),
    });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error ?? `series: HTTP ${res.status}`);
    return payload.created;
  }

  setElementStyle(pcId: string, style: { translateX?: number; translateY?: number; marginTop?: number | null }) {
    return post("/api/element/style", { pcId, ...style });
  }
  setElementStyles(batch: { pcId: string; translateX?: number; translateY?: number; marginTop?: number | null }[]) {
    return post("/api/element/style", { batch });
  }

  async getElementStyle(pcId: string): Promise<ElementNudge> {
    const res = await fetch(`/api/element/style?pcId=${encodeURIComponent(pcId)}`);
    if (!res.ok) throw new Error(`element style: HTTP ${res.status}`);
    return res.json();
  }

  async getSetup(): Promise<SetupState> {
    const res = await fetch("/api/setup");
    if (!res.ok) throw new Error(`setup: HTTP ${res.status}`);
    return res.json();
  }
  completeSetup() { return post("/api/setup"); }
  async saveKeys(keys: { GEMINI_API_KEY?: string; MOONSHOT_API_KEY?: string }) {
    // In the packaged app, route through Electron so keys land in the OS keychain
    // (encrypted, in app-data) instead of a plaintext .env. Browser/dev falls back
    // to the bridge's .env path.
    const bridge = window.blueline;
    if (bridge?.setApiKeys) {
      await bridge.setApiKeys(keys as Record<string, string>);
      return;
    }
    await post("/api/keys", keys);
  }
  useDefaultWorkspace() { return post("/api/workspace", { useDefault: true }); }

  async chooseWorkspace(): Promise<boolean> {
    const root = window.blueline
      ? await window.blueline.chooseDirectory()
      : window.prompt("Workspace folder (absolute path):");
    if (!root) return false;
    await post("/api/workspace", { root });
    return true;
  }

  async exportPdf(): Promise<string | null> {
    if (window.blueline) return window.blueline.exportPdf();
    window.open("/files/out/proof.pdf", "_blank"); // browser fallback: latest proof
    return null;
  }

  async exportImage(format: "png" | "jpeg"): Promise<{ path: string | null; filename: string }> {
    const res = await fetch(`/api/export/image?format=${format}`);
    if (!res.ok) throw new Error((await res.json().catch(() => ({})) as any).error ?? `export ${format}: HTTP ${res.status}`);
    const disposition = res.headers.get("content-disposition") ?? "";
    const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? `export.${format}`;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (window.blueline?.saveBinaryFile) {
      return { path: await window.blueline.saveBinaryFile(filename, bytesToBase64(buf)), filename };
    }
    const blob = new Blob([buf], { type: res.headers.get("content-type") ?? "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    return { path: null, filename };
  }

  updateSettings(patch: SettingsPatch) { return post("/api/settings", patch); }
  run(slug?: string, prompt?: string) { return post("/api/run", { slug, prompt }); }
  cancelRun(slug?: string) { return post("/api/run/cancel", { slug }); }
  chat(text: string) { return post("/api/chat", { text }); }

  async getFeed(slug: string): Promise<EngineEvent[]> {
    const res = await fetch(`/api/feed?slug=${encodeURIComponent(slug)}`);
    return (await res.json()).feed ?? [];
  }
  render() { return post("/api/render"); }
  updateCopy(pcId: string, text: string) { return post("/api/copy", { pcId, text }); }
  selectVariant(imageId: string, variant: number) { return post("/api/variant", { imageId, variant }); }
  generateMoreImages(imageId: string) { return post("/api/images/generate", { imageId }); }
  uploadImageVariant(imageId: string, dataBase64: string) { return post("/api/images/upload", { imageId, dataBase64 }); }
  setImageGeometry(imageId: string, geom: ImageGeometry) {
    return post("/api/images/geometry", { imageId, ...geom });
  }
  deleteImage(imageId: string) {
    return post("/api/images/delete", { imageId });
  }
  setElementProps(pcId: string, props: Record<string, string>) {
    return post("/api/element/props", { pcId, props });
  }

  tagElement(path: string, pcId: string) { return post("/api/element/tag", { path, pcId }); }
  deleteElement(pcId: string) { return post("/api/element/delete", { pcId }); }
  async insertElement(kind: "text" | "heading" | "rect" | "divider"): Promise<{ id: string }> {
    const res = await fetch("/api/element/insert", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind }) });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error ?? "insert failed");
    return { id: payload.id };
  }
  moveElement(pcId: string, direction: "up" | "down") { return post("/api/element/move", { pcId, direction }); }
  moveElementBefore(pcId: string, beforePcId: string, after?: boolean) {
    return post("/api/element/move", { pcId, beforePcId, after });
  }
  async getPageSource(): Promise<string> {
    const res = await fetch("/api/page/source");
    if (!res.ok) throw new Error(`source: HTTP ${res.status}`);
    return res.text();
  }
  savePageSource(content: string) { return post("/api/page/source", { content }); }
  async undoPage(): Promise<{ changed: string[] }> {
    const res = await fetch("/api/page/undo", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error ?? "undo failed");
    return { changed: payload.changed ?? [] };
  }
  async redoPage(): Promise<{ changed: string[] }> {
    const res = await fetch("/api/page/redo", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error ?? "redo failed");
    return { changed: payload.changed ?? [] };
  }

  async getSystemEvents(): Promise<SystemEvent[]> {
    const res = await fetch("/api/system");
    return (await res.json()).events ?? [];
  }

  async getSessionStats(slug: string): Promise<{ stats: SessionStats | null; contextUsage: ContextUsage | null }> {
    const res = await fetch(`/api/session/stats?slug=${encodeURIComponent(slug)}`);
    if (!res.ok) return { stats: null, contextUsage: null };
    return res.json();
  }

  async exportSession(slug: string, format: "json" | "jsonl"): Promise<{ path: string | null }> {
    const res = await fetch(`/api/session/export?slug=${encodeURIComponent(slug)}&format=${format}`);
    if (!res.ok) throw new Error((await res.json().catch(() => ({})) as any).error ?? `export: HTTP ${res.status}`);
    const content = await res.text();
    const name = `blueline-session-${slug}.${format}`;
    // Electron: native Save dialog → real file the user can hand off. Browser: blob download.
    if (window.blueline?.saveTextFile) {
      const path = await window.blueline.saveTextFile(name, content);
      return { path };
    }
    const blob = new Blob([content], { type: format === "json" ? "application/json" : "application/x-ndjson" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    return { path: null };
  }

  async exportArchive(slug: string, kind: "file" | "project"): Promise<{ path: string | null; filename: string }> {
    const res = await fetch(`/api/project/export?slug=${encodeURIComponent(slug)}&kind=${kind}`);
    if (!res.ok) throw new Error((await res.json().catch(() => ({})) as any).error ?? `export: HTTP ${res.status}`);
    const disposition = res.headers.get("content-disposition") ?? "";
    const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? `export.${kind === "project" ? "blueproject" : "blueline"}`;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (window.blueline?.saveBinaryFile) {
      const path = await window.blueline.saveBinaryFile(filename, bytesToBase64(buf));
      return { path, filename };
    }
    const blob = new Blob([buf], { type: "application/zip" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    return { path: null, filename };
  }

  async importArchive(base64: string): Promise<ArchiveImportResult> {
    const res = await fetch("/api/project/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dataBase64: base64 }),
    });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error ?? `import: HTTP ${res.status}`);
    return payload;
  }

  async gitStatus(): Promise<GitStatus> {
    const res = await fetch("/api/git/status");
    if (!res.ok) throw new Error(`git status: HTTP ${res.status}`);
    return res.json();
  }

  async gitConnect(url: string): Promise<GitStatus> {
    const res = await fetch("/api/git/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error ?? `git connect: HTTP ${res.status}`);
    return payload.status;
  }
  async gitDisconnect(wipeHistory?: boolean): Promise<GitStatus> {
    const res = await fetch("/api/git/disconnect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wipeHistory: !!wipeHistory }),
    });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error ?? `git disconnect: HTTP ${res.status}`);
    return payload.status;
  }

  async gitSync(message?: string): Promise<SyncResult> {
    const res = await fetch("/api/git/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message }),
    });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error ?? `git sync: HTTP ${res.status}`);
    return payload;
  }

  async resolveConflicts(resolutions: { docId: string; choice: "mine" | "theirs" | "fork" }[]): Promise<ResolveResult> {
    const res = await fetch("/api/git/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resolutions }),
    });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error ?? `resolve: HTTP ${res.status}`);
    return payload;
  }

  async forceOverwrite(direction: "push" | "pull"): Promise<{ summary: string }> {
    const res = await fetch("/api/git/overwrite", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ direction }),
    });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error ?? `overwrite: HTTP ${res.status}`);
    return payload;
  }

  gitClone(url: string, dest: string) { return post("/api/git/clone", { url, dest }); }

  async proofMeta(round?: number): Promise<{ pages: number }> {
    const res = await fetch(`/api/proof/meta${round != null ? `?round=${round}` : ""}`);
    return res.json();
  }

  proofPageUrl(index: number, cacheKey: number, round?: number): string {
    return `/api/proof/page/${index}?k=${cacheKey}${round != null ? `&round=${round}` : ""}`;
  }

  fileUrl(rel: string, cacheKey: number): string {
    return `/files/${rel}?k=${cacheKey}`;
  }
}
