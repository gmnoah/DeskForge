const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("deskforge", {
  invoke(method, payload) {
    return ipcRenderer.invoke("deskforge:invoke", { method, payload });
  },
  onEvent(handler) {
    const listener = (_event, data) => handler(data);
    ipcRenderer.on("deskforge:event", listener);
    return () => ipcRenderer.removeListener("deskforge:event", listener);
  },
});
