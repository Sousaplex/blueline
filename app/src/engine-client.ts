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
  verdict: "pass" | "revise";
  issues: ReviewIssue[];
  notes?: string;
  hasProof: boolean;
}

export interface ImageSlot {
  id: string;
  variants: number[];
  current: number | null;
}

export interface ProjectState {
  slug: string;
  brief: string;
  contextFiles: string[];
  styleFiles: string[];
  rounds: RoundInfo[];
  images: ImageSlot[];
  editable: { pcId: string; text: string }[];
  hasPage: boolean;
  hasProof: boolean;
  running: boolean;
  designerModel: string;
}

export interface EngineSettings {
  config: {
    designer: { provider: string; model: string; thinkingLevel?: string; apiKeyEnv?: string };
    reviewer: { provider: string; model: string; maxRounds: number; apiKeyEnv?: string };
    images: { provider: string; model: string; variantsPerPrompt: number; apiKeyEnv?: string };
  };
  registry: { id: string; models: string[] }[];
  suggestions: { reviewer: string[]; images: string[] };
}

export type SettingsPatch = {
  designer?: Partial<EngineSettings["config"]["designer"]>;
  reviewer?: Partial<EngineSettings["config"]["reviewer"]>;
  images?: Partial<EngineSettings["config"]["images"]>;
};

export type EngineEvent =
  | { type: "hello"; running: boolean; replay: EngineEvent[] }
  | { type: "text_delta"; delta: string }
  | { type: "tool_start"; tool: string; args: Record<string, unknown> }
  | { type: "tool_end"; tool: string; summary: string }
  | { type: "status"; running: boolean }
  | { type: "files_changed" }
  | { type: "settings_changed" }
  | { type: "error"; message: string };

export interface EngineClient {
  getProject(): Promise<ProjectState>;
  getSettings(): Promise<EngineSettings>;
  updateSettings(patch: SettingsPatch): Promise<void>;
  run(prompt?: string): Promise<void>;
  chat(text: string): Promise<void>;
  render(): Promise<void>;
  updateCopy(pcId: string, text: string): Promise<void>;
  selectVariant(imageId: string, variant: number): Promise<void>;
  proofMeta(round?: number): Promise<{ pages: number }>;
  proofPageUrl(index: number, cacheKey: number, round?: number): string;
  fileUrl(rel: string, cacheKey: number): string;
  subscribe(listener: (event: EngineEvent) => void): () => void;
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
      const event = JSON.parse(msg.data) as EngineEvent;
      if (event.type === "hello") {
        for (const replayed of event.replay) this.emit(replayed);
        this.emit({ type: "status", running: event.running });
        return;
      }
      this.emit(event);
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

  updateSettings(patch: SettingsPatch) { return post("/api/settings", patch); }
  run(prompt?: string) { return post("/api/run", { prompt }); }
  chat(text: string) { return post("/api/chat", { text }); }
  render() { return post("/api/render"); }
  updateCopy(pcId: string, text: string) { return post("/api/copy", { pcId, text }); }
  selectVariant(imageId: string, variant: number) { return post("/api/variant", { imageId, variant }); }

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
