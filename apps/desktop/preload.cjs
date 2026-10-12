const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("glintmotion", {
  listProjects: () => ipcRenderer.invoke("projects:list"),
  defaultParent: () => ipcRenderer.invoke("projects:defaultParent"),
  pickFolder: (purpose) => ipcRenderer.invoke("projects:pickFolder", purpose),
  openProject: (dir) => ipcRenderer.invoke("projects:open", dir),
  createProject: (options) => ipcRenderer.invoke("projects:create", options),
  revealProject: (dir) => ipcRenderer.invoke("projects:reveal", dir),
  forgetProject: (dir) => ipcRenderer.invoke("projects:forget", dir),
  home: () => ipcRenderer.invoke("app:home"),
});
