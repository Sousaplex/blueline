// Electron shell (M3): hosts the viewer, runs the engine bridge as a child
// process, and provides true-WYSIWYG PDF export via printToPDF — the same
// Chromium that renders the preview window.
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { BrowserWindow, app, dialog, ipcMain, shell } from "electron";
import { keychainAvailable, loadCredentials, migrateEnvFile, saveCredentials } from "./credentials";
import electronUpdater from "electron-updater";

/** One-time migration: carry settings/keys over from the pre-rename app-data dirs. */
function migrateLegacyAppData(): void {
  if (!app.isPackaged) return;
  const userData = app.getPath("userData");
  if (existsSync(join(userData, "config"))) return; // already set up under the new name
  const appData = app.getPath("appData");
  for (const legacy of ["presscheck-app", "presscheck"]) {
    const oldDir = join(appData, legacy);
    if (!existsSync(join(oldDir, "config"))) continue;
    mkdirSync(userData, { recursive: true });
    cpSync(join(oldDir, "config"), join(userData, "config"), { recursive: true });
    if (existsSync(join(oldDir, ".env"))) cpSync(join(oldDir, ".env"), join(userData, ".env"));
    break;
  }
}
migrateLegacyAppData();

// Dev: dist-electron/main.cjs -> app/ -> repo root. Packaged: everything the
// bridge needs ships under Contents/Resources, and mutable state moves to the
// per-user app-data dir via BLUELINE_HOME.
const REPO_ROOT = resolve(__dirname, "..", "..");
const PACKAGED = app.isPackaged;
const TOOLKIT_DIR = PACKAGED ? join(process.resourcesPath, "toolkit") : join(REPO_ROOT, "toolkit");
const BLUELINE_HOME = process.env.BLUELINE_HOME ?? (PACKAGED ? app.getPath("userData") : undefined);
const BRIDGE_PORT = Number(process.env.BLUELINE_PORT ?? 7717);
const BRIDGE_URL = `http://localhost:${BRIDGE_PORT}`;
const SMOKE = process.env.BLUELINE_SMOKE === "1";
const SMOKE_DIR = process.env.BLUELINE_SMOKE_DIR ?? join(app.getPath("temp"), "blueline-smoke");

const childEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  ...(BLUELINE_HOME ? { BLUELINE_HOME } : {}),
  ...(PACKAGED ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
  // Decrypt keychain-held API keys straight into the bridge child's env — the
  // bridge reads process.env, so no plaintext .env is needed in the packaged app.
  ...loadCredentials(),
});

/** Run a node script with Electron's bundled Node (works inside the packaged app). */
function spawnNode(args: string[]): ChildProcess {
  if (PACKAGED) {
    return spawn(process.execPath, args, { cwd: TOOLKIT_DIR, stdio: "inherit", env: childEnv() });
  }
  return spawn("npx", ["tsx", ...args.slice(1)], { cwd: TOOLKIT_DIR, stdio: "inherit", env: childEnv() });
}

const TSX_CLI = join(TOOLKIT_DIR, "node_modules", "tsx", "dist", "cli.mjs");

/** Packaged first-run: make sure Playwright's Chromium exists (no-op when present).
 *  IMPORTANT: never open/close a temporary window for this — dropping to zero windows
 *  mid-startup fires window-all-closed and quits the app. Reuse the main window. */
async function ensureChromium(): Promise<void> {
  if (!PACKAGED) return;
  smokeLog("[startup] ensuring chromium");
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [join(TOOLKIT_DIR, "node_modules", "playwright", "cli.js"), "install", "chromium"],
      { cwd: TOOLKIT_DIR, stdio: "inherit", env: childEnv() },
    );
    child.on("exit", (code) => (code === 0 ? resolvePromise() : reject(new Error(`playwright install exited ${code}`))));
    child.on("error", reject);
  });
  smokeLog("[startup] chromium ready");
}

const SPLASH_URL =
  "data:text/html;charset=utf-8," + // charset is REQUIRED: without it "…" decodes as Latin-1 mojibake
  encodeURIComponent(
    `<body style="font-family:system-ui;background:#fafafa;color:#1a1a1a;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div>Starting Blueline…</div></body>`,
  );

let bridgeChild: ChildProcess | undefined;
let mainWindow: BrowserWindow | undefined;

/** Main-process stdout is not reliably visible in packaged builds — log smoke steps to a file. */
function smokeLog(msg: string): void {
  console.log(msg);
  if (!SMOKE) return;
  try {
    mkdirSync(SMOKE_DIR, { recursive: true });
    appendFileSync(join(SMOKE_DIR, "smoke.log"), `${new Date().toISOString()} ${msg}\n`);
  } catch {
    /* logging must never break the app */
  }
}

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

  // Filename: "<series> — <display name>.pdf" when the document belongs to a series.
  const meta = state.meta as { displayName?: string; series?: string | null } | null;
  const nice = meta?.series ? `${meta.series} — ${meta.displayName ?? state.slug}` : (meta?.displayName ?? state.slug);
  const fileSafe = nice.replace(/[/\\:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim() || state.slug;

  let outPath = targetPath;
  if (!outPath) {
    const picked = await dialog.showSaveDialog(mainWindow!, {
      title: "Export PDF",
      defaultPath: join(app.getPath("documents"), `${fileSafe}.pdf`),
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
  smokeLog("[smoke] step 1: settle");
  mkdirSync(SMOKE_DIR, { recursive: true });
  await new Promise((r) => setTimeout(r, 2500)); // let the UI settle
  smokeLog("[smoke] step 2: capturePage");
  const image = await mainWindow!.webContents.capturePage();
  writeFileSync(join(SMOKE_DIR, "smoke-window.png"), image.toPNG());
  smokeLog("[smoke] step 3: exportPdf");
  const exported = await exportPdf(join(SMOKE_DIR, "smoke-export.pdf"));
  smokeLog(`[smoke] done window=${join(SMOKE_DIR, "smoke-window.png")} export=${exported}`);
}

app.whenReady().then(async () => {
  try {
    // Window FIRST so the app never has zero windows during setup (see ensureChromium note).
    mainWindow = new BrowserWindow({
      width: 1440,
      height: 900,
      title: "Blueline",
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
    await mainWindow.loadURL(SPLASH_URL);

    await ensureChromium();
    // Pull any legacy plaintext keys into the keychain BEFORE the bridge spawns,
    // so it boots with keys injected via childEnv and the .env plaintext is gone.
    if (PACKAGED && BLUELINE_HOME) {
      try {
        migrateEnvFile(BLUELINE_HOME);
      } catch (e) {
        smokeLog("[credentials] migration skipped: " + String(e));
      }
    }
    await ensureBridge();
    smokeLog("[startup] bridge ready");

    const rendererUrl = process.env.VITE_DEV_SERVER_URL ?? `${BRIDGE_URL}/`;
    if (!PACKAGED && !process.env.VITE_DEV_SERVER_URL && !existsSync(join(REPO_ROOT, "app", "dist", "index.html"))) {
      throw new Error("app/dist not built — run `npm run build` in app/ (or set VITE_DEV_SERVER_URL)");
    }
    if (SMOKE) smokeLog("[smoke] loading renderer: " + rendererUrl);
    await mainWindow.loadURL(rendererUrl);
    if (SMOKE) smokeLog("[smoke] renderer loaded");

    if (SMOKE) {
      await runSmokeTest();
      app.exit(0);
    }

    // Auto-update: check the GitHub Releases feed, download a newer signed build in
    // the background, and notify the user to restart. Never during smoke or dev.
    if (PACKAGED && !SMOKE) {
      const { autoUpdater } = electronUpdater;
      autoUpdater.autoDownload = true;
      autoUpdater.on("error", (e) => console.log("[updater] error:", String(e)));
      autoUpdater.on("update-available", (i) => console.log("[updater] update available:", i.version));
      autoUpdater.on("update-downloaded", (i) => console.log("[updater] downloaded:", i.version, "— will install on quit"));
      // checkForUpdatesAndNotify handles the "restart to update?" native notification.
      autoUpdater.checkForUpdatesAndNotify().catch((e) => console.log("[updater] check failed:", String(e)));
    }
  } catch (err) {
    smokeLog("[blueline] startup failed: " + String(err));
    if (SMOKE) app.exit(1);
    else dialog.showErrorBox("blueline failed to start", err instanceof Error ? err.message : String(err));
  }
});

// Persist API keys to the OS keychain (main-process custody) AND push them into
// the already-running bridge in-memory, so a key set in Settings takes effect with
// no relaunch and no plaintext ever hits disk. Returns the names saved.
ipcMain.handle("set-api-keys", async (_e, keys: Record<string, string>): Promise<string[]> => {
  const saved = saveCredentials(keys);
  await fetch(`${BRIDGE_URL}/api/keys/apply`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(keys),
  }).catch(() => {}); // the persisted copy is authoritative; bridge picks it up next launch regardless
  return saved;
});
ipcMain.handle("keychain-available", () => keychainAvailable());

ipcMain.handle("export-pdf", async () => exportPdf());
ipcMain.handle("reveal-in-finder", (_e, path: string) => shell.showItemInFolder(path));
ipcMain.handle("open-path", (_e, path: string) => shell.openPath(path));

ipcMain.handle("choose-directory", async () => {
  const picked = await dialog.showOpenDialog(mainWindow!, {
    title: "Choose workspace folder",
    message: "Pick the folder where Blueline keeps projects, context, and brand files",
    properties: ["openDirectory", "createDirectory"],
  });
  return picked.canceled ? null : (picked.filePaths[0] ?? null);
});

app.on("window-all-closed", () => app.quit());
app.on("quit", () => {
  bridgeChild?.kill("SIGTERM");
});
