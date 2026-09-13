import { contextBridge, ipcRenderer } from "electron";

// First-run chooser bridge. The page has two jobs: ask whether Balance Cloud
// is on offer yet, and report the mode the user picked.
contextBridge.exposeInMainWorld("balanceSetup", {
  cloudEnabled: (): Promise<boolean> => ipcRenderer.invoke("setup:cloud-enabled"),
  chooseMode: (mode: "local" | "cloud") => ipcRenderer.invoke("setup:choose-mode", mode),
});
