// Engine bridge: HTTP + WebSocket server the viewer talks to in browser mode.
// In M3 the Electron main process replaces this transport with IPC — the wire
// contract here is the EngineClient interface on the renderer side.
//
// Usage: npm run serve -- projects/<slug> [--port 7717]
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { REPO_ROOT, loadConfig } from "./config.ts";
import { listEditable, listImageSlots, selectVariant, updateCopy } from "./page-edit.ts";
import { Project } from "./project.ts";
import { createPresscheckSession, type PresscheckSession } from "./session.ts";
import { resetFetchBudget } from "./web-fetch.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".css": "text/css",
  ".json": "application/json",
  ".pdf": "application/pdf",
};

interface WireEvent {
  type: string;
  [k: string]: unknown;
}

class Bridge {
  private pc?: PresscheckSession;
  private running = false;
  private buffer: WireEvent[] = [];
  private sockets = new Set<WebSocket>();
  private proofCache?: { mtime: number; pages: Buffer[] };

  constructor(
    readonly project: Project,
    readonly config = loadConfig(),
  ) {}

  broadcast(event: WireEvent): void {
    this.buffer.push(event);
    if (this.buffer.length > 500) this.buffer.splice(0, this.buffer.length - 500);
    const msg = JSON.stringify(event);
    for (const ws of this.sockets) if (ws.readyState === ws.OPEN) ws.send(msg);
  }

  attach(ws: WebSocket): void {
    this.sockets.add(ws);
    ws.send(JSON.stringify({ type: "hello", running: this.running, replay: this.buffer.slice(-200) }));
    ws.on("close", () => this.sockets.delete(ws));
  }

  private async ensureSession(): Promise<PresscheckSession> {
    if (!this.pc) {
      this.pc = await createPresscheckSession({ projectDir: this.project.dir });
      this.pc.session.subscribe((event: any) => {
        switch (event.type) {
          case "message_update": {
            const e = event.assistantMessageEvent;
            if (e?.type === "text_delta") this.broadcast({ type: "text_delta", delta: e.delta });
            break;
          }
          case "tool_execution_start":
            this.broadcast({ type: "tool_start", tool: event.toolName ?? event.name, args: event.args ?? {} });
            break;
          case "tool_execution_end": {
            const summary = event.result?.content?.find((c: any) => c.type === "text")?.text ?? "";
            this.broadcast({ type: "tool_end", tool: event.toolName ?? event.name, summary: summary.slice(0, 2000) });
            this.broadcast({ type: "files_changed" });
            break;
          }
          case "agent_start":
            this.running = true;
            this.broadcast({ type: "status", running: true });
            break;
          case "agent_end":
            this.running = false;
            this.broadcast({ type: "status", running: false });
            break;
        }
      });
    }
    return this.pc;
  }

  async run(kickoff?: string): Promise<void> {
    if (this.running) throw new Error("Agent is already running");
    const pc = await this.ensureSession();
    resetFetchBudget(this.project);
    const prompt =
      kickoff ??
      "Produce the deliverable for this project. Start by reading brief.md, then follow your loop until the reviewer passes the piece or the round limit is hit.";
    void pc.session.prompt(prompt).catch((err) => {
      this.running = false;
      this.broadcast({ type: "error", message: err instanceof Error ? err.message : String(err) });
      this.broadcast({ type: "status", running: false });
    });
  }

  async chat(text: string): Promise<void> {
    const pc = await this.ensureSession();
    const opts = pc.session.isStreaming ? { streamingBehavior: "steer" as const } : undefined;
    void pc.session.prompt(text, opts).catch((err) => {
      this.broadcast({ type: "error", message: err instanceof Error ? err.message : String(err) });
    });
  }

  async render(): Promise<void> {
    const pc = await this.ensureSession();
    await pc.backend.renderPdf(this.project.pageHtml, this.project.proofPdf, this.config.render);
    this.proofCache = undefined;
    this.broadcast({ type: "files_changed" });
  }

  async proofPages(): Promise<Buffer[]> {
    if (!existsSync(this.project.proofPdf)) return [];
    const mtime = statSync(this.project.proofPdf).mtimeMs;
    if (this.proofCache?.mtime === mtime) return this.proofCache.pages;
    const { pdf } = await import("pdf-to-img");
    const doc = await pdf(this.project.proofPdf, { scale: 2 });
    const pages: Buffer[] = [];
    for await (const page of doc) pages.push(Buffer.from(page));
    this.proofCache = { mtime, pages };
    return pages;
  }

  projectState() {
    const rounds = readdirSync(this.project.reviewDir)
      .map((f) => /^round-(\d+)\.json$/.exec(f)?.[1])
      .filter(Boolean)
      .map(Number)
      .sort((a, b) => a - b)
      .map((n) => ({
        round: n,
        ...JSON.parse(readFileSync(join(this.project.reviewDir, `round-${n}.json`), "utf8")),
      }));
    const contextDir = join(REPO_ROOT, "context");
    const stylesDir = join(REPO_ROOT, "styles");
    return {
      slug: this.project.slug,
      brief: existsSync(join(this.project.dir, "brief.md")) ? this.project.brief() : "",
      contextFiles: existsSync(contextDir) ? readdirSync(contextDir).filter((f) => !f.startsWith(".")) : [],
      styleFiles: existsSync(stylesDir) ? readdirSync(stylesDir).filter((f) => !f.startsWith(".")) : [],
      rounds,
      images: listImageSlots(this.project),
      editable: listEditable(this.project),
      hasPage: existsSync(this.project.pageHtml),
      hasProof: existsSync(this.project.proofPdf),
      running: this.running,
      designerModel: `${this.config.designer.provider}/${this.config.designer.model}`,
    };
  }

  async dispose() {
    await this.pc?.dispose();
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

export async function startServer(projectDir: string, port: number): Promise<void> {
  const project = new Project(projectDir);
  const bridge = new Bridge(project);

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

      // Static project files (page.html, images/) for the live preview iframe.
      if (url.pathname.startsWith("/files/")) {
        const rel = normalize(decodeURIComponent(url.pathname.slice("/files/".length)));
        if (rel.startsWith("..")) return json(res, 403, { error: "forbidden" });
        const file = join(project.dir, rel);
        if (!existsSync(file) || !statSync(file).isFile()) return json(res, 404, { error: "not found" });
        res.writeHead(200, {
          "content-type": MIME[extname(file)] ?? "application/octet-stream",
          "access-control-allow-origin": "*",
          "cache-control": "no-store",
        });
        return res.end(readFileSync(file));
      }

      if (url.pathname === "/api/project") return json(res, 200, bridge.projectState());

      if (url.pathname === "/api/proof/meta") {
        const pages = await bridge.proofPages();
        return json(res, 200, { pages: pages.length });
      }
      const pageMatch = /^\/api\/proof\/page\/(\d+)$/.exec(url.pathname);
      if (pageMatch) {
        const pages = await bridge.proofPages();
        const idx = Number(pageMatch[1]);
        if (idx < 0 || idx >= pages.length) return json(res, 404, { error: "no such page" });
        res.writeHead(200, { "content-type": "image/png", "access-control-allow-origin": "*", "cache-control": "no-store" });
        return res.end(pages[idx]);
      }

      if (req.method === "POST" && url.pathname === "/api/run") {
        const body = await readBody(req);
        await bridge.run(body.prompt);
        return json(res, 200, { ok: true });
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
      if (req.method === "POST" && url.pathname === "/api/copy") {
        const body = await readBody(req);
        updateCopy(project, body.pcId, body.text);
        bridge.broadcast({ type: "files_changed" });
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/variant") {
        const body = await readBody(req);
        selectVariant(project, body.imageId, Number(body.variant));
        bridge.broadcast({ type: "files_changed" });
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
  console.log(`presscheck bridge — project=${project.slug} http://localhost:${port}`);

  const shutdown = async () => {
    await bridge.dispose();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// CLI entry
const isMain = process.argv[1]?.endsWith("server.ts");
if (isMain) {
  const args = process.argv.slice(2);
  const projectDir = args.find((a) => !a.startsWith("--")) ?? "projects/demo";
  const portIdx = args.indexOf("--port");
  const port = portIdx >= 0 ? Number(args[portIdx + 1]) : 7717;
  await startServer(projectDir, port);
}
