import { contextBridge, ipcRenderer } from "electron";
import type { ScrapeWindow } from "./types";

// The narrow bridge the Balance web app sees as window.balanceDesktop.
// Contract mirror of client/src/lib/desktopBridge.ts. Keep the privileged
// surface narrow and explicit.
//
// appLock: the web Settings page drives the shell's app lock, but all
// password entry happens in a native window owned by the main process -- the
// web content never sees a password.
contextBridge.exposeInMainWorld("balanceDesktop", {
  scrapeAmazon: (window: ScrapeWindow) => ipcRenderer.invoke("amazon:scrape", window),
  // encryption: at-rest encryption is opt-in. The page can read the state and
  // ask the shell to turn it on; the key itself never crosses this boundary,
  // and the macOS permission prompt is raised by the main process.
  encryption: {
    status: () => ipcRenderer.invoke("encryption:status"),
    enable: () => ipcRenderer.invoke("encryption:enable"),
    decline: () => ipcRenderer.invoke("encryption:decline"),
  },
  appLock: {
    status: () => ipcRenderer.invoke("applock:status"),
    setup: () => ipcRenderer.invoke("applock:setup"),
    change: () => ipcRenderer.invoke("applock:change"),
    disable: () => ipcRenderer.invoke("applock:disable"),
    lockNow: () => ipcRenderer.invoke("applock:lock-now"),
  },
});
