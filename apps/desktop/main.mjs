import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, safeStorage, shell } from "electron";
import { spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMcpToken, startMcpServer } from "./mcp.mjs";
import { BUNDLED_FFMPEG_DIR, createKeyStore, deliverRender, generateMusic } from "./media.mjs";
import { createRenderJobs } from "./render-jobs.mjs";
import { CLI_COMMANDS } from "./agent-tools.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const APP_NAME = "Glintmotion";
const DEFAULT_PROJECTS_DIR = join(homedir(), "Movies", APP_NAME);
const MAX_RECENTS = 24;

app.setName(APP_NAME);

const engineEntry = app.isPackaged
  ? join(process.resourcesPath, "engine", "node_modules", "@hyperframes", "cli", "bin", "hyperframes.mjs")
  : join(here, "..", "..", "packages", "cli", "bin", "hyperframes.mjs");
const cliBinDir = app.isPackaged ? join(process.resourcesPath, "bin") : join(here, "bin");
const CLI_LINK = join(homedir(), ".local", "bin", "glintmotion");

// Finder launches apps with a minimal PATH. Homebrew's ffmpeg comes first (libx264);
// the bundled LGPL one covers Macs without it.
const engineEnv = {
  ...process.env,
  PATH: ["/opt/homebrew/bin", "/usr/local/bin", process.env.PATH ?? "/usr/bin:/bin", BUNDLED_FFMPEG_DIR].join(":"),
  ELECTRON_RUN_AS_NODE: "1",
  HYPERFRAMES_NO_TELEMETRY: "1",
  HYPERFRAMES_NO_UPDATE_CHECK: "1",
  DO_NOT_TRACK: "1",
  NO_COLOR: "1",
};

const STUDIO_CSS = `
[data-testid="header-open-in-desktop"],
[aria-label="Send feedback to the HyperFrames team"] { display: none !important; }
svg[aria-label="Glintmotion"] { cursor: pointer; }
`;

const STUDIO_JS = `
document.addEventListener("click", (event) => {
  if (event.target.closest('svg[aria-label="Glintmotion"]')) window.glintmotion.home();
}, true);
`;

/** @type {BrowserWindow | null} */
let win = null;
/** @type {{ child: import("node:child_process").ChildProcess, dir: string, url: string | null } | null} */
let studio = null;
/** @type {{ url: string, token: string, error: string | null } | null} */
let mcp = null;
/** @type {BrowserWindow | null} */
let connectWin = null;

const recentsFile = () => join(app.getPath("userData"), "recents.json");

function readRecents() {
  try {
    const list = JSON.parse(readFileSync(recentsFile(), "utf-8"));
    return Array.isArray(list) ? list.filter((r) => existsSync(join(r.path, "index.html"))) : [];
  } catch {
    return [];
  }
}

function rememberProject(dir) {
  const list = readRecents().filter((r) => r.path !== dir);
  list.unshift({ path: dir, openedAt: new Date().toISOString() });
  mkdirSync(dirname(recentsFile()), { recursive: true });
  writeFileSync(recentsFile(), JSON.stringify(list.slice(0, MAX_RECENTS), null, 2));
}

function projectInfo(dir, openedAt) {
  const html = readFileSync(join(dir, "index.html"), "utf-8");
  const root = /<[^>]*data-composition-id[^>]*>/.exec(html)?.[0] ?? "";
  const attr = (name) => new RegExp(`${name}="([^"]+)"`).exec(root)?.[1];
  const count = (tag) => (html.match(new RegExp(`<${tag}\\b`, "g")) ?? []).length;
  return {
    path: dir,
    name: basename(dir),
    openedAt,
    modifiedAt: statSync(join(dir, "index.html")).mtime.toISOString(),
    width: Number(attr("data-width")) || null,
    height: Number(attr("data-height")) || null,
    duration: Number(attr("data-duration")) || null,
    videos: count("video"),
    audios: count("audio"),
  };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function runEngine(args, cwd) {
  return spawn(process.execPath, [engineEntry, ...args], { cwd, env: engineEnv });
}

function stopStudio() {
  agentRun?.child.kill("SIGTERM");
  if (!studio) return;
  studio.child.kill("SIGTERM");
  studio = null;
}

async function openStudio(dir) {
  if (!existsSync(join(dir, "index.html"))) {
    throw new Error(`${basename(dir)} n'est pas un projet Glintmotion (pas de index.html).`);
  }
  stopStudio();
  const port = await freePort();
  const child = runEngine(["preview", dir, "--no-open", "--foreground", "--force-new", "--port", String(port)], dir);
  studio = { child, dir, url: null };

  const url = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("Le studio n'a pas démarré en 60 s.")), 60_000);
    const onData = (chunk) => {
      output += chunk.toString();
      const match = /Studio\s+(http:\/\/\S+)/.exec(output);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Le studio s'est arrêté (code ${code}).\n${output.slice(-800)}`));
    });
  });

  studio.url = url;
  rememberProject(dir);
  win.setTitle(`${APP_NAME} · ${basename(dir)}`);
  await win.loadURL(url);
}

async function goHome(action) {
  stopStudio();
  win.setTitle(APP_NAME);
  await win.loadFile(join(here, "ui", "index.html"), action === "new" ? { hash: "new" } : {});
}

function createProject({ name, parent, resolution }) {
  const safeName = String(name).trim();
  if (!/^[\p{L}\p{N}][\p{L}\p{N} _.-]*$/u.test(safeName)) {
    throw new Error("Nom invalide : lettres, chiffres, espaces, tirets et points seulement.");
  }
  if (!["portrait", "landscape", "square"].includes(resolution)) {
    throw new Error(`Format inconnu : ${resolution}`);
  }
  mkdirSync(parent, { recursive: true });
  const dir = join(parent, safeName);
  if (existsSync(dir)) throw new Error(`Le dossier ${dir} existe déjà.`);

  return new Promise((resolve, reject) => {
    const args = ["init", safeName, "--example", "blank", "--non-interactive", "--resolution", resolution];
    const child = runEngine(args, parent);
    let output = "";
    child.stdout.on("data", (c) => (output += c));
    child.stderr.on("data", (c) => (output += c));
    child.on("exit", (code) => {
      if (code === 0 && existsSync(join(dir, "index.html"))) resolve(dir);
      else reject(new Error(`La création a échoué (code ${code}).\n${output.slice(-800)}`));
    });
  });
}

ipcMain.handle("projects:list", () =>
  readRecents().map((r) => projectInfo(r.path, r.openedAt)),
);
ipcMain.handle("projects:defaultParent", () => DEFAULT_PROJECTS_DIR);
ipcMain.handle("projects:pickFolder", async (_event, purpose) => {
  const result = await dialog.showOpenDialog(win, {
    title: purpose === "parent" ? "Où créer le projet ?" : "Ouvrir un projet",
    defaultPath: existsSync(DEFAULT_PROJECTS_DIR) ? DEFAULT_PROJECTS_DIR : homedir(),
    properties: ["openDirectory", "createDirectory"],
  });
  return result.canceled ? null : result.filePaths[0];
});
ipcMain.handle("projects:open", (_event, dir) => openStudio(dir));
ipcMain.handle("projects:create", async (_event, options) => {
  const dir = await createProject(options);
  await openStudio(dir);
});
ipcMain.handle("projects:reveal", (_event, dir) => shell.showItemInFolder(join(dir, "index.html")));
ipcMain.handle("projects:forget", (_event, dir) => {
  const list = readRecents().filter((r) => r.path !== dir);
  writeFileSync(recentsFile(), JSON.stringify(list, null, 2));
});
ipcMain.handle("app:home", (_event, action) => goHome(action));
ipcMain.handle("projects:current", () => (studio ? projectInfo(studio.dir, null) : null));

const AGENT_MODELS = ["opus", "sonnet", "haiku"];
const AGENT_SYSTEM_PROMPT = [
  "You are working inside Glintmotion, a motion design studio where each video is an HTML composition.",
  "The studio is open on this project and reloads the preview live whenever you save a file.",
  "Edit the composition files in place. Answer in the language the user writes in, briefly.",
  "Run engine commands as `glintmotion <command>`: it is this app's engine, whereas `npx hyperframes` downloads another version.",
  "Useful: `glintmotion check --json` after editing, `glintmotion timeline --json`, `glintmotion snapshot --at 2,5` to look at frames, `glintmotion beats --json`.",
  "Do not render: the person exports from the studio.",
].join(" ");
const AGENT_ALLOWED_TOOLS = [
  "Bash(npm run check)",
  ...CLI_COMMANDS.flatMap((command) => [`Bash(glintmotion ${command})`, `Bash(glintmotion ${command} *)`]),
];

/** @type {{ child: import("node:child_process").ChildProcess, dir: string } | null} */
let agentRun = null;
/** @type {Map<string, string>} project dir -> Claude Code session id */
const agentSessions = new Map();

function locateClaude() {
  const candidates = [
    join(homedir(), ".local", "bin", "claude"),
    join(homedir(), ".claude", "local", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];
  const nvmRoot = join(homedir(), ".nvm", "versions", "node");
  if (existsSync(nvmRoot)) {
    for (const version of readdirSync(nvmRoot).sort().reverse()) {
      candidates.push(join(nvmRoot, version, "bin", "claude"));
    }
  }
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function findClaude() {
  const found = locateClaude();
  if (!found) throw new Error("Claude Code est introuvable sur ce Mac (commande claude).");
  return found;
}

const CLAUDE_INSTALL_URL = "https://claude.ai/install.sh";
const ACCOUNT_TIMEOUT_MS = 5 * 60_000;
/** @type {{ child: import("node:child_process").ChildProcess, cancelled: boolean } | null} */
let accountRun = null;

class AccountCancelled extends Error {}

/** Its output is never surfaced: a sign-in prints OAuth URLs carrying the session's state. */
function runClaudeCommand(bin, args, timeoutMs, failure) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: homedir(),
      env: { ...process.env, PATH: [dirname(bin), engineEnv.PATH].join(":") },
      stdio: ["ignore", "ignore", "ignore"],
    });
    const run = { child, cancelled: false };
    accountRun = run;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      accountRun = null;
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      accountRun = null;
      if (code === 0) resolve();
      else if (run.cancelled) reject(new AccountCancelled());
      else if (timedOut) reject(new Error(`${failure} Délai dépassé.`));
      else reject(new Error(`${failure} (code ${code})`));
    });
  });
}

async function claudeStatus() {
  const claude = locateClaude();
  if (!claude) return { installed: false, loggedIn: false, email: null, busy: Boolean(accountRun) };
  const output = await new Promise((resolve) => {
    const child = spawn(claude, ["auth", "status"], {
      env: { ...process.env, PATH: [dirname(claude), engineEnv.PATH].join(":") },
      stdio: ["ignore", "pipe", "ignore"],
    });
    let text = "";
    child.stdout.on("data", (chunk) => (text += chunk));
    child.on("error", () => resolve(""));
    child.on("exit", () => resolve(text));
  });
  let status = {};
  try {
    status = JSON.parse(String(output));
  } catch {
    status = {};
  }
  return {
    installed: true,
    loggedIn: status.loggedIn === true,
    email: typeof status.email === "string" ? status.email : null,
    busy: Boolean(accountRun),
  };
}

async function installClaude() {
  const { response } = await dialog.showMessageBox(win ?? undefined, {
    type: "question",
    buttons: ["Installer", "Annuler"],
    defaultId: 0,
    cancelId: 1,
    message: "Installer Claude Code ?",
    detail: `Glintmotion lance l'installateur officiel d'Anthropic (${CLAUDE_INSTALL_URL}). Claude Code s'installe dans ton dossier personnel.`,
  });
  if (response !== 0) return;
  await runClaudeCommand(
    "/bin/bash",
    ["-c", `set -o pipefail; curl -q --proto =https --proto-redir =https -fsSL ${CLAUDE_INSTALL_URL} | bash`],
    ACCOUNT_TIMEOUT_MS,
    "L'installation de Claude Code a échoué.",
  );
}

const login = () =>
  runClaudeCommand(findClaude(), ["auth", "login"], ACCOUNT_TIMEOUT_MS, "La connexion à Claude n'a pas abouti.");
const logout = () =>
  runClaudeCommand(findClaude(), ["auth", "logout"], 30_000, "La déconnexion de Claude a échoué.");

async function confirmLogout() {
  const { response } = await dialog.showMessageBox(win ?? undefined, {
    type: "warning",
    buttons: ["Se déconnecter", "Annuler"],
    defaultId: 1,
    cancelId: 1,
    message: "Se déconnecter de Claude ?",
    detail: "Claude Code est déconnecté sur tout le Mac, y compris dans le terminal et les autres apps qui l'utilisent.",
  });
  return response === 0;
}

async function runClaudeAccount(action) {
  if (accountRun) throw new Error("Une opération de compte est déjà en cours.");
  if (agentRun) throw new Error("Attends la fin de la demande en cours.");
  if (action === "logout" && !(await confirmLogout())) return claudeStatus();
  try {
    if (action === "install") await installClaude();
    else if (action === "login") await login();
    else if (action === "logout") await logout();
    else if (action === "switch") {
      await logout();
      await login();
    } else throw new Error(`Action inconnue : ${action}`);
  } catch (error) {
    if (!(error instanceof AccountCancelled)) throw error;
  }
  agentSessions.clear();
  return claudeStatus();
}

function sendAgentEvent(event) {
  win?.webContents.send("agent:event", event);
}

function forwardAgentLine(line, dir) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.session_id) agentSessions.set(dir, message.session_id);
  if (message.type === "assistant") {
    for (const block of message.message?.content ?? []) {
      if (block.type === "text" && block.text.trim()) sendAgentEvent({ kind: "text", text: block.text });
      if (block.type === "tool_use") {
        const input = block.input ?? {};
        const target = input.file_path ?? input.path ?? input.pattern ?? input.command ?? "";
        sendAgentEvent({ kind: "tool", name: block.name, target: String(target).replace(`${dir}/`, "") });
      }
    }
  } else if (message.type === "result") {
    sendAgentEvent({
      kind: "done",
      error: message.is_error ? String(message.result ?? "Erreur de l'agent") : null,
      costUsd: message.total_cost_usd ?? null,
      durationMs: message.duration_ms ?? null,
    });
  }
}

function startAgent({ prompt, model }) {
  if (!studio) throw new Error("Aucun projet ouvert.");
  if (agentRun) throw new Error("L'agent travaille déjà sur une demande.");
  const text = String(prompt ?? "").trim();
  if (!text) throw new Error("Demande vide.");
  if (!AGENT_MODELS.includes(model)) throw new Error(`Modèle inconnu : ${model}`);

  const claude = findClaude();
  const dir = studio.dir;
  const args = [
    "-p",
    text,
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    model,
    "--permission-mode",
    "acceptEdits",
    "--allowedTools",
    ...AGENT_ALLOWED_TOOLS,
    "--append-system-prompt",
    AGENT_SYSTEM_PROMPT,
  ];
  const session = agentSessions.get(dir);
  if (session) args.push("--resume", session);

  const child = spawn(claude, args, {
    cwd: dir,
    env: { ...process.env, PATH: [dirname(claude), engineEnv.PATH].join(":") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  agentRun = { child, dir };
  let buffer = "";
  let stderr = "";
  let finished = false;
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.includes('"type":"result"')) finished = true;
      forwardAgentLine(line, dir);
    }
  });
  child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
  child.on("exit", (code, signal) => {
    if (buffer) forwardAgentLine(buffer, dir);
    agentRun = null;
    if (finished) return;
    const error =
      signal === "SIGTERM" ? null : `Claude Code s'est arrêté (code ${code}). ${stderr.slice(-400)}`.trim();
    sendAgentEvent({ kind: "done", error, stopped: signal === "SIGTERM", costUsd: null, durationMs: null });
  });
}

const renders = createRenderJobs({ runEngine });

function startMcp() {
  const token = loadMcpToken(join(app.getPath("userData"), "mcp-token"));
  const agentProjectDir = () => {
    if (!studio) throw new Error("No project is open in Glintmotion. Call glintmotion_open_project first.");
    return studio.dir;
  };
  const server = startMcpServer({
    token,
    toolCacheFile: join(app.getPath("userData"), "studio-tools.json"),
    window: () => win,
    studioUrl: () => studio?.url ?? null,
    listProjects: () => readRecents().map((r) => projectInfo(r.path, r.openedAt)),
    currentProject: () => (studio ? projectInfo(studio.dir, null) : null),
    openProject: (dir) => openStudio(dir),
    agent: {
      projectDir: agentProjectDir,
      projectInfo: () => (studio ? projectInfo(studio.dir, null) : null),
      runEngine,
      renders,
      generateMusic: composeMusic,
      deliver: (request) => deliverRender({ projectDir: agentProjectDir(), ...request }),
      createProject,
      defaultParent: DEFAULT_PROJECTS_DIR,
    },
  });
  mcp = { url: server.url, token, error: null };
  server.http.on("error", (error) => {
    mcp.error =
      error.code === "EADDRINUSE"
        ? `Le port ${new URL(server.url).port} est déjà pris par une autre application.`
        : error.message;
  });
}

function openConnectWindow() {
  if (connectWin) {
    connectWin.focus();
    return;
  }
  connectWin = new BrowserWindow({
    width: 640,
    height: 680,
    resizable: false,
    title: "Connecter un agent",
    backgroundColor: "#f1f0ec",
    parent: win ?? undefined,
    webPreferences: { preload: join(here, "preload.cjs"), contextIsolation: true, sandbox: true },
  });
  connectWin.on("closed", () => (connectWin = null));
  connectWin.loadFile(join(here, "ui", "connect.html"));
}

const cliTarget = () => join(cliBinDir, "glintmotion");

function cliStatus() {
  let installed = false;
  try {
    installed = lstatSync(CLI_LINK).isSymbolicLink() && readlinkSync(CLI_LINK) === cliTarget();
  } catch {
    installed = false;
  }
  return { installed, link: CLI_LINK };
}

function installCli() {
  mkdirSync(dirname(CLI_LINK), { recursive: true });
  let existing = null;
  try {
    existing = lstatSync(CLI_LINK);
  } catch {
    existing = null;
  }
  if (existing && !existing.isSymbolicLink()) {
    throw new Error(`${CLI_LINK} existe déjà et n'est pas un lien : supprime-le d'abord.`);
  }
  if (existing) rmSync(CLI_LINK);
  symlinkSync(cliTarget(), CLI_LINK);
  return cliStatus();
}

ipcMain.handle("cli:status", () => cliStatus());
ipcMain.handle("cli:install", () => installCli());
ipcMain.handle("mcp:info", () => mcp);
ipcMain.handle("mcp:copy", (_event, value) => clipboard.writeText(String(value)));
ipcMain.handle("mcp:open", () => openConnectWindow());

ipcMain.handle("agent:models", () => AGENT_MODELS);
ipcMain.handle("agent:send", (_event, request) => startAgent(request ?? {}));
ipcMain.handle("agent:stop", () => {
  agentRun?.child.kill("SIGTERM");
});
ipcMain.handle("agent:reset", () => {
  if (studio) agentSessions.delete(studio.dir);
});
const elevenKey = createKeyStore(join(app.getPath("userData"), "elevenlabs.key"), safeStorage);
let musicRunning = false;

function openProjectDir() {
  if (!studio) throw new Error("Aucun projet ouvert.");
  return studio.dir;
}

ipcMain.handle("music:hasKey", () => elevenKey.has());
ipcMain.handle("music:saveKey", (_event, key) => elevenKey.save(key));
ipcMain.handle("music:clearKey", () => elevenKey.clear());
async function composeMusic(request) {
  if (musicRunning) throw new Error("Une musique est déjà en cours de génération.");
  const projectDir = openProjectDir();
  musicRunning = true;
  try {
    return await generateMusic({
      projectDir,
      prompt: request?.prompt,
      seconds: request?.seconds,
      apiKey: elevenKey.read(),
    });
  } finally {
    musicRunning = false;
  }
}
ipcMain.handle("music:generate", (_event, request) => composeMusic(request));
ipcMain.handle("deliver:render", (_event, request) =>
  deliverRender({
    projectDir: openProjectDir(),
    filename: request?.filename,
    preset: request?.preset,
    color: request?.color,
  }),
);
ipcMain.handle("deliver:reveal", (_event, file) => {
  const projectDir = openProjectDir();
  const path = String(file ?? "");
  if (!path.startsWith(join(projectDir, "renders") + "/") || !existsSync(path)) {
    throw new Error("Fichier introuvable dans les rendus du projet.");
  }
  shell.showItemInFolder(path);
});

ipcMain.handle("claude:status", () => claudeStatus());
ipcMain.handle("claude:account", (_event, action) => runClaudeAccount(action));
ipcMain.handle("claude:cancel", () => {
  if (!accountRun) return;
  accountRun.cancelled = true;
  accountRun.child.kill("SIGTERM");
});

function buildMenu() {
  const template = [
    { role: "appMenu" },
    {
      label: "Fichier",
      submenu: [
        { label: "Projets", accelerator: "CmdOrCtrl+Shift+H", click: () => goHome() },
        {
          label: "Ouvrir un projet…",
          accelerator: "CmdOrCtrl+O",
          click: async () => {
            const result = await dialog.showOpenDialog(win, { properties: ["openDirectory"] });
            if (!result.canceled) {
              openStudio(result.filePaths[0]).catch((error) =>
                dialog.showErrorBox(APP_NAME, error.message),
              );
            }
          },
        },
        { type: "separator" },
        { role: "close" },
      ],
    },
    {
      label: "Connecter",
      submenu: [{ label: "Connecter un agent (MCP)…", click: () => openConnectWindow() }],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    title: APP_NAME,
    backgroundColor: "#f1f0ec",
    webPreferences: {
      preload: join(here, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("did-finish-load", () => {
    if (!win.webContents.getURL().startsWith("http://")) return;
    win.webContents.insertCSS(STUDIO_CSS);
    win.webContents.executeJavaScript(STUDIO_JS).catch(() => {});
  });
  win.on("closed", () => {
    stopStudio();
    win = null;
  });

  goHome();
}

app.whenReady().then(() => {
  startMcp();
  buildMenu();
  createWindow();
  app.on("activate", () => {
    if (!win) createWindow();
  });
});

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  stopStudio();
  renders.stopAll();
  accountRun?.child.kill("SIGTERM");
});
