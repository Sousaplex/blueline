// Electron shell (M3): hosts the viewer, runs the engine bridge as a child
// process, and provides true-WYSIWYG PDF export via printToPDF — the same
// Chromium that renders the preview window.
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
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

/** Preferred bridge port: env override → configured mcp.port → default 7717. The
 *  bridge auto-falls-back to a free port if this one is taken; we discover where
 *  it actually landed via ~/.blueline/bridge.json. */
function preferredPort(): number {
  if (process.env.BLUELINE_PORT) return Number(process.env.BLUELINE_PORT);
  for (const p of [join(BLUELINE_HOME ?? REPO_ROOT, "config", "providers.json"), join(REPO_ROOT, "config", "providers.example.json")]) {
    try {
      const cfg = JSON.parse(readFileSync(p, "utf8"));
      if (cfg?.mcp?.port) return Number(cfg.mcp.port);
    } catch {
      /* file missing or unreadable — try the next candidate */
    }
  }
  return 7717;
}
/** The port the running bridge recorded, or null if none is up. */
function discoveredPort(): number | null {
  try {
    const raw = JSON.parse(readFileSync(join(app.getPath("home"), ".blueline", "bridge.json"), "utf8"));
    return typeof raw.port === "number" && raw.port > 0 ? raw.port : null;
  } catch {
    return null;
  }
}
let BRIDGE_PORT = preferredPort();
let BRIDGE_URL = `http://localhost:${BRIDGE_PORT}`;
function setBridgePort(port: number): void {
  BRIDGE_PORT = port;
  BRIDGE_URL = `http://localhost:${port}`;
}
const SMOKE = process.env.BLUELINE_SMOKE === "1";
const SMOKE_DIR = process.env.BLUELINE_SMOKE_DIR ?? join(app.getPath("temp"), "blueline-smoke");

const childEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  ...(BLUELINE_HOME ? { BLUELINE_HOME } : {}),
  ...(PACKAGED ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
  // Stamp archives (.blueline/.blueproject manifests) with the app version.
  BLUELINE_VERSION: app.getVersion(),
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
function chromiumInstalled(): boolean {
  try {
    const base = process.env.PLAYWRIGHT_BROWSERS_PATH || join(app.getPath("home"), "Library", "Caches", "ms-playwright");
    return existsSync(base) && readdirSync(base).some((d) => d.startsWith("chromium"));
  } catch {
    return false;
  }
}
async function ensureChromium(): Promise<void> {
  if (!PACKAGED) return;
  // Skip the ~1s no-op spawn on every launch once Chromium is cached.
  if (chromiumInstalled()) {
    smokeLog("[startup] chromium present");
    return;
  }
  smokeLog("[startup] installing chromium (first run)");
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
    smokeLog("[startup] chromium ready");
  } catch (err) {
    // Non-fatal: an offline first launch shouldn't brick the app — it opens, and the first
    // render/export surfaces a clear error instead of a hung splash.
    smokeLog("[startup] chromium install failed (offline?): " + (err instanceof Error ? err.message : String(err)));
  }
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

async function bridgeAlive(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/api/project`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureBridge(): Promise<void> {
  // Reuse a bridge that's already up: one recorded in discovery, or a dev bridge
  // on the preferred port. Verify liveness so a stale record can't mislead us.
  for (const p of [discoveredPort(), BRIDGE_PORT].filter((x): x is number => typeof x === "number")) {
    if (await bridgeAlive(p)) {
      setBridgePort(p);
      return;
    }
  }
  // Spawn on the preferred port; the bridge records where it truly bound (it may
  // fall back if the port was taken), and we adopt that.
  bridgeChild = spawnNode([TSX_CLI, "src/engine/server.ts", "--port", String(BRIDGE_PORT)]);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const port = discoveredPort();
    if (port && (await bridgeAlive(port))) {
      setBridgePort(port);
      return;
    }
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

  // Renders agent-authored HTML: OS-sandboxed, isolated, no popups. The page's own
  // scripts are already blocked by the bridge's CSP on /files/* (script-src 'none');
  // executeJavaScript below is embedder-injected and unaffected by that CSP.
  const printWin = new BrowserWindow({
    show: false,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true },
  });
  printWin.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  try {
    await printWin.loadURL(`${BRIDGE_URL}/files/page.html`);
    // Wait for images to DECODE (webp decodes lazily and would otherwise drop from the
    // PDF) and fonts to load — not just a fixed settle.
    await printWin.webContents.executeJavaScript(
      `(async () => {
        await Promise.all(Array.from(document.images).map((img) => img.decode().catch(() => {})));
        if (document.fonts && document.fonts.ready) await document.fonts.ready;
      })()`,
    );
    // Chromium's PDF path draws `box-shadow` blur as a HARD solid offset rectangle,
    // producing phantom "solid square" artifacts behind shadowed elements (visible in
    // the export but not the on-screen preview). Strip shadows so the deliverable is
    // clean — matches the Playwright render path and the designer prompt guidance.
    await printWin.webContents.insertCSS("*, *::before, *::after { box-shadow: none !important; }");
    await new Promise((r) => setTimeout(r, 150)); // small paint settle
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

// Double-clicking a .blueline/.blueproject in Finder fires 'open-file' (macOS only,
// registered by the fileAssociations in package.json). It can arrive BEFORE the app
// is ready (cold start), so buffer paths until the bridge + window are up, then import
// each through the same endpoint the in-app Import button uses.
let filesReady = false;
const pendingOpenFiles: string[] = [];

async function handleOpenFile(filePath: string): Promise<void> {
  if (!/\.(blueline|blueproject)$/i.test(filePath)) return;
  try {
    const dataBase64 = readFileSync(filePath).toString("base64");
    const res = await fetch(`${BRIDGE_URL}/api/project/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dataBase64, open: true }),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(err.error ?? `HTTP ${res.status}`);
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
  } catch (err) {
    dialog.showErrorBox(
      "Couldn't open file",
      `${filePath}\n\n${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

app.on("open-file", (event, filePath) => {
  event.preventDefault(); // tell macOS we handled it
  if (filesReady) void handleOpenFile(filePath);
  else pendingOpenFiles.push(filePath);
});

app.whenReady().then(async () => {
  try {
    // Window FIRST so the app never has zero windows during setup (see ensureChromium note).
    mainWindow = new BrowserWindow({
      width: 1440,
      height: 900,
      title: "Blueline",
      show: true,
      // Frameless-inset chrome (Spotify/VS Code/Claude look): no OS title bar, the
      // traffic lights float over our own top bar. App.tsx makes the header a drag
      // region and pads its left edge to clear the lights. macOS-only styling; on
      // other platforms this falls back to a standard frame.
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 16, y: 16 },
      webPreferences: {
        preload: join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      // Web links only. file:// or custom schemes (macOS hands those to whatever app
      // registered them) must never be launchable by rendered/agent content.
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
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

    // Bridge + renderer are up — drain any files opened via Finder double-click.
    filesReady = true;
    if (!SMOKE) {
      for (const f of pendingOpenFiles.splice(0)) await handleOpenFile(f);
    }

    if (SMOKE) {
      await runSmokeTest();
      app.exit(0);
    }

    // Auto-update: check the GitHub Releases feed and TELL the user a new version is
    // available — no silent download. The renderer shows a prompt; the download only
    // starts when the user approves (update-download), and installs on their command
    // (update-install). Never during smoke or dev.
    if (PACKAGED && !SMOKE) {
      const { autoUpdater } = electronUpdater;
      autoUpdater.autoDownload = false; // wait for explicit user approval
      autoUpdater.autoInstallOnAppQuit = false;
      const toRenderer = (channel: string, payload: unknown) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
      };
      // Surface errors to the UI — console.log is invisible in a packaged app, so a failed
      // download/install used to look like "nothing happened".
      autoUpdater.on("error", (e) => {
        console.log("[updater] error:", String(e));
        toRenderer("update-error", { message: e instanceof Error ? e.message : String(e) });
      });
      autoUpdater.on("update-available", (i) => {
        console.log("[updater] update available:", i.version);
        toRenderer("update-available", { version: i.version });
      });
      // Forward the FULL ProgressInfo, not just percent: the mac payload is the whole app
      // (~223 MB) with no reliable delta, so bytes + rate + ETA are what tell the user this
      // is working rather than wedged. See app/src/lib/update.ts for the formatting.
      autoUpdater.on("download-progress", (p) =>
        toRenderer("update-progress", {
          percent: Math.round(p.percent),
          transferred: p.transferred,
          total: p.total,
          bytesPerSecond: p.bytesPerSecond,
        }),
      );
      autoUpdater.on("update-downloaded", (i) => {
        console.log("[updater] downloaded:", i.version);
        toRenderer("update-downloaded", { version: i.version });
      });
      ipcMain.handle("update-download", async () => {
        try {
          await autoUpdater.downloadUpdate();
        } catch (e) {
          toRenderer("update-error", { message: e instanceof Error ? e.message : String(e) });
        }
      });
      ipcMain.handle("update-install", () => {
        // Squirrel.Mac can only swap an app that lives in /Applications. Running from the DMG
        // or ~/Downloads is the #1 cause of "clicked Restart, app just closed, nothing changed".
        if (process.platform === "darwin" && !app.isInApplicationsFolder()) {
          toRenderer("update-error", {
            message:
              "Blueline must be in your Applications folder to update. Quit, drag Blueline into Applications, reopen from there, then update.",
          });
          return;
        }
        try {
          // isForceRunAfter = true so the app RELAUNCHES after installing (default doesn't).
          autoUpdater.quitAndInstall(false, true);
        } catch (e) {
          toRenderer("update-error", { message: e instanceof Error ? e.message : String(e) });
        }
      });
      autoUpdater.checkForUpdates().catch((e) => {
        console.log("[updater] check failed:", String(e));
        toRenderer("update-error", { message: String(e) });
      });
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
// Save arbitrary text (session export JSON/JSONL) via a native Save dialog, then return the path.
ipcMain.handle("save-text-file", async (_e, defaultName: string, content: string) => {
  const safe = String(defaultName).replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 200) || "blueline-export.txt";
  const picked = await dialog.showSaveDialog(mainWindow!, {
    defaultPath: join(app.getPath("downloads"), safe),
  });
  if (picked.canceled || !picked.filePath) return null;
  writeFileSync(picked.filePath, String(content));
  return picked.filePath;
});
// Save a binary blob (a .blueline/.blueproject archive, base64) via a native Save dialog.
ipcMain.handle("save-binary-file", async (_e, defaultName: string, base64: string) => {
  const safe = String(defaultName).replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 200) || "export.blueline";
  const picked = await dialog.showSaveDialog(mainWindow!, { defaultPath: join(app.getPath("downloads"), safe) });
  if (picked.canceled || !picked.filePath) return null;
  writeFileSync(picked.filePath, Buffer.from(String(base64), "base64"));
  return picked.filePath;
});
// Open a .blueline/.blueproject archive via a native Open dialog; returns {name, base64}.
ipcMain.handle("open-archive-file", async () => {
  const picked = await dialog.showOpenDialog(mainWindow!, {
    properties: ["openFile"],
    filters: [{ name: "Blueline", extensions: ["blueline", "blueproject"] }],
  });
  if (picked.canceled || !picked.filePaths[0]) return null;
  const p = picked.filePaths[0];
  return { name: p.split("/").pop(), base64: readFileSync(p).toString("base64") };
});
ipcMain.handle("reveal-in-finder", (_e, path: string) => shell.showItemInFolder(path));
// openPath LAUNCHES things (an .app bundle path executes it). The renderer only ever needs
// to open exported documents/images or reveal folders — allowlist exactly that.
const SAFE_OPEN_EXT = new Set([".pdf", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".html", ".md", ".txt"]);
ipcMain.handle("open-path", (_e, path: string) => {
  const p = String(path);
  if (!existsSync(p)) return "not found";
  if (/\.app(\/|$)/i.test(p)) return "refused";
  const isDir = statSync(p).isDirectory();
  if (!isDir && !SAFE_OPEN_EXT.has(extname(p).toLowerCase())) return "refused";
  return shell.openPath(p);
});

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
