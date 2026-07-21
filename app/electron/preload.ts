import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("presscheck", {
  isElectron: true as const,
  exportPdf: (): Promise<string | null> => ipcRenderer.invoke("export-pdf"),
  chooseDirectory: (): Promise<string | null> => ipcRenderer.invoke("choose-directory"),
});
