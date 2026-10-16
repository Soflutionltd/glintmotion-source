#!/usr/bin/env node
// Times full renders of the same compositions with the installed Glintmotion app's engine and with
// upstream HyperFrames, on one Mac, with the same Chrome and the same ffmpeg, then writes the medians.
//
//   npm i --prefix /tmp/hf-upstream hyperframes@<version>
//   node scripts/bench-vs-hyperframes.mjs --upstream /tmp/hf-upstream --runs 3 --out /tmp/bench/results.json \
//     /tmp/bench/comps/logo-reel /tmp/bench/comps/social-reel
//
// --curve 10,20,30 also renders the longest composition cut to those lengths (render time against
// video length, same content). --curve-only adds that curve to an existing --out file for the first
// composition given.
//
// Compositions are rendered in place: point it at copies, the engines write caches next to index.html.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const APP = "/Applications/Glintmotion.app";
const APP_BINARY = join(APP, "Contents/MacOS/Glintmotion");
const APP_ENGINE = join(APP, "Contents/Resources/engine/node_modules/@hyperframes/cli/bin/hyperframes.mjs");
const APP_CHROME = join(APP, "Contents/Resources/chrome/chrome-headless-shell");
const COOLDOWN_MS = 5000;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    upstream: { type: "string" },
    runs: { type: "string", default: "3" },
    out: { type: "string" },
    partial: { type: "string", default: "10-14" },
    curve: { type: "string" },
    "curve-only": { type: "boolean", default: false },
  },
});
if (!values.upstream || !values.out || positionals.length === 0) {
  console.error("Usage: --upstream <dir with hyperframes installed> --out <results.json> <composition dir>...");
  process.exit(2);
}
for (const file of [APP_BINARY, APP_ENGINE, APP_CHROME]) {
  if (!existsSync(file)) throw new Error(`Missing ${file}: install Glintmotion in /Applications first.`);
}
const upstreamEntry = join(resolve(values.upstream), "node_modules/hyperframes/bin/hyperframes.mjs");
if (!existsSync(upstreamEntry)) throw new Error(`Missing ${upstreamEntry}.`);
const runs = Number(values.runs);
const [partialFrom, partialTo] = values.partial.split("-").map(Number);
const outDir = join(resolve(values.out, ".."), "renders");
mkdirSync(outDir, { recursive: true });

const env = {
  ...process.env,
  PATH: ["/opt/homebrew/bin", "/usr/local/bin", process.env.PATH ?? "/usr/bin:/bin"].join(":"),
  HYPERFRAMES_BROWSER_PATH: APP_CHROME,
  HYPERFRAMES_NO_TELEMETRY: "1",
  HYPERFRAMES_NO_UPDATE_CHECK: "1",
  HYPERFRAMES_DESKTOP_PROJECT: "1",
  DO_NOT_TRACK: "1",
  NO_COLOR: "1",
};

const ENGINES = {
  glintmotion: { command: APP_BINARY, entry: APP_ENGINE, flags: [], env: { ELECTRON_RUN_AS_NODE: "1" } },
  hyperframes: { command: process.execPath, entry: upstreamEntry, flags: [], env: {} },
  "hyperframes-gpu": { command: process.execPath, entry: upstreamEntry, flags: ["--gpu"], env: {} },
};

const packageVersion = (entry) => JSON.parse(readFileSync(join(entry, "../../package.json"), "utf-8")).version;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const median = (list) => {
  const sorted = [...list].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const round = (value, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;

function run(command, args, extraEnv, cwd) {
  return new Promise((done, fail) => {
    const started = performance.now();
    const child = spawn(command, args, { cwd, env: { ...env, ...extraEnv }, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", fail);
    child.on("exit", (code) => {
      const seconds = (performance.now() - started) / 1000;
      if (code === 0) done(seconds);
      else fail(new Error(`${basename(command)} ${args.slice(0, 3).join(" ")} exited ${code}\n${stderr.slice(-1500)}`));
    });
  });
}

async function render(engineName, dir, output, extra = []) {
  const engine = ENGINES[engineName];
  const args = [engine.entry, "render", "-o", output, ...engine.flags, ...extra];
  return run(engine.command, args, engine.env, dir);
}

function compositionInfo(dir) {
  const html = readFileSync(join(dir, "index.html"), "utf-8");
  const attribute = (name) => Number(html.match(new RegExp(`data-${name}="([0-9.]+)"`))?.[1]);
  return { name: basename(dir), duration: attribute("duration"), width: attribute("width"), height: attribute("height") };
}

/** Average PSNR in dB of `file` against `reference`, frame by frame. */
function measurePsnr(file, reference) {
  const { status, stderr } = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-i", file, "-i", reference, "-lavfi", "psnr", "-f", "null", "-"],
    { env, encoding: "utf-8" },
  );
  if (status !== 0) throw new Error(`PSNR of ${file} failed.\n${stderr.slice(-800)}`);
  const value = stderr.match(/PSNR .* average:([0-9.]+|inf)/)?.[1];
  if (value === undefined) throw new Error(`No PSNR in ffmpeg's output for ${file}.`);
  return value === "inf" ? Infinity : Number(value);
}

/** A copy of `composition` whose root lasts `seconds`, so every engine renders only its first `seconds`. */
function cutCopy(composition, seconds) {
  const dir = `${composition.dir}-${seconds}s`;
  rmSync(dir, { recursive: true, force: true });
  cpSync(composition.dir, dir, { recursive: true });
  const file = join(dir, "index.html");
  const html = readFileSync(file, "utf-8");
  const root = html.match(/<[a-z]+\b[^>]*\bdata-composition-id="[^"]+"[^>]*>/);
  if (!root || !/\bdata-duration="[0-9.]+"/.test(root[0])) throw new Error(`${file}: no root data-duration to cut.`);
  const cut = root[0].replace(/\bdata-duration="[0-9.]+"/, `data-duration="${seconds}"`);
  writeFileSync(file, html.replace(root[0], cut));
  return dir;
}

/** Same video cut to each length: render time against video length, with nothing else changing. */
async function measureCurve(composition, lengths, fullMedians) {
  const dirs = Object.fromEntries(lengths.map((seconds) => [seconds, cutCopy(composition, seconds)]));
  const timings = Object.fromEntries(lengths.map((seconds) => [seconds, Object.fromEntries(Object.keys(ENGINES).map((e) => [e, []]))]));
  for (let n = 1; n <= runs; n++) {
    for (const seconds of lengths) {
      for (const engine of Object.keys(ENGINES)) {
        await sleep(COOLDOWN_MS);
        const time = await render(engine, dirs[seconds], join(outDir, `${composition.name}-${seconds}s-${engine}-${n}.mp4`));
        timings[seconds][engine].push(time);
        console.error(`curve run ${n} ${composition.name} ${seconds} s ${engine}: ${time.toFixed(1)} s`);
      }
    }
  }
  for (const dir of Object.values(dirs)) rmSync(dir, { recursive: true, force: true });
  const points = lengths.map((seconds) => ({
    seconds,
    runs: Object.fromEntries(Object.entries(timings[seconds]).map(([engine, list]) => [engine, list.map((s) => round(s))])),
    medianSeconds: Object.fromEntries(Object.entries(timings[seconds]).map(([engine, list]) => [engine, round(median(list))])),
  }));
  points.push({ seconds: composition.duration, medianSeconds: fullMedians });
  return { composition: composition.name, points };
}

const compositions = positionals.map((dir) => ({ dir: resolve(dir), ...compositionInfo(resolve(dir)) }));
const curveLengths = values.curve ? values.curve.split(",").map(Number) : [];
if (curveLengths.some((seconds) => !(seconds > 0))) throw new Error("--curve takes lengths in seconds, like 10,20,30.");

if (values["curve-only"]) {
  const report = JSON.parse(readFileSync(values.out, "utf-8"));
  const composition = compositions[0];
  const full = report.compositions.find((c) => c.name === composition.name);
  if (!full) throw new Error(`${values.out} has no full-length timings for ${composition.name}.`);
  report.curve = await measureCurve(composition, curveLengths, full.medianSeconds);
  writeFileSync(values.out, `${JSON.stringify(report, null, 2)}\n`);
  console.error(`Added the curve to ${values.out}`);
  process.exit(0);
}

const results = Object.fromEntries(compositions.map((c) => [c.name, Object.fromEntries(Object.keys(ENGINES).map((e) => [e, []]))]));

console.error("Warm-up…");
for (const engine of Object.keys(ENGINES)) {
  await render(engine, compositions.at(-1).dir, join(outDir, `warmup-${engine}.mp4`));
}

for (let n = 1; n <= runs; n++) {
  for (const composition of compositions) {
    for (const engine of Object.keys(ENGINES)) {
      await sleep(COOLDOWN_MS);
      const output = join(outDir, `${composition.name}-${engine}-${n}.mp4`);
      const seconds = await render(engine, composition.dir, output);
      results[composition.name][engine].push(seconds);
      console.error(`run ${n} ${composition.name} ${engine}: ${seconds.toFixed(1)} s`);
    }
  }
}

const partialRuns = [];
const longest = compositions.reduce((a, b) => (b.duration > a.duration ? b : a));
for (let n = 1; n <= runs; n++) {
  await sleep(COOLDOWN_MS);
  const output = join(outDir, `${longest.name}-partial-${n}.mp4`);
  partialRuns.push(await render("glintmotion", longest.dir, output, ["--from", String(partialFrom), "--to", String(partialTo)]));
}

const report = {
  measured: new Date().toISOString().slice(0, 10),
  machine: {
    model: execFileSync("sysctl", ["-n", "hw.model"], { encoding: "utf-8" }).trim(),
    chip: cpus()[0]?.model ?? "",
    cores: cpus().length,
    memoryGB: Math.round(totalmem() / 2 ** 30),
    macOS: execFileSync("sw_vers", ["-productVersion"], { encoding: "utf-8" }).trim(),
  },
  versions: {
    glintmotion: execFileSync("defaults", ["read", join(APP, "Contents/Info.plist"), "CFBundleShortVersionString"], { encoding: "utf-8" }).trim(),
    glintmotionEngine: packageVersion(APP_ENGINE),
    hyperframes: packageVersion(upstreamEntry),
  },
  method: `${runs} runs per engine, interleaved, median kept; same Chrome (${basename(APP_CHROME)} from the app) and the same ffmpeg for every engine; default render settings, plus upstream with --gpu.`,
  compositions: compositions.map((composition) => {
    const timings = results[composition.name];
    const medians = Object.fromEntries(Object.entries(timings).map(([engine, list]) => [engine, round(median(list))]));
    const reference = join(outDir, `${composition.name}-hyperframes-1.mp4`);
    const quality = Object.fromEntries(
      Object.keys(ENGINES)
        .filter((engine) => engine !== "hyperframes")
        .map((engine) => [engine, round(measurePsnr(join(outDir, `${composition.name}-${engine}-1.mp4`), reference), 1)]),
    );
    const sizes = Object.fromEntries(
      Object.keys(ENGINES).map((engine) => [engine, round(statSync(join(outDir, `${composition.name}-${engine}-1.mp4`)).size / 2 ** 20, 1)]),
    );
    return {
      name: composition.name,
      durationSeconds: composition.duration,
      size: `${composition.width}×${composition.height}`,
      runs: Object.fromEntries(Object.entries(timings).map(([engine, list]) => [engine, list.map((s) => round(s))])),
      medianSeconds: medians,
      speedup: round(medians.hyperframes / medians.glintmotion),
      speedupVsGpu: round(medians["hyperframes-gpu"] / medians.glintmotion),
      psnrVsHyperframesCpu: quality,
      fileMB: sizes,
    };
  }),
  partial: {
    composition: longest.name,
    from: partialFrom,
    to: partialTo,
    runs: partialRuns.map((s) => round(s)),
    medianSeconds: round(median(partialRuns)),
    fullMedianSeconds: round(median(results[longest.name].glintmotion)),
  },
};
if (curveLengths.length) {
  report.curve = await measureCurve(longest, curveLengths, report.compositions.find((c) => c.name === longest.name).medianSeconds);
}
writeFileSync(values.out, `${JSON.stringify(report, null, 2)}\n`);
console.error(`Wrote ${values.out}`);
