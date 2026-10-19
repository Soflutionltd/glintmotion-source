import {
  app,
  autoUpdater,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  powerMonitor,
  safeStorage,
  shell,
} from "electron";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { copyFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHiggsfieldAccount, HIGGSFIELD_MCP_URL } from "./higgsfield.mjs";
import { loadMcpToken, startMcpServer } from "./mcp.mjs";
import { cancelSimulatorTake } from "./takes.mjs";
import { BUNDLED_FFMPEG_DIR, createKeyStore, deliverRender, generateMusic } from "./media.mjs";
import { probeMotion } from "./motion-probe.mjs";
import { analyzeReference, REFERENCE_DIR, referencePrompt, writeReferenceProject } from "./reference.mjs";
import { createRenderJobs } from "./render-jobs.mjs";
import { installSkills, skillsStatus } from "./skills-install.mjs";
import { CLI_COMMANDS } from "./agent-tools.mjs";
import { createPersistentMap, takeResume, writeResume } from "./session-state.mjs";
import {
  checkSeriesRows,
  copyTemplate,
  readTemplates,
  readVariables,
  seriesCount,
  seriesPrompt,
  setTemplate,
  splitBriefs,
  templatePrompt,
  unknownSeriesKeys,
  writeSeries,
} from "./templates.mjs";
import { createUpdater } from "./updater.mjs";
import { createWhatsNew } from "./whats-new.mjs";
import {
  checkResolution,
  FIRST_VIDEO_PARTS,
  firstVideoPrompt,
  projectNameFor,
  readSiteOrIdea,
  toFeedPost,
} from "./first-video.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const APP_NAME = "Glintmotion";
const DEFAULT_PROJECTS_DIR = join(homedir(), "Movies", APP_NAME);
const DEFAULT_EXPORTS_DIR = join(homedir(), "Movies");
const MAX_RECENTS = 24;
// The studio keeps its layout and the agent chat in localStorage, which is per origin: on a
// new port each launch, every launch would start from nothing.
const STUDIO_PORT = 47_831;

app.setName(APP_NAME);

const engineEntry = app.isPackaged
  ? join(process.resourcesPath, "engine", "node_modules", "@hyperframes", "cli", "bin", "hyperframes.mjs")
  : join(here, "..", "..", "packages", "cli", "bin", "hyperframes.mjs");
const cliBinDir = app.isPackaged ? join(process.resourcesPath, "bin") : join(here, "bin");
const skillsDir = app.isPackaged ? join(process.resourcesPath, "skills") : join(here, "..", "..", "skills");
const CLI_LINK = join(homedir(), ".local", "bin", "glintmotion");
const SKILL_TARGETS = [join(homedir(), ".claude", "skills"), join(homedir(), ".cursor", "skills")];

// Finder launches apps with a minimal PATH. Homebrew's ffmpeg comes first (libx264);
// the bundled LGPL one covers Macs without it.
const bundledChrome = app.isPackaged
  ? join(process.resourcesPath, "chrome", "chrome-headless-shell")
  : null;

const engineEnv = {
  ...process.env,
  PATH: ["/opt/homebrew/bin", "/usr/local/bin", process.env.PATH ?? "/usr/bin:/bin", BUNDLED_FFMPEG_DIR].join(":"),
  ELECTRON_RUN_AS_NODE: "1",
  HYPERFRAMES_NO_TELEMETRY: "1",
  HYPERFRAMES_NO_UPDATE_CHECK: "1",
  // Silences the engine's "keep editing in the HyperFrames desktop app" line.
  HYPERFRAMES_DESKTOP_PROJECT: "1",
  DO_NOT_TRACK: "1",
  NO_COLOR: "1",
};
// A browser the person chose stays theirs; otherwise the build shipped with the app.
if (bundledChrome && existsSync(bundledChrome) && !engineEnv.HYPERFRAMES_BROWSER_PATH && !engineEnv.PRODUCER_HEADLESS_SHELL_PATH) {
  engineEnv.HYPERFRAMES_BROWSER_PATH = bundledChrome;
}

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
const UPDATE_NOTICE_CSS = readFileSync(join(here, "ui", "update-notice.css"), "utf-8");
const UPDATE_NOTICE_JS = readFileSync(join(here, "ui", "update-notice.js"), "utf-8");

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
    series: seriesCount(dir),
  };
}

/** `preferred` when it is free, otherwise any free port. */
function freePort(preferred = 0) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", (error) => {
      if (preferred && error.code === "EADDRINUSE") freePort().then(resolve, reject);
      else reject(error);
    });
    server.listen(preferred, "127.0.0.1", () => {
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

/** `hash` is a studio URL hash (composition, playhead, selection, panel) to reopen at. */
async function openStudio(dir, hash = "") {
  if (!existsSync(join(dir, "index.html"))) {
    throw new Error(`${basename(dir)} n'est pas un projet Glintmotion (pas de index.html).`);
  }
  stopStudio();
  rendererBusy = false;
  const port = await freePort(STUDIO_PORT);
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
  await win.loadURL(`${url}${hash}`);
}

async function goHome(action) {
  stopStudio();
  rendererBusy = false;
  win.setTitle(APP_NAME);
  const hash = action === "new" || action === "tour" ? { hash: action } : {};
  await win.loadFile(join(here, "ui", "index.html"), hash);
}

function createProject({ name, parent, resolution }) {
  const safeName = String(name).trim();
  if (!/^[\p{L}\p{N}][\p{L}\p{N} _.-]*$/u.test(safeName)) {
    throw new Error("Nom invalide : lettres, chiffres, espaces, tirets et points seulement.");
  }
  checkResolution(resolution);
  mkdirSync(parent, { recursive: true });
  const dir = join(parent, safeName);
  if (existsSync(dir)) throw new Error(`Le dossier ${dir} existe déjà.`);

  return new Promise((resolve, reject) => {
    const preset = resolution === "post" ? "portrait" : resolution;
    const args = ["init", safeName, "--example", "blank", "--non-interactive", "--resolution", preset];
    const child = runEngine(args, parent);
    let output = "";
    child.stdout.on("data", (c) => (output += c));
    child.stderr.on("data", (c) => (output += c));
    child.on("exit", (code) => {
      const index = join(dir, "index.html");
      if (code !== 0 || !existsSync(index)) {
        reject(new Error(`La création a échoué (code ${code}).\n${output.slice(-800)}`));
        return;
      }
      if (resolution === "post") writeFileSync(index, toFeedPost(readFileSync(index, "utf-8")));
      resolve(dir);
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
/**
 * project dir -> the request typed on Home, sent by the studio's agent panel once it is up.
 * Kept on disk: the other versions of a series wait until the person opens them.
 */
const pendingPrompts = createPersistentMap(join(app.getPath("userData"), "pending-prompts.json"));
const templatesFile = () => join(app.getPath("userData"), "templates.json");

/**
 * A template that declares variables makes a series as one project whose series.json holds one
 * row per brief. Otherwise: one new project per brief, each a copy of the template; the first opens.
 */
async function startFromTemplate(request) {
  const source = String(request?.dir ?? "");
  if (!readTemplates(templatesFile()).includes(source)) throw new Error("Ce modèle n'existe plus.");
  const briefs = splitBriefs(request?.text, request?.series === true);
  const parent = DEFAULT_PROJECTS_DIR;
  mkdirSync(parent, { recursive: true });
  const variables = request?.series === true ? readVariables(source) : [];
  if (variables.length > 0) {
    const dir = join(parent, projectNameFor({ site: null, idea: `${basename(source)} série`, parent }));
    copyTemplate(source, dir);
    pendingPrompts.set(dir, seriesPrompt(basename(source), briefs, variables));
    await openStudio(dir);
    return;
  }
  const dirs = briefs.map((brief) => {
    const dir = join(parent, projectNameFor({ site: null, idea: brief, parent }));
    copyTemplate(source, dir);
    pendingPrompts.set(dir, templatePrompt(basename(source), brief));
    return dir;
  });
  for (const dir of dirs.slice(1).reverse()) rememberProject(dir);
  await openStudio(dirs[0]);
}

/** A series project written straight from rows of variable values (an agent's glintmotion_create_series). */
function createSeriesFromRows({ template, rows, name }) {
  const source = readTemplates(templatesFile()).find((dir) => dir === template || basename(dir) === template);
  if (!source) throw new Error(`No template "${template}". glintmotion_list_templates lists them.`);
  const variables = readVariables(source);
  if (variables.length === 0) {
    throw new Error(`${basename(source)} declares no data-composition-variables, so a series cannot vary it.`);
  }
  checkSeriesRows(rows);
  const parent = DEFAULT_PROJECTS_DIR;
  mkdirSync(parent, { recursive: true });
  const idea = String(name ?? "").trim() || `${basename(source)} série`;
  const dir = join(parent, projectNameFor({ site: null, idea, parent }));
  copyTemplate(source, dir);
  writeSeries(dir, rows);
  rememberProject(dir);
  return { dir, unknown: unknownSeriesKeys(rows, variables) };
}

/** Home's prompt box (`text` alone) or the four-part card (`picks` plus a site or an idea). */
async function startFromHome(request) {
  const resolution = checkResolution(request?.resolution);
  const text = String(request?.text ?? "").trim();
  const source = readSiteOrIdea(text);
  const prompt = request?.picks ? firstVideoPrompt({ picks: request.picks, ...source }) : text;
  if (!prompt) throw new Error("Décris la vidéo que tu veux.");
  const parent = DEFAULT_PROJECTS_DIR;
  const dir = await createProject({ name: projectNameFor({ ...source, parent }), parent, resolution });
  pendingPrompts.set(dir, prompt);
  await openStudio(dir);
}

function runEngineCaptured(args, cwd) {
  return new Promise((resolve) => {
    const child = runEngine(args, cwd);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", (error) => resolve({ code: -1, stdout, stderr: `${stderr}${error.message}` }));
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

async function pickReference() {
  const picked = await dialog.showOpenDialog(win, {
    title: "Vidéo à reprendre",
    defaultPath: homedir(),
    properties: ["openFile"],
    filters: [{ name: "Vidéos", extensions: ["mp4", "mov", "m4v", "webm"] }],
  });
  return picked.canceled ? null : picked.filePaths[0];
}

/** Home's « Refaire un montage »: a project cut like the picked video, its shots waiting for footage. */
async function startFromReference(source) {
  const file = String(source ?? "");
  if (!existsSync(file) || !statSync(file).isFile()) throw new Error("Cette vidéo n'existe plus.");
  const work = mkdtempSync(join(tmpdir(), "glintmotion-reference-"));
  try {
    const sheet = join(work, "shots.jpg");
    const runBeats = (dir) => runEngineCaptured(["beats", "--json"], dir);
    const analysis = await analyzeReference({ file, sheet, runBeats });
    if (analysis.shotCount < 2) throw new Error("Aucune coupe trouvée dans cette vidéo : il n'y a pas de montage à reprendre.");
    const parent = DEFAULT_PROJECTS_DIR;
    const name = projectNameFor({ site: null, idea: `Remake ${basename(file, extname(file))}`, parent });
    const resolution = analysis.resolution;
    const dir = await createProject({ name, parent, resolution });
    const built = await writeReferenceProject({ dir, analysis, resolution, title: name });
    await copyFile(sheet, join(dir, REFERENCE_DIR, "shots.jpg"));
    pendingPrompts.set(dir, referencePrompt({ source: basename(file), analysis, built }));
    await openStudio(dir);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

ipcMain.handle("home:firstVideoParts", () => FIRST_VIDEO_PARTS);
ipcMain.handle("home:start", (_event, request) => startFromHome(request));
ipcMain.handle("home:pickReference", () => pickReference());
ipcMain.handle("home:reference", (_event, file) => startFromReference(file));
const listTemplates = () => readTemplates(templatesFile()).map((dir) => projectInfo(dir, null));
ipcMain.handle("templates:list", listTemplates);
ipcMain.handle("templates:set", (_event, request) =>
  setTemplate(templatesFile(), String(request?.dir ?? ""), request?.on === true),
);
ipcMain.handle("templates:use", (_event, request) => startFromTemplate(request));
function knownProject(dir) {
  const path = String(dir ?? "");
  if (!readRecents().some((recent) => recent.path === path)) throw new Error("Ce projet n'est plus dans la liste.");
  return path;
}
ipcMain.handle("series:export", (_event, dir) => renders.start(knownProject(dir), { series: true }));
ipcMain.handle("series:status", (_event, dir) => renders.latestFor(knownProject(dir)));
ipcMain.handle("series:reveal", (_event, dir) => {
  const first = renders.latestFor(knownProject(dir))?.outputs?.[0];
  if (first) shell.showItemInFolder(first);
});
ipcMain.handle("agent:takePending", () => {
  if (!studio) return null;
  const prompt = pendingPrompts.get(studio.dir) ?? null;
  pendingPrompts.delete(studio.dir);
  return prompt;
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
  `Before animating text, read ${join(skillsDir, "motion-quality", "SKILL.md")}: moderate eases for text moving on y, scale text from its baseline, no will-change on scaled text.`,
  "`glintmotion check` reports them as gsap_ease_freezes_on_frame_clock, gsap_text_scale_center_origin and will_change_scaled_text: fix those warnings.",
  "Do not render: the person exports from the studio.",
  "Glintmotion's own tools are there as MCP tools (mcp__glintmotion__*): studio_look and studio_inspect to find elements, the other studio_* tools to edit them live,",
  "glintmotion_contact_sheet to see the whole video, glintmotion_motion_check after animating text,",
  "and glintmotion_session begin/end around your changes so the person can undo them in one step.",
  "In a series project (series.json, one row of variables per version), glintmotion_series_sheet shows every version side by side.",
  "When mcp__higgsfield__* tools are present, the person has connected their Higgsfield account: generate the video or image they ask for with their credits,",
  "then glintmotion_import_media with the result URL and glintmotion_fit_video to place a clip in a scene.",
].join(" ");
const AGENT_ALLOWED_TOOLS = [
  "Bash(npm run check)",
  "Bash(glintmotion capture *)",
  "mcp__glintmotion__*",
  "mcp__higgsfield__*",
  ...CLI_COMMANDS.flatMap((command) => [`Bash(glintmotion ${command})`, `Bash(glintmotion ${command} *)`]),
];

// Switching project would kill the agent; exporting, publishing and paid music stay with the person.
const AGENT_BLOCKED_TOOLS = [
  "glintmotion_open_project",
  "glintmotion_create_project",
  "glintmotion_create_series",
  "glintmotion_render",
  "glintmotion_render_cancel",
  "glintmotion_deliver",
  "glintmotion_upload",
  "glintmotion_generate_music",
].map((name) => `mcp__glintmotion__${name}`);

/** The token goes in a private file rather than argv, where `ps` would show it. */
const higgsfield = createHiggsfieldAccount({
  file: join(app.getPath("userData"), "higgsfield.bin"),
  safeStorage,
  openExternal: (url) => shell.openExternal(url),
});

async function agentMcpArgs() {
  if (!mcp || mcp.error) return [];
  const file = join(app.getPath("userData"), "agent-mcp.json");
  const servers = { glintmotion: { type: "http", url: mcp.url, headers: { Authorization: `Bearer ${mcp.token}` } } };
  const higgsfieldToken = await higgsfield.accessToken();
  if (higgsfieldToken) {
    servers.higgsfield = { type: "http", url: HIGGSFIELD_MCP_URL, headers: { Authorization: `Bearer ${higgsfieldToken}` } };
  }
  writeFileSync(file, JSON.stringify({ mcpServers: servers }), { mode: 0o600 });
  chmodSync(file, 0o600);
  return ["--mcp-config", file, "--strict-mcp-config", "--disallowedTools", ...AGENT_BLOCKED_TOOLS];
}

/** @type {{ child: import("node:child_process").ChildProcess, dir: string } | null} */
let agentRun = null;
/** project dir -> Claude Code session id, kept on disk so a chat goes on after a restart. */
const agentSessions = createPersistentMap(join(app.getPath("userData"), "agent-sessions.json"));

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
        sendAgentEvent({
          kind: "tool",
          name: block.name.replace(/^mcp__glintmotion__/, "").replace(/^mcp__higgsfield__/, "higgsfield · "),
          target: String(target).replace(`${dir}/`, ""),
        });
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

async function startAgent({ prompt, model }) {
  if (!studio) throw new Error("Aucun projet ouvert.");
  if (agentRun) throw new Error("L'agent travaille déjà sur une demande.");
  const text = String(prompt ?? "").trim();
  if (!text) throw new Error("Demande vide.");
  if (!AGENT_MODELS.includes(model)) throw new Error(`Modèle inconnu : ${model}`);

  const claude = findClaude();
  const dir = studio.dir;
  const mcpArgs = await agentMcpArgs();
  if (agentRun) throw new Error("L'agent travaille déjà sur une demande.");
  if (studio?.dir !== dir) throw new Error("Le projet a changé pendant le lancement de l'agent.");
  const args = [
    "-p",
    text,
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    model,
    ...mcpArgs,
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

const renders = createRenderJobs({
  // The studio extracts an idle project's video frames ahead of time; an export in its own
  // process would extract them a second time alongside, so the studio stops first.
  runEngine: (args, cwd) => {
    if (studio?.url) fetch(new URL("/api/export-preparation/pause", studio.url), { method: "POST" }).catch(() => {});
    return runEngine(args, cwd);
  },
  workerMemory: createPersistentMap(join(app.getPath("userData"), "render-workers.json")),
});

let motionRun = null;
async function checkMotion(request) {
  if (!studio?.url) throw new Error("No project is open in Glintmotion. Call glintmotion_open_project first.");
  if (motionRun) throw new Error("A motion check is already running. Wait for it to finish.");
  const info = projectInfo(studio.dir, null);
  if (!info.width || !info.height) throw new Error("index.html has no data-width/data-height on its root.");
  const url = new URL(`/api/projects/${encodeURIComponent(basename(studio.dir))}/preview?hf-capture=1`, studio.url);
  motionRun = probeMotion({ url: url.href, width: info.width, height: info.height, ...request });
  try {
    return await motionRun;
  } finally {
    motionRun = null;
  }
}

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
      motionProbe: checkMotion,
      generateMusic: composeMusic,
      deliver: (request) => trackDelivery(deliverRender({ projectDir: agentProjectDir(), ...request })),
      createProject,
      defaultParent: DEFAULT_PROJECTS_DIR,
      effectsCacheFile: join(app.getPath("userData"), "effects-catalog.json"),
      listTemplates: () => listTemplates().map((info) => ({ ...info, variables: readVariables(info.path) })),
      createSeries: createSeriesFromRows,
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
ipcMain.handle("skills:status", () => skillsStatus(skillsDir, SKILL_TARGETS));
ipcMain.handle("skills:install", () =>
  installSkills(skillsDir, SKILL_TARGETS, new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")),
);
ipcMain.handle("mcp:info", () => mcp);
ipcMain.handle("mcp:copy", (_event, value) => clipboard.writeText(String(value)));
ipcMain.handle("mcp:open", () => openConnectWindow());
ipcMain.handle("higgsfield:status", () => higgsfield.status());
ipcMain.handle("higgsfield:connect", () => higgsfield.connect());
ipcMain.handle("higgsfield:disconnect", () => higgsfield.disconnect());

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
ipcMain.handle("motion:check", () => checkMotion({}));
const EXPORT_KINDS = { mp4: "Vidéo MP4", mov: "Vidéo QuickTime", webm: "Vidéo WebM" };
/** project dir -> folder its last export went to. */
const exportDirs = createPersistentMap(join(app.getPath("userData"), "export-dirs.json"));
/** One-use id -> path the person picked; the studio never names a destination itself. */
const exportTargets = new Map();
const savedExports = new Set();

async function chooseExportTarget(request) {
  const projectDir = openProjectDir();
  const format = Object.hasOwn(EXPORT_KINDS, request?.format) ? request.format : "mp4";
  const suffix = /^[a-z]+$/.test(request?.suffix ?? "") ? `_${request.suffix}` : "";
  const folder = exportDirs.get(projectDir) ?? DEFAULT_EXPORTS_DIR;
  const result = await dialog.showSaveDialog(win, {
    title: "Où enregistrer l'export ?",
    buttonLabel: "Exporter",
    defaultPath: join(existsSync(folder) ? folder : homedir(), `${basename(projectDir)}${suffix}.${format}`),
    filters: [{ name: EXPORT_KINDS[format], extensions: [format] }],
    properties: ["createDirectory", "showOverwriteConfirmation"],
  });
  if (result.canceled || !result.filePath) return null;
  exportDirs.set(projectDir, dirname(result.filePath));
  const id = randomUUID();
  exportTargets.set(id, { projectDir, path: result.filePath });
  return { id, path: result.filePath };
}

function takeExportTarget(id) {
  const target = exportTargets.get(String(id));
  if (!target) throw new Error("Destination d'export inconnue : choisis-la à nouveau.");
  exportTargets.delete(String(id));
  return target;
}

function announceExport(path) {
  savedExports.add(path);
  if (Notification.isSupported()) {
    const notice = new Notification({ title: "Export enregistré", body: basename(path), silent: true });
    notice.on("click", () => shell.showItemInFolder(path));
    notice.show();
  }
  return path;
}

/** Same volume: APFS clones the file instantly instead of copying it. */
async function copyToTarget(source, target) {
  await copyFile(source, target.path, fsConstants.COPYFILE_FICLONE);
  return announceExport(target.path);
}

/** The frame the studio shows, at full size, as a JPEG or a PNG: the extension picked decides. */
async function exportImage(request) {
  if (!studio?.url) throw new Error("Ouvre un projet d'abord.");
  const projectDir = studio.dir;
  const composition = String(request?.composition || "index.html");
  const time = Number(request?.time);
  if (!/^[\p{L}\p{N} _./-]+\.html$/u.test(composition) || composition.split("/").includes("..")) {
    throw new Error(`Composition invalide : ${composition}`);
  }
  if (!Number.isFinite(time) || time < 0) throw new Error("Instant invalide.");

  const stem = composition === "index.html" ? basename(projectDir) : basename(composition, ".html");
  const folder = exportDirs.get(projectDir) ?? DEFAULT_EXPORTS_DIR;
  const result = await dialog.showSaveDialog(win, {
    title: "Où enregistrer l'image ?",
    buttonLabel: "Exporter",
    defaultPath: join(existsSync(folder) ? folder : homedir(), `${stem} ${time.toFixed(1)} s.jpg`),
    filters: [
      { name: "Image JPEG", extensions: ["jpg", "jpeg"] },
      { name: "Image PNG", extensions: ["png"] },
    ],
    properties: ["createDirectory", "showOverwriteConfirmation"],
  });
  if (result.canceled || !result.filePath) return null;
  const png = extname(result.filePath).toLowerCase() === ".png";
  const path = png || /\.jpe?g$/i.test(result.filePath) ? result.filePath : `${result.filePath}.jpg`;
  exportDirs.set(projectDir, dirname(path));

  const encoded = composition.split("/").map(encodeURIComponent).join("/");
  const url = new URL(`/api/projects/${encodeURIComponent(basename(projectDir))}/thumbnail/${encoded}`, studio.url);
  url.search = new URLSearchParams({ t: String(time), format: "png", output: "source" }).toString();
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Le studio n'a pas pu capturer l'image (HTTP ${response.status}).`);
  const frame = Buffer.from(await response.arrayBuffer());
  if (png) {
    await writeFile(path, frame);
  } else {
    const image = nativeImage.createFromBuffer(frame);
    if (image.isEmpty()) throw new Error("Le studio a renvoyé une image illisible.");
    await writeFile(path, image.toJPEG(92));
  }
  return announceExport(path);
}

/** The studio does not wait on this call: every failure is told to the person here. */
async function saveExport(request) {
  try {
    const target = takeExportTarget(request?.id);
    const name = basename(String(request?.filename ?? ""));
    const source = join(target.projectDir, "renders", name);
    if (!name || name !== request.filename || !existsSync(source)) throw new Error(`Rendu introuvable : ${name}`);
    return await copyToTarget(source, target);
  } catch (error) {
    await dialog.showMessageBox(win ?? undefined, {
      type: "error",
      message: "L'export n'a pas pu être enregistré à l'endroit choisi.",
      detail: `${error.message}\n\nIl reste dans le dossier renders du projet.`,
    });
    return null;
  }
}

ipcMain.handle("exports:choose", (_event, request) => chooseExportTarget(request));
ipcMain.handle("exports:save", (_event, request) => saveExport(request));
ipcMain.handle("exports:image", (_event, request) => exportImage(request));
ipcMain.handle("deliver:render", async (_event, request) => {
  const target = takeExportTarget(request?.target);
  const output = await trackDelivery(
    deliverRender({
      projectDir: target.projectDir,
      filename: request?.filename,
      preset: request?.preset,
      color: request?.color,
    }),
  );
  return copyToTarget(output, target);
});
ipcMain.handle("deliver:reveal", (_event, file) => {
  const path = String(file ?? "");
  if (!savedExports.has(path) || !existsSync(path)) throw new Error("Fichier introuvable.");
  shell.showItemInFolder(path);
});

ipcMain.handle("claude:status", () => claudeStatus());
ipcMain.handle("claude:account", (_event, action) => runClaudeAccount(action));
ipcMain.handle("claude:cancel", () => {
  if (!accountRun) return;
  accountRun.cancelled = true;
  accountRun.child.kill("SIGTERM");
});

/** Playback or a studio export, as the studio reports it. */
let rendererBusy = false;
let deliveries = 0;
function trackDelivery(promise) {
  deliveries++;
  return promise.finally(() => deliveries--);
}

const resumeFile = () => join(app.getPath("userData"), "resume.json");
const PREPARE_TIMEOUT_MS = 8_000;

/** Lets the studio write its pending edits to disk; a studio that never answers is not waited on forever. */
function prepareStudio() {
  if (!win || !studio?.url || !win.webContents.getURL().startsWith(studio.url)) return Promise.resolve();
  const id = `${Date.now()}`;
  return new Promise((resolve) => {
    const done = (_event, answered) => {
      if (answered !== id) return;
      clearTimeout(timer);
      ipcMain.removeListener("updates:prepared", done);
      resolve();
    };
    const timer = setTimeout(() => done(null, id), PREPARE_TIMEOUT_MS);
    ipcMain.on("updates:prepared", done);
    win.webContents.send("updates:prepare", id);
  });
}

const updater = createUpdater({
  updater: autoUpdater,
  enabled: app.isPackaged,
  isBusy: () =>
    Boolean(agentRun || motionRun || musicRunning || accountRun || deliveries > 0 || rendererBusy) ||
    renders.list().some((job) => job.status === "running"),
  idleSeconds: () => powerMonitor.getSystemIdleTime(),
  prepareRestart: async () => {
    await prepareStudio();
    const url = win && studio?.url ? win.webContents.getURL() : "";
    writeResume(resumeFile(), { dir: studio?.dir ?? null, hash: url ? new URL(url).hash : "" });
  },
  onState: (state) => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send("updates:state", state);
  },
});
ipcMain.handle("updates:state", () => updater.state());
ipcMain.handle("updates:restart", () => updater.requestRestart());
ipcMain.on("updates:busy", (event, busy) => {
  if (event.sender === win?.webContents) rendererBusy = Boolean(busy);
});

const whatsNew = createWhatsNew({
  here,
  parent: () => win,
  version: app.getVersion(),
  seenFile: join(app.getPath("userData"), "whats-new-seen.json"),
});

/** After an update restart: the project, composition, playhead and selection the person left. */
async function resumeAfterUpdate() {
  const resume = takeResume(resumeFile());
  if (resume) await openStudio(resume.dir, resume.hash);
}

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
    {
      role: "help",
      submenu: [
        {
          label: "Quoi de neuf dans Glintmotion",
          click: () => whatsNew.showAll().catch((error) => dialog.showErrorBox(APP_NAME, error.message)),
        },
        {
          label: "Visite guidée",
          click: () => goHome("tour").catch((error) => dialog.showErrorBox(APP_NAME, error.message)),
        },
      ],
    },
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
    win.webContents.insertCSS(STUDIO_CSS + UPDATE_NOTICE_CSS);
    win.webContents.executeJavaScript(STUDIO_JS + UPDATE_NOTICE_JS).catch(() => {});
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
  resumeAfterUpdate().catch((error) => dialog.showErrorBox(APP_NAME, error.message));
  updater.start();
  // Offline at launch: the notes stay unseen and show on the next launch.
  whatsNew.showIfUpdated().catch(() => {});
  app.on("activate", () => {
    if (!win) createWindow();
  });
});

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  stopStudio();
  renders.stopAll();
  cancelSimulatorTake();
  accountRun?.child.kill("SIGTERM");
});
