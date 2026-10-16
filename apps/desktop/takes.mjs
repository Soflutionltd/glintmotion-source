import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { probeMedia, runFfmpeg } from "./media.mjs";

/** The engine renders at 30 fps unless the render asks for another rate. */
export const DEFAULT_FPS = 30;
export const MAX_TAKE_SECONDS = 180;
const TAKE_START_TIMEOUT_MS = 15_000;
const MAX_SIDE = 2160;
const ASPECT_TOLERANCE = 0.02;
const TAKES_FOLDER = "assets/rec";
const OFFSET_ATTRIBUTES = ["data-media-start", "data-playback-start"];
const DEFAULT_SETTLE_SECONDS = 3;
const LOCALE = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/;
const BUNDLE_ID = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const even = (value) => Math.max(2, Math.round(value / 2) * 2);
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

function attribute(tag, name) {
  const match = new RegExp(`(?:^|\\s)${escapeRegExp(name)}=(["'])(.*?)\\1`, "s").exec(tag);
  return match ? match[2] : null;
}

function encodeEntities(value, quote) {
  const ampersands = value.replace(/&/g, "&amp;");
  return quote === '"' ? ampersands.replace(/"/g, "&quot;") : ampersands.replace(/'/g, "&#39;");
}

/** The `<video>` tag with this id and the timing it declares, or null. */
export function findVideo(html, id) {
  for (const match of html.matchAll(/<video\b[^>]*>/gs)) {
    const tag = match[0];
    if (attribute(tag, "id") !== id) continue;
    const duration = Number(attribute(tag, "data-duration"));
    return {
      tag,
      index: match.index,
      src: attribute(tag, "src"),
      variable: attribute(tag, "data-var-src"),
      duration: Number.isFinite(duration) && duration > 0 ? duration : null,
    };
  }
  return null;
}

function setAttribute(tag, name, value) {
  const pattern = new RegExp(`((?:^|\\s)${escapeRegExp(name)}=)(["'])(.*?)\\2`, "s");
  return tag.replace(pattern, (_, prefix, quote) => `${prefix}${quote}${encodeEntities(value, quote)}${quote}`);
}

function removeAttribute(tag, name) {
  return tag.replace(new RegExp(`\\s${escapeRegExp(name)}=(["']).*?\\1`, "s"), "");
}

/**
 * Rewrites the default of one string variable inside data-composition-variables, in place, so the
 * rest of the attribute keeps its formatting. Returns null when the variable is not declared.
 */
export function setVariableDefault(html, id, value) {
  const declaration = /(\sdata-composition-variables=)(["'])(.*?)\2/s.exec(html);
  if (!declaration) return null;
  const [whole, prefix, quote, raw] = declaration;
  const q = quote === '"' ? "&quot;" : '"';
  const encode = (text) => encodeEntities(JSON.stringify(text).slice(1, -1), quote);
  const idPattern = new RegExp(`${q}id${q}\\s*:\\s*${q}${escapeRegExp(encode(id))}${q}`);
  const idMatch = idPattern.exec(raw);
  if (!idMatch) return null;
  const objectStart = raw.lastIndexOf("{", idMatch.index);
  const nextId = new RegExp(`${q}id${q}\\s*:`, "g");
  nextId.lastIndex = idMatch.index + idMatch[0].length;
  const objectEnd = nextId.exec(raw)?.index ?? raw.length;
  const segment = raw.slice(objectStart, objectEnd);
  const defaultPattern = new RegExp(`(${q}default${q}\\s*:\\s*${q})((?:(?!${q}).)*)(${q})`, "s");
  if (!defaultPattern.test(segment)) return null;
  const updated = segment.replace(defaultPattern, (_, open, __, close) => `${open}${encode(value)}${close}`);
  const nextRaw = raw.slice(0, objectStart) + updated + raw.slice(objectEnd);
  const at = declaration.index;
  return html.slice(0, at) + `${prefix}${quote}${nextRaw}${quote}` + html.slice(at + whole.length);
}

/**
 * Points the video at `src`: its src, the default of the variable that feeds it, and no leftover
 * offset into the previous file (the new take starts where the scene starts).
 */
export function retargetVideo(html, id, src) {
  const video = findVideo(html, id);
  if (!video) throw new Error(`No <video id="${id}"> in the composition.`);
  let tag =
    attribute(video.tag, "src") === null
      ? video.tag.replace(/^<video\b/, `<video src="${encodeEntities(src, '"')}"`)
      : setAttribute(video.tag, "src", src);
  const clearedOffset = OFFSET_ATTRIBUTES.filter((name) => attribute(tag, name) !== null);
  for (const name of clearedOffset) tag = removeAttribute(tag, name);
  let next = html.slice(0, video.index) + tag + html.slice(video.index + video.tag.length);
  let variableUpdated = false;
  if (video.variable) {
    const withDefault = setVariableDefault(next, video.variable, src);
    if (withDefault !== null) {
      next = withDefault;
      variableUpdated = true;
    }
  }
  return { html: next, variable: video.variable, variableUpdated, clearedOffset };
}

/** The size a new take is encoded at: the previous take's when the framing matches, else the take's own. */
export function targetSize(source, previous) {
  const ratio = source.width / source.height;
  if (previous && Math.abs(previous.width / previous.height - ratio) / ratio <= ASPECT_TOLERANCE) {
    return { width: even(previous.width), height: even(previous.height) };
  }
  const width = previous ? previous.width : source.width;
  const scale = Math.min(1, MAX_SIDE / Math.max(width, width / ratio));
  return { width: even(width * scale), height: even((width / ratio) * scale) };
}

/**
 * ffmpeg arguments: constant frame rate, exact length, the last frame held when the source ends early, and a
 * keyframe every second (the renderer seeks badly past 2 s between keyframes).
 */
export function fitArgs({ source, output, width, height, fps, seconds, from }) {
  return [
    "-y",
    ...(from > 0 ? ["-ss", String(from)] : []),
    "-i",
    source,
    "-vf",
    `fps=${fps},scale=${width}:${height}:flags=lanczos,setsar=1,tpad=stop_mode=clone:stop_duration=${seconds}`,
    "-t",
    String(seconds),
    "-an",
    "-c:v",
    "h264_videotoolbox",
    "-q:v",
    "70",
    "-profile:v",
    "high",
    "-g",
    String(Math.round(fps)),
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    output,
  ];
}

function videoStream(probe) {
  const stream = (probe.streams ?? []).find((candidate) => candidate.codec_type === "video");
  if (!stream?.width || !stream?.height) throw new Error("The file has no video stream.");
  return { width: stream.width, height: stream.height, duration: Number(probe.format?.duration) || null };
}

function insideProject(projectDir, path) {
  const rel = relative(projectDir, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function projectOutput(projectDir, output) {
  const file = join(projectDir, normalize(String(output)));
  if (isAbsolute(String(output)) || !insideProject(projectDir, file)) throw new Error(`output must be a path inside the project, not ${output}.`);
  if (extname(file).toLowerCase() !== ".mp4") throw new Error("output must end in .mp4.");
  return file;
}

function outputName(name, fallback) {
  const base = basename(String(name ?? fallback), extname(String(name ?? fallback))).replace(/[^\p{L}\p{N} _.-]/gu, "-");
  if (!base.trim()) throw new Error("name must contain letters or digits.");
  return `${base}.mp4`;
}

async function encode({ source, output, width, height, fps, seconds, from }) {
  mkdirSync(dirname(output), { recursive: true });
  const partial = join(dirname(output), `.${basename(output)}.part.mp4`);
  try {
    const { code, stderr } = await runFfmpeg(fitArgs({ source, output: partial, width, height, fps, seconds, from }));
    if (code !== 0) throw new Error(`The take could not be encoded. ${stderr.slice(-400)}`.trim());
    renameSync(partial, output);
  } finally {
    rmSync(partial, { force: true });
  }
}

/**
 * Encodes `source` to fit the scene's `<video id>`: its duration, the previous take's size, a constant
 * frame rate. Saved at `output`, else next to the previous take (else assets/rec/), and wired into the
 * composition unless `rewire` is false (a variant fed through the video's variable at render time).
 */
export async function fitVideoIntoScene({
  projectDir,
  source,
  video,
  composition = "index.html",
  name,
  output: outputPath,
  rewire = true,
  from = 0,
  fps = DEFAULT_FPS,
  fallbackName,
}) {
  const compositionFile = join(projectDir, normalize(String(composition)));
  if (!insideProject(projectDir, compositionFile) || !existsSync(compositionFile)) {
    throw new Error(`No composition ${composition} in the project.`);
  }
  const sourceFile = isAbsolute(String(source)) ? String(source) : join(projectDir, normalize(String(source)));
  if (!existsSync(sourceFile) || !statSync(sourceFile).isFile()) throw new Error(`No file at ${source}.`);
  const html = readFileSync(compositionFile, "utf-8");
  const target = findVideo(html, String(video ?? ""));
  if (!target) throw new Error(`No <video id="${video}"> in ${composition}.`);
  if (!target.duration) throw new Error(`<video id="${video}"> has no data-duration to fit the take to.`);

  const previousFile = target.src && !/^[a-z]+:/i.test(target.src) ? join(dirname(compositionFile), normalize(target.src)) : null;
  const previous = previousFile && insideProject(projectDir, previousFile) && existsSync(previousFile) ? videoStream(await probeMedia(previousFile)) : null;
  const take = videoStream(await probeMedia(sourceFile));
  const size = targetSize(take, previous);
  const folder = previous ? dirname(previousFile) : join(projectDir, TAKES_FOLDER);
  const output = outputPath ? projectOutput(projectDir, outputPath) : join(folder, outputName(name, fallbackName ?? basename(sourceFile)));
  const seconds = target.duration;
  await encode({ source: sourceFile, output, ...size, fps, seconds, from });

  const src = relative(dirname(compositionFile), output).split(sep).join("/");
  const rewired = rewire ? retargetVideo(html, String(video), src) : null;
  if (rewired) writeFileSync(compositionFile, rewired.html);
  const usable = take.duration === null ? null : Math.max(0, take.duration - from);
  return {
    output,
    src,
    composition,
    width: size.width,
    height: size.height,
    fps,
    seconds,
    sourceSeconds: take.duration,
    ...(usable !== null && usable < seconds && { heldLastFrameSeconds: Math.round((seconds - usable) * 1000) / 1000 }),
    ...(usable !== null && usable > seconds && { cutSeconds: Math.round((usable - seconds) * 1000) / 1000 }),
    ...(rewired
      ? {
          ...(rewired.variable && { variable: rewired.variable, variableUpdated: rewired.variableUpdated }),
          ...(rewired.clearedOffset.length && { clearedOffset: rewired.clearedOffset }),
        }
      : { rewired: false, ...(target.variable && { variable: target.variable, renderVariables: { [target.variable]: src } }) }),
  };
}

/** Encodes a raw take at its wall-clock length (simctl writes nothing while the screen is still). */
export async function saveTake({ projectDir, source, seconds, name, output: outputPath, from = 0, fps = DEFAULT_FPS }) {
  const take = videoStream(await probeMedia(source));
  const size = targetSize(take, null);
  const output = outputPath ? projectOutput(projectDir, outputPath) : join(projectDir, TAKES_FOLDER, outputName(name, `take-${stamp()}`));
  const length = Math.max(0.1, seconds - from);
  await encode({ source, output, ...size, fps, seconds: length, from });
  return { output, src: relative(projectDir, output).split(sep).join("/"), width: size.width, height: size.height, fps, seconds: length };
}

function bootedSimulators() {
  return new Promise((resolve, reject) => {
    execFile("xcrun", ["simctl", "list", "devices", "booted", "-j"], { timeout: 20_000 }, (error, stdout) => {
      if (error) return reject(new Error(`simctl is not available: ${error.message}`));
      const devices = Object.values(JSON.parse(stdout).devices ?? {}).flat();
      resolve(devices.filter((device) => device.state === "Booted").map(({ udid, name }) => ({ udid, name })));
    });
  });
}

function simctl(args) {
  return new Promise((resolve) => {
    execFile("xcrun", ["simctl", ...args], { timeout: 30_000 }, (error, stdout, stderr) =>
      resolve({ ok: !error, stdout: String(stdout ?? ""), stderr: String(stderr || error?.message || "").trim() }),
    );
  });
}

function simctlSync(args) {
  try {
    const stdout = execFileSync("xcrun", ["simctl", ...args], { timeout: 30_000, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, stdout, stderr: "" };
  } catch (error) {
    return { ok: false, stdout: "", stderr: String(error.stderr || error.message).trim() };
  }
}

/** The entries of a string array printed by `defaults read`, e.g. `( "fr-FR", "en-US" )`. */
export function parseDefaultsArray(output) {
  return output
    .trim()
    .replace(/^\(|\)$/g, "")
    .split(",")
    .map((item) => item.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean);
}

/** The AppleLanguages / AppleLocale pair for `en`, `en-US` or `fr_FR`. */
export function localeDefaults(locale) {
  if (!LOCALE.test(locale)) throw new Error(`locale looks like en, en-US or fr_FR, not ${locale}.`);
  return { languages: [locale.replace(/_/g, "-")], appleLocale: locale.replace(/-/g, "_") };
}

/** simctl commands that set the simulator's language; a null value deletes the key. */
export function languageCommands(udid, { languages, appleLocale }) {
  const write = (key, ...value) => ["spawn", udid, "defaults", "write", "-g", key, ...value];
  const remove = (key) => ["spawn", udid, "defaults", "delete", "-g", key];
  return [
    languages?.length ? write("AppleLanguages", "-array", ...languages) : remove("AppleLanguages"),
    appleLocale ? write("AppleLocale", appleLocale) : remove("AppleLocale"),
  ];
}

const relaunchCommands = (udid, app) => [
  { args: ["terminate", udid, app], optional: true },
  { args: ["launch", udid, app], optional: false },
];

async function runAll(commands) {
  for (const { args, optional } of commands) {
    const run = await simctl(args);
    if (!run.ok && !optional) throw new Error(`simctl ${args[0]} failed: ${run.stderr}`);
  }
}

function runAllSync(commands) {
  const errors = [];
  for (const { args, optional } of commands) {
    const run = simctlSync(args);
    if (!run.ok && !optional) errors.push(`simctl ${args[0]}: ${run.stderr}`);
  }
  return errors;
}

/** What puts the simulator back as it was before the take: its language, then the app relaunched in it. */
function restoreCommands({ device, original, app }) {
  if (!original) return [];
  return [
    ...languageCommands(device.udid, original).map((args) => ({ args, optional: false })),
    ...(app ? relaunchCommands(device.udid, app) : []),
  ];
}

async function restoreDevice(take) {
  const commands = restoreCommands(take);
  if (commands.length === 0) return null;
  try {
    await runAll(commands);
    return { languages: take.original.languages, locale: take.original.appleLocale, relaunched: Boolean(take.app) };
  } catch (error) {
    return { error: error.message };
  }
}

let current = null;
let starting = false;

/**
 * Starts recording a booted simulator's screen. With `locale`, the simulator's language is switched for the
 * take; with `app`, that app is relaunched (in the new language) and given `settle` seconds before recording.
 * Resolves once simctl reports the recording started.
 */
export async function startSimulatorTake({ udid, locale, app, settle = DEFAULT_SETTLE_SECONDS } = {}) {
  if (current || starting) throw new Error(`A take${current ? ` of ${current.device.name}` : ""} is already recording. Stop or cancel it first.`);
  if (app !== undefined && !BUNDLE_ID.test(String(app))) throw new Error(`app is a bundle id like com.example.app, not ${app}.`);
  const wanted = locale ? localeDefaults(String(locale)) : null;
  starting = true;
  try {
    return await beginTake({ udid, wanted, app: app === undefined ? null : String(app), settle });
  } finally {
    starting = false;
  }
}

async function beginTake({ udid, wanted, app, settle }) {
  const booted = await bootedSimulators();
  if (booted.length === 0) throw new Error("No simulator is booted. Boot one first (sim-mirror, or xcrun simctl boot <udid>).");
  const device = udid ? booted.find((candidate) => candidate.udid === udid) : booted.length === 1 ? booted[0] : null;
  if (!device) {
    const list = booted.map((candidate) => `${candidate.name} ${candidate.udid}`).join("; ");
    throw new Error(udid ? `${udid} is not a booted simulator. Booted: ${list}.` : `Several simulators are booted; pass udid. Booted: ${list}.`);
  }

  let original = null;
  if (wanted) {
    const [languages, appleLocale] = await Promise.all([
      simctl(["spawn", device.udid, "defaults", "read", "-g", "AppleLanguages"]),
      simctl(["spawn", device.udid, "defaults", "read", "-g", "AppleLocale"]),
    ]);
    original = {
      languages: languages.ok ? parseDefaultsArray(languages.stdout) : null,
      appleLocale: appleLocale.ok ? appleLocale.stdout.trim() : null,
    };
  }
  const setup = { device, original, app };
  try {
    if (wanted) {
      const languages = [...new Set([...wanted.languages, ...(original.languages ?? [])])];
      await runAll(languageCommands(device.udid, { languages, appleLocale: wanted.appleLocale }).map((args) => ({ args, optional: false })));
    }
    if (app) {
      await runAll(relaunchCommands(device.udid, app));
      await new Promise((resolve) => setTimeout(resolve, Math.min(30, Math.max(0, Number(settle) || 0)) * 1000));
    }
    await record(setup);
    return {
      device,
      maxSeconds: MAX_TAKE_SECONDS,
      ...(wanted && { locale: wanted.appleLocale, restoresOnStop: original }),
      ...(app && { relaunched: app }),
      ...(wanted && !app && { note: "Running apps keep their language until relaunched; pass app to relaunch one." }),
    };
  } catch (error) {
    await restoreDevice(setup);
    throw error;
  }
}

async function record({ device, original, app }) {
  const work = mkdtempSync(join(tmpdir(), "glintmotion-take-"));
  const file = join(work, "take.mp4");
  const child = spawn("xcrun", ["simctl", "io", device.udid, "recordVideo", "--codec", "h264", "--force", file], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  const take = { device, original, app, child, file, work, exited, startedAt: 0, stoppedAt: 0, autoStopped: false, timer: null };
  current = take;
  try {
    await new Promise((resolve, reject) => {
      let stderr = "";
      const timeout = setTimeout(() => reject(new Error("simctl did not start recording within 15 s.")), TAKE_START_TIMEOUT_MS);
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
        if (stderr.includes("Recording started")) {
          clearTimeout(timeout);
          resolve();
        }
      });
      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      exited.then((code) => {
        clearTimeout(timeout);
        reject(new Error(`simctl stopped before recording (code ${code}). ${stderr.slice(-300)}`.trim()));
      });
    });
  } catch (error) {
    child.kill("SIGKILL");
    rmSync(work, { recursive: true, force: true });
    current = null;
    throw error;
  }
  take.startedAt = Date.now();
  take.timer = setTimeout(() => {
    take.autoStopped = true;
    take.stoppedAt = Date.now();
    child.kill("SIGINT");
  }, MAX_TAKE_SECONDS * 1000);
}

/**
 * Stops the take, puts the simulator's language (and the relaunched app) back, and returns the raw file
 * with its wall-clock length. The caller removes `work`.
 */
export async function stopSimulatorTake() {
  const take = current;
  if (!take) throw new Error("No take is recording. Start one with action 'start'.");
  current = null;
  clearTimeout(take.timer);
  if (!take.stoppedAt) {
    take.stoppedAt = Date.now();
    take.child.kill("SIGINT");
  }
  const code = await take.exited;
  const restored = await restoreDevice(take);
  if (!existsSync(take.file)) {
    rmSync(take.work, { recursive: true, force: true });
    throw new Error(`simctl wrote no video (code ${code}).`);
  }
  return {
    file: take.file,
    work: take.work,
    device: take.device,
    seconds: Math.round(take.stoppedAt - take.startedAt) / 1000,
    autoStopped: take.autoStopped,
    ...(restored && { restored }),
  };
}

/** Drops the take being recorded, if any, and puts the simulator back. Synchronous, so it holds at quit. */
export function cancelSimulatorTake() {
  const take = current;
  if (!take) return false;
  current = null;
  clearTimeout(take.timer);
  take.child.kill("SIGKILL");
  rmSync(take.work, { recursive: true, force: true });
  runAllSync(restoreCommands(take));
  return true;
}

export const simulatorTakeRunning = () => current !== null;
