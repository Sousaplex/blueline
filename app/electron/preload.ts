import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("blueline", {
  isElectron: true as const,
  exportPdf: (): Promise<string | null> => ipcRenderer.invoke("export-pdf"),
  revealInFinder: (path: string): Promise<void> => ipcRenderer.invoke("reveal-in-finder", path),
  openPath: (path: string): Promise<void> => ipcRenderer.invoke("open-path", path),
  chooseDirectory: (): Promise<string | null> => ipcRenderer.invoke("choose-directory"),
  setApiKeys: (keys: Record<string, string>): Promise<string[]> => ipcRenderer.invoke("set-api-keys", keys),
  keychainAvailable: (): Promise<boolean> => ipcRenderer.invoke("keychain-available"),
});
