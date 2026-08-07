import { contextBridge, ipcRenderer } from "electron";

/** Mirrors electron-updater's ProgressInfo. Structurally identical to the renderer's
 *  UpdateProgress (app/src/lib/update.ts) — preload can't import from src/, so the shape
 *  is restated here rather than shared. */
interface UpdateProgress {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}

contextBridge.exposeInMainWorld("blueline", {
  isElectron: true as const,
  exportPdf: (): Promise<string | null> => ipcRenderer.invoke("export-pdf"),
  saveTextFile: (defaultName: string, content: string): Promise<string | null> =>
    ipcRenderer.invoke("save-text-file", defaultName, content),
  saveBinaryFile: (defaultName: string, base64: string): Promise<string | null> =>
    ipcRenderer.invoke("save-binary-file", defaultName, base64),
  openArchiveFile: (): Promise<{ name: string; base64: string } | null> => ipcRenderer.invoke("open-archive-file"),
  revealInFinder: (path: string): Promise<void> => ipcRenderer.invoke("reveal-in-finder", path),
  openPath: (path: string): Promise<void> => ipcRenderer.invoke("open-path", path),
  chooseDirectory: (): Promise<string | null> => ipcRenderer.invoke("choose-directory"),
  setApiKeys: (keys: Record<string, string>): Promise<string[]> => ipcRenderer.invoke("set-api-keys", keys),
  keychainAvailable: (): Promise<boolean> => ipcRenderer.invoke("keychain-available"),
  // Auto-update: the renderer subscribes to availability/progress and drives the
  // download/install on the user's approval (no silent updates).
  downloadUpdate: (): Promise<void> => ipcRenderer.invoke("update-download"),
  installUpdate: (): Promise<void> => ipcRenderer.invoke("update-install"),
  onUpdateAvailable: (cb: (version: string) => void): (() => void) => {
    const h = (_e: unknown, p: { version: string }) => cb(p.version);
    ipcRenderer.on("update-available", h);
    return () => ipcRenderer.removeListener("update-available", h);
  },
  onUpdateProgress: (cb: (p: UpdateProgress) => void): (() => void) => {
    const h = (_e: unknown, p: UpdateProgress) => cb(p);
    ipcRenderer.on("update-progress", h);
    return () => ipcRenderer.removeListener("update-progress", h);
  },
  onUpdateDownloaded: (cb: (version: string) => void): (() => void) => {
    const h = (_e: unknown, p: { version: string }) => cb(p.version);
    ipcRenderer.on("update-downloaded", h);
    return () => ipcRenderer.removeListener("update-downloaded", h);
  },
  onUpdateError: (cb: (message: string) => void): (() => void) => {
    const h = (_e: unknown, p: { message: string }) => cb(p.message);
    ipcRenderer.on("update-error", h);
    return () => ipcRenderer.removeListener("update-error", h);
  },
});
