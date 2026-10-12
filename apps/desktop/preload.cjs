const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("glintmotion", {
  listProjects: () => ipcRenderer.invoke("projects:list"),
  currentProject: () => ipcRenderer.invoke("projects:current"),
  defaultParent: () => ipcRenderer.invoke("projects:defaultParent"),
  pickFolder: (purpose) => ipcRenderer.invoke("projects:pickFolder", purpose),
  openProject: (dir) => ipcRenderer.invoke("projects:open", dir),
  createProject: (options) => ipcRenderer.invoke("projects:create", options),
  revealProject: (dir) => ipcRenderer.invoke("projects:reveal", dir),
  forgetProject: (dir) => ipcRenderer.invoke("projects:forget", dir),
  home: (action) => ipcRenderer.invoke("app:home", action),
  mcp: {
    info: () => ipcRenderer.invoke("mcp:info"),
    copy: (value) => ipcRenderer.invoke("mcp:copy", value),
    open: () => ipcRenderer.invoke("mcp:open"),
  },
  claude: {
    status: () => ipcRenderer.invoke("claude:status"),
    account: (action) => ipcRenderer.invoke("claude:account", action),
    cancel: () => ipcRenderer.invoke("claude:cancel"),
  },
  agent: {
    models: () => ipcRenderer.invoke("agent:models"),
    send: (request) => ipcRenderer.invoke("agent:send", request),
    stop: () => ipcRenderer.invoke("agent:stop"),
    reset: () => ipcRenderer.invoke("agent:reset"),
    onEvent: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on("agent:event", listener);
      return () => ipcRenderer.removeListener("agent:event", listener);
    },
  },
});
