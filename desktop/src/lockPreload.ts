import { contextBridge, ipcRenderer } from "electron";

// Lock-screen bridge. One page, four modes (unlock / setup / change /
// disable); main owns all verification and storage.
contextBridge.exposeInMainWorld("balanceLockUi", {
  info: () => ipcRenderer.invoke("lock:info"),
  submit: (payload: { current?: string; next?: string }) => ipcRenderer.invoke("lock:submit", payload),
  touchId: () => ipcRenderer.invoke("lock:touchid"),
  cancel: () => ipcRenderer.invoke("lock:cancel"),
});
