// Electron shell (M3): hosts the viewer, runs the engine bridge as a child
// process, and provides true-WYSIWYG PDF export via printToPDF — the same
// Chromium that renders the preview window.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { BrowserWindow, app, dialog, ipcMain, shell } from "electron";

// Dev: dist-electron/main.cjs -> app/ -> repo root. Packaged: everything the
// bridge needs ships under Contents/Resources, and mutable state moves to the
// per-user app-data dir via PRESSCHECK_HOME.
const REPO_ROOT = resolve(__dirname, "..", "..");
const PACKAGED = app.isPackaged;
const TOOLKIT_DIR = PACKAGED ? join(process.resourcesPath, "toolkit") : join(REPO_ROOT, "toolkit");
const PRESSCHECK_HOME = process.env.PRESSCHECK_HOME ?? (PACKAGED ? app.getPath("userData") : undefined);
const BRIDGE_PORT = Number(process.env.PRESSCHECK_PORT ?? 7717);
const BRIDGE_URL = `http://localhost:${BRIDGE_PORT}`;
const SMOKE = process.env.PRESSCHECK_SMOKE === "1";
const SMOKE_DIR = process.env.PRESSCHECK_SMOKE_DIR ?? join(app.getPath("temp"), "presscheck-smoke");

const childEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  ...(PRESSCHECK_HOME ? { PRESSCHECK_HOME } : {}),
  ...(PACKAGED ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
});

/** Run a node script with Electron's bundled Node (works inside the packaged app). */
function spawnNode(args: string[]): ChildProcess {
  if (PACKAGED) {
    return spawn(process.execPath, args, { cwd: TOOLKIT_DIR, stdio: "inherit", env: childEnv() });
  }
  return spawn("npx", ["tsx", ...args.slice(1)], { cwd: TOOLKIT_DIR, stdio: "inherit", env: childEnv() });
}

const TSX_CLI = join(TOOLKIT_DIR, "node_modules", "tsx", "dist", "cli.mjs");

/** Packaged first-run: make sure Playwright's Chromium exists (no-op when present). */
async function ensureChromium(): Promise<void> {
  if (!PACKAGED) return;
  const progress = new BrowserWindow({ width: 380, height: 120, frame: false, resizable: false });
  await progress.loadURL(
    "data:text/html," +
      encodeURIComponent(
        `<body style="font-family:system-ui;background:#18181b;color:#fafafa;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div>Preparing render engine…</div></body>`,
      ),
  );
  try {
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn(
        process.execPath,
        [join(TOOLKIT_DIR, "node_modules", "playwright", "cli.js"), "install", "chromium"],
        { cwd: TOOLKIT_DIR, stdio: "inherit", env: childEnv() },
      );
      child.on("exit", (code) => (code === 0 ? resolvePromise() : reject(new Error(`playwright install exited ${code}`))));
      child.on("error", reject);
    });
  } finally {
    progress.destroy();
  }
}

let bridgeChild: ChildProcess | undefined;
let mainWindow: BrowserWindow | undefined;

async function bridgeAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${BRIDGE_URL}/api/project`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureBridge(): Promise<void> {
  if (await bridgeAlive()) return; // reuse a dev bridge if one is already running
  bridgeChild = spawnNode([TSX_CLI, "src/engine/server.ts", "--port", String(BRIDGE_PORT)]);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await bridgeAlive()) return;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error("Engine bridge failed to start within 30s");
}

/** Export the current page.html via printToPDF — identical engine to the preview. */
async function exportPdf(targetPath?: string): Promise<string | null> {
  const state = await (await fetch(`${BRIDGE_URL}/api/project`)).json();
  if (!state.hasPage) throw new Error("Nothing to export — no page.html yet");

  let outPath = targetPath;
  if (!outPath) {
    const picked = await dialog.showSaveDialog(mainWindow!, {
      title: "Export PDF",
      defaultPath: join(app.getPath("documents"), `${state.slug}.pdf`),
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (picked.canceled || !picked.filePath) return null;
    outPath = picked.filePath;
  }

  const printWin = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  try {
    await printWin.loadURL(`${BRIDGE_URL}/files/page.html`);
    await new Promise((r) => setTimeout(r, 500)); // fonts/images settle
    const pdf = await printWin.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
    });
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, pdf);
    return outPath;
  } finally {
    printWin.destroy();
  }
}

async function runSmokeTest(): Promise<void> {
  mkdirSync(SMOKE_DIR, { recursive: true });
  await new Promise((r) => setTimeout(r, 2500)); // let the UI settle
  const image = await mainWindow!.webContents.capturePage();
  writeFileSync(join(SMOKE_DIR, "smoke-window.png"), image.toPNG());
  const exported = await exportPdf(join(SMOKE_DIR, "smoke-export.pdf"));
  console.log(`[smoke] window=${join(SMOKE_DIR, "smoke-window.png")} export=${exported}`);
}

app.whenReady().then(async () => {
  try {
    await ensureChromium();
    await ensureBridge();
    mainWindow = new BrowserWindow({
      width: 1440,
      height: 900,
      title: "presscheck",
      // Keep the window visible even in smoke mode: capturePage can hang on a
      // never-painted hidden window in packaged builds.
      show: true,
      webPreferences: {
        preload: join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url);
      return { action: "deny" };
    });

    const rendererUrl = process.env.VITE_DEV_SERVER_URL ?? `${BRIDGE_URL}/`;
    if (!PACKAGED && !process.env.VITE_DEV_SERVER_URL && !existsSync(join(REPO_ROOT, "app", "dist", "index.html"))) {
      throw new Error("app/dist not built — run `npm run build` in app/ (or set VITE_DEV_SERVER_URL)");
    }
    await mainWindow.loadURL(rendererUrl);

    if (SMOKE) {
      await runSmokeTest();
      app.exit(0);
    }
  } catch (err) {
    console.error("[presscheck] startup failed:", err);
    if (SMOKE) app.exit(1);
    else dialog.showErrorBox("presscheck failed to start", err instanceof Error ? err.message : String(err));
  }
});

ipcMain.handle("export-pdf", async () => exportPdf());

ipcMain.handle("choose-directory", async () => {
  const picked = await dialog.showOpenDialog(mainWindow!, {
    title: "Choose workspace folder",
    message: "Pick the folder where presscheck keeps projects, context, and styles",
    properties: ["openDirectory", "createDirectory"],
  });
  return picked.canceled ? null : (picked.filePaths[0] ?? null);
});

app.on("window-all-closed", () => app.quit());
app.on("quit", () => {
  bridgeChild?.kill("SIGTERM");
});
