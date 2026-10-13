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
  cli: {
    status: () => ipcRenderer.invoke("cli:status"),
    install: () => ipcRenderer.invoke("cli:install"),
  },
  skills: {
    status: () => ipcRenderer.invoke("skills:status"),
    install: () => ipcRenderer.invoke("skills:install"),
  },
  music: {
    hasKey: () => ipcRenderer.invoke("music:hasKey"),
    saveKey: (key) => ipcRenderer.invoke("music:saveKey", key),
    clearKey: () => ipcRenderer.invoke("music:clearKey"),
    generate: (request) => ipcRenderer.invoke("music:generate", request),
  },
  motion: {
    check: () => ipcRenderer.invoke("motion:check"),
  },
  deliver: {
    render: (request) => ipcRenderer.invoke("deliver:render", request),
    reveal: (file) => ipcRenderer.invoke("deliver:reveal", file),
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
