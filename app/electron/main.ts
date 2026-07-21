// Electron shell (M3): hosts the viewer, runs the engine bridge as a child
// process, and provides true-WYSIWYG PDF export via printToPDF — the same
// Chromium that renders the preview window.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { BrowserWindow, app, dialog, ipcMain, shell } from "electron";

// dist-electron/main.js -> app/ -> repo root
const REPO_ROOT = resolve(__dirname, "..", "..");
const TOOLKIT_DIR = join(REPO_ROOT, "toolkit");
const BRIDGE_PORT = Number(process.env.PRESSCHECK_PORT ?? 7717);
const BRIDGE_URL = `http://localhost:${BRIDGE_PORT}`;
const SMOKE = process.env.PRESSCHECK_SMOKE === "1";
const SMOKE_DIR = process.env.PRESSCHECK_SMOKE_DIR ?? join(app.getPath("temp"), "presscheck-smoke");

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
  bridgeChild = spawn("npx", ["tsx", "src/engine/server.ts", "--port", String(BRIDGE_PORT)], {
    cwd: TOOLKIT_DIR,
    stdio: "inherit",
    env: { ...process.env },
  });
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
    await ensureBridge();
    mainWindow = new BrowserWindow({
      width: 1440,
      height: 900,
      title: "presscheck",
      show: !SMOKE,
      webPreferences: {
        preload: join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url);
      return { action: "deny" };
    });

    const rendererUrl = process.env.VITE_DEV_SERVER_URL ?? `${BRIDGE_URL}/`;
    if (!process.env.VITE_DEV_SERVER_URL && !existsSync(join(REPO_ROOT, "app", "dist", "index.html"))) {
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
