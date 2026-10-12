import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const APP_NAME = "Glintmotion";
const DEFAULT_PROJECTS_DIR = join(homedir(), "Movies", APP_NAME);
const MAX_RECENTS = 24;

app.setName(APP_NAME);

const engineEntry = app.isPackaged
  ? join(process.resourcesPath, "engine", "node_modules", "@hyperframes", "cli", "bin", "hyperframes.mjs")
  : join(here, "..", "..", "packages", "cli", "bin", "hyperframes.mjs");

// Finder launches apps with a minimal PATH; the engine needs Homebrew's ffmpeg.
const engineEnv = {
  ...process.env,
  PATH: ["/opt/homebrew/bin", "/usr/local/bin", process.env.PATH ?? "/usr/bin:/bin"].join(":"),
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
/** @type {{ child: import("node:child_process").ChildProcess, dir: string } | null} */
let studio = null;

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
  studio = { child, dir };

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

  rememberProject(dir);
  win.setTitle(`${APP_NAME} · ${basename(dir)}`);
  await win.loadURL(url);
}

async function goHome() {
  stopStudio();
  win.setTitle(APP_NAME);
  await win.loadFile(join(here, "ui", "index.html"));
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
ipcMain.handle("app:home", () => goHome());

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
  buildMenu();
  createWindow();
  app.on("activate", () => {
    if (!win) createWindow();
  });
});

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => stopStudio());
