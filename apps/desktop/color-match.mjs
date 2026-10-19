import { spawn } from "node:child_process";
import { copyFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { findFfmpeg, probeMedia, runFfmpeg } from "./media.mjs";

export const MATCH_CUBE_SIZE = 33;
const SAMPLE_FRAMES = 8;
const SAMPLE_WIDTH = 64;
/** Black bars and fades say nothing about a shot's look and would drag its mean down. */
const MIN_SAMPLE_LIGHTNESS = 0.04;
const MIN_SAMPLES = 200;
/** Gains and casts past these bounds come from a mismatch of content, not of grade. */
const GAIN_LIMITS = [0.6, 1.6];
const MAX_CAST_SHIFT = 0.04;
/**
 * The export's own drift is small; with the first pass's bounds, the correction would compress an
 * axis the first pass already compressed and drain small saturated areas.
 */
const CORRECTION_LIMITS = { gainLimits: [0.85, 1.18], maxCastShift: 0.02 };
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
/** The probe shows SAMPLE_FRAMES instants of each shot, one per frame, side by side. */
const PROBE_WIDTH = 360;
const PROBE_FPS = 30;
const PROBE_PIXEL_FORMATS = new Set([
  "yuv420p",
  "yuv422p",
  "yuv444p",
  "yuv420p10le",
  "yuv422p10le",
  "yuv444p10le",
]);
/** The engine's guess for an untagged matrix (videoFrameExtractor): BT.709 from 720 lines, except VP9 and AV1. */
const BT601_UNTAGGED_CODECS = new Set(["vp9", "av1"]);

const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const clampUnit = (value) => Math.min(1, Math.max(0, value));
const clampRange = (value, [min, max]) => Math.min(max, Math.max(min, value));

/** sRGB in [0,1] to Oklab (Björn Ottosson's matrices). */
export function rgbToOklab(r, g, b) {
  const lr = toLinear(r);
  const lg = toLinear(g);
  const lb = toLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export function oklabToRgb(L, a, b) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    clampUnit(toGamma(clampUnit(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s))),
    clampUnit(toGamma(clampUnit(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s))),
    clampUnit(toGamma(clampUnit(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s))),
  ];
}

const multiply = (left, right) =>
  left.map((row) =>
    [0, 1, 2].map((column) => row.reduce((sum, value, k) => sum + value * right[k][column], 0)),
  );

/** Eigenvalues and eigenvectors (columns) of a symmetric 3x3 matrix, by Jacobi rotations. */
function symmetricEigen(matrix) {
  const a = matrix.map((row) => [...row]);
  const vectors = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let sweep = 0; sweep < 50; sweep += 1) {
    const offDiagonal = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
    if (offDiagonal < 1e-15) break;
    for (const [p, q] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ]) {
      if (Math.abs(a[p][q]) < 1e-18) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const sine = t * c;
      for (let k = 0; k < 3; k += 1) {
        const [akp, akq] = [a[k][p], a[k][q]];
        a[k][p] = c * akp - sine * akq;
        a[k][q] = sine * akp + c * akq;
      }
      for (let k = 0; k < 3; k += 1) {
        const [apk, aqk] = [a[p][k], a[q][k]];
        a[p][k] = c * apk - sine * aqk;
        a[q][k] = sine * apk + c * aqk;
      }
      for (let k = 0; k < 3; k += 1) {
        const [vkp, vkq] = [vectors[k][p], vectors[k][q]];
        vectors[k][p] = c * vkp - sine * vkq;
        vectors[k][q] = sine * vkp + c * vkq;
      }
    }
  }
  return { values: [a[0][0], a[1][1], a[2][2]], vectors };
}

/** f applied to the eigenvalues of a symmetric matrix. */
function matrixFunction(matrix, f) {
  const { values, vectors } = symmetricEigen(matrix);
  return [0, 1, 2].map((row) =>
    [0, 1, 2].map((column) =>
      values.reduce((sum, value, k) => sum + vectors[row][k] * f(value) * vectors[column][k], 0),
    ),
  );
}

/** Mean, standard deviation and covariance of L, a, b over rgb24 pixels, black pixels left out. */
export function oklabStats(rgb24) {
  const sums = [0, 0, 0];
  const products = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  let count = 0;
  for (let index = 0; index + 2 < rgb24.length; index += 3) {
    const lab = rgbToOklab(rgb24[index] / 255, rgb24[index + 1] / 255, rgb24[index + 2] / 255);
    if (lab[0] < MIN_SAMPLE_LIGHTNESS) continue;
    for (let row = 0; row < 3; row += 1) {
      sums[row] += lab[row];
      for (let column = 0; column < 3; column += 1) products[row][column] += lab[row] * lab[column];
    }
    count += 1;
  }
  if (count < MIN_SAMPLES) throw new Error("Not enough lit pixels to measure this file's colors.");
  const mean = sums.map((sum) => sum / count);
  const covariance = products.map((row, i) =>
    row.map((product, j) => product / count - mean[i] * mean[j] + (i === j ? 1e-8 : 0)),
  );
  const std = [0, 1, 2].map((channel) => Math.sqrt(Math.max(1e-8, covariance[channel][channel])));
  return { mean, std, covariance, pixels: count };
}

/**
 * Gives `source` the look of `reference` in Oklab with the Monge-Kantorovich linear transfer
 * (Pitié & Kokaram 2007): means and full covariances match, so a cast that changes with
 * lightness moves too. `gains` are the eigenvalues of the map; `bounded` says a gain or the
 * shift of the mean color hit its limit.
 */
export function matchTransform(
  source,
  reference,
  { gainLimits = GAIN_LIMITS, maxCastShift = MAX_CAST_SHIFT } = {},
) {
  const root = matrixFunction(source.covariance, Math.sqrt);
  const inverseRoot = matrixFunction(
    source.covariance,
    (value) => 1 / Math.sqrt(Math.max(value, 1e-12)),
  );
  const middle = matrixFunction(multiply(multiply(root, reference.covariance), root), (value) =>
    Math.sqrt(Math.max(value, 0)),
  );
  const unbounded = multiply(multiply(inverseRoot, middle), inverseRoot);
  const rawGains = symmetricEigen(unbounded).values;
  const gains = rawGains.map((value) => clampRange(value, gainLimits)).sort((x, y) => x - y);
  const map = matrixFunction(unbounded, (value) => clampRange(value, gainLimits));
  const cast = [reference.mean[1] - source.mean[1], reference.mean[2] - source.mean[2]];
  const castScale = Math.min(1, maxCastShift / Math.max(1e-9, Math.hypot(...cast)));
  const target = [
    reference.mean[0],
    source.mean[1] + cast[0] * castScale,
    source.mean[2] + cast[1] * castScale,
  ];
  const bounded =
    castScale < 1 || rawGains.some((value) => value < gainLimits[0] || value > gainLimits[1]);
  const apply = (lab) => {
    const centered = lab.map((value, channel) => value - source.mean[channel]);
    return map.map(
      (row, channel) =>
        row.reduce((sum, value, k) => sum + value * centered[k], 0) + target[channel],
    );
  };
  return { gains, bounded, apply };
}

export function buildCube(transform, size = MATCH_CUBE_SIZE, title = "Glintmotion color match") {
  const lines = [`TITLE "${title}"`, `LUT_3D_SIZE ${size}`, "DOMAIN_MIN 0 0 0", "DOMAIN_MAX 1 1 1"];
  const step = 1 / (size - 1);
  for (let blue = 0; blue < size; blue += 1) {
    for (let green = 0; green < size; green += 1) {
      for (let red = 0; red < size; red += 1) {
        const lab = transform.apply(rgbToOklab(red * step, green * step, blue * step));
        lines.push(
          oklabToRgb(...lab)
            .map((value) => value.toFixed(6))
            .join(" "),
        );
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

/** Applies the transform to measured pixels: the stats the graded source should reach. */
export function predictStats(rgb24, transform) {
  const graded = Buffer.alloc(rgb24.length);
  for (let index = 0; index + 2 < rgb24.length; index += 3) {
    const lab = rgbToOklab(rgb24[index] / 255, rgb24[index + 1] / 255, rgb24[index + 2] / 255);
    const rgb =
      lab[0] < MIN_SAMPLE_LIGHTNESS ? lab.map(() => 0) : oklabToRgb(...transform.apply(lab));
    for (let channel = 0; channel < 3; channel += 1)
      graded[index + channel] = Math.round(rgb[channel] * 255);
  }
  return oklabStats(graded);
}

/** Small rgb24 frames spread across a video (or the image itself), read straight from FFmpeg. */
export async function samplePixels(file, { ffmpeg = findFfmpeg(), probe = probeMedia, crop } = {}) {
  const isImage = IMAGE_EXTENSIONS.has(extname(file).toLowerCase());
  const filters = [`scale=${SAMPLE_WIDTH}:-2:flags=area`, "format=rgb24"];
  if (crop) filters.unshift(`crop=${crop}`);
  if (!isImage) {
    const duration = Number((await probe(file)).format?.duration);
    if (!(duration > 0)) throw new Error("This video has no duration to sample.");
    filters.unshift(`fps=${(SAMPLE_FRAMES / duration).toFixed(4)}`);
  }
  const args = [
    "-hide_banner",
    "-v",
    "error",
    "-i",
    file,
    "-vf",
    filters.join(","),
    "-frames:v",
    String(isImage ? 1 : SAMPLE_FRAMES),
    "-f",
    "rawvideo",
    "pipe:1",
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    let stderr = "";
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`FFmpeg could not read ${file}. ${stderr.slice(-300)}`.trim()));
    });
  });
}

const rounded = (stats) => ({
  mean: stats.mean.map((value) => Number(value.toFixed(4))),
  std: stats.std.map((value) => Number(value.toFixed(4))),
});

const isImageFile = (file) => IMAGE_EXTENSIONS.has(extname(file).toLowerCase());

/** Encoder flags that keep a sample clip's pixels and colour tags what the engine reads from the original. */
function sampleClipColorArgs(stream) {
  const known = (value) => value && value !== "unknown" && value !== "reserved";
  const guessed =
    stream.height >= 720 && !BT601_UNTAGGED_CODECS.has(stream.codec_name) ? "bt709" : "smpte170m";
  const args = ["-pix_fmt", PROBE_PIXEL_FORMATS.has(stream.pix_fmt) ? stream.pix_fmt : "yuv420p"];
  args.push("-colorspace", known(stream.color_space) ? stream.color_space : guessed);
  if (known(stream.color_primaries)) args.push("-color_primaries", stream.color_primaries);
  if (known(stream.color_transfer)) args.push("-color_trc", stream.color_transfer);
  if (known(stream.color_range)) args.push("-color_range", stream.color_range);
  return args;
}

async function writeProbeShot(dir, name, file, probe) {
  if (isImageFile(file)) {
    const target = `${name}${extname(file).toLowerCase()}`;
    copyFileSync(file, join(dir, target));
    const stream = (await probe(file)).streams?.find((entry) => entry.width > 0);
    return {
      tag: "img",
      src: target,
      height: Math.round((PROBE_WIDTH * stream.height) / stream.width),
    };
  }
  const info = await probe(file);
  const stream = info.streams?.find((entry) => entry.codec_type === "video");
  const duration = Number(info.format?.duration);
  if (!stream || !(duration > 0)) throw new Error(`${file} has no video to sample.`);
  const target = `${name}.webm`;
  const run = await runFfmpeg([
    "-v",
    "error",
    "-y",
    "-i",
    file,
    "-vf",
    `fps=${(SAMPLE_FRAMES / duration).toFixed(4)},scale=${PROBE_WIDTH}:-2:flags=area,setpts=N/${PROBE_FPS}/TB`,
    "-r",
    String(PROBE_FPS),
    "-frames:v",
    String(SAMPLE_FRAMES),
    "-an",
    "-c:v",
    "libvpx-vp9",
    "-lossless",
    "1",
    "-deadline",
    "realtime",
    "-cpu-used",
    "8",
    ...sampleClipColorArgs(stream),
    join(dir, target),
  ]);
  if (run.code !== 0)
    throw new Error(`FFmpeg could not sample ${file}. ${run.stderr.slice(-300)}`.trim());
  const height = 2 * Math.round((PROBE_WIDTH * stream.height) / stream.width / 2);
  return { tag: "video", src: target, height };
}

/**
 * Writes a one-scene project in `dir`: the source (id "source", to be graded) beside the reference,
 * SAMPLE_FRAMES instants of each, so one short engine render shows what an export does to both.
 */
export async function writeColorProbe(dir, sourceFile, referenceFile, { probe = probeMedia } = {}) {
  const shots = [
    { id: "source", left: 0, ...(await writeProbeShot(dir, "source", sourceFile, probe)) },
    {
      id: "reference",
      left: PROBE_WIDTH,
      ...(await writeProbeShot(dir, "reference", referenceFile, probe)),
    },
  ];
  const width = 2 * PROBE_WIDTH;
  const height = Math.max(...shots.map((shot) => shot.height));
  const duration = (SAMPLE_FRAMES / PROBE_FPS).toFixed(5);
  const elements = shots.map(({ id, tag, src, left, height: shotHeight }, track) => {
    const style = `position:absolute;left:${left}px;top:0;width:${PROBE_WIDTH}px;height:${shotHeight}px;object-fit:fill`;
    const media = tag === "video" ? " muted playsinline" : "";
    const close = tag === "video" ? "></video>" : ">";
    return `      <${tag} id="${id}" src="${src}"${media} data-start="0" data-duration="${duration}" data-track-index="${track}" style="${style}"${close}`;
  });
  writeFileSync(
    join(dir, "index.html"),
    `<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8">
    <style>html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden;background:#000}</style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-no-timeline data-start="0" data-duration="${duration}" data-width="${width}" data-height="${height}">
${elements.join("\n")}
    </div>
  </body>
</html>
`,
  );
  return { fps: PROBE_FPS };
}

/** The graded source and the reference as the engine exported them, from a rendered probe. */
export async function readColorProbe(file, options = {}) {
  const [graded, reference] = await Promise.all([
    samplePixels(file, { ...options, crop: `${PROBE_WIDTH}:ih:0:0` }),
    samplePixels(file, { ...options, crop: `${PROBE_WIDTH}:ih:${PROBE_WIDTH}:0` }),
  ]);
  return { graded, reference };
}

/**
 * Measures both files and returns the .cube text that matches `sourceFile` to `referenceFile`.
 * With `renderProbe(cube)` (an engine render of writeColorProbe's project, read by readColorProbe),
 * a second transfer corrects what the export itself does to the graded colors, then a last render
 * measures the result.
 */
export async function colorMatch(sourceFile, referenceFile, options = {}) {
  const [sourcePixels, referencePixels] = await Promise.all([
    samplePixels(sourceFile, options),
    samplePixels(referenceFile, options),
  ]);
  const source = oklabStats(sourcePixels);
  const reference = oklabStats(referencePixels);
  const transform = matchTransform(source, reference);
  const report = {
    space: "Oklab L, a, b",
    source: rounded(source),
    reference: rounded(reference),
    predicted: rounded(predictStats(sourcePixels, transform)),
    gains: transform.gains.map((value) => Number(value.toFixed(3))),
    bounded: transform.bounded,
  };
  if (!options.renderProbe) return { cube: buildCube(transform), report };
  const measure = async (cube) => {
    const { graded, reference: shown } = await options.renderProbe(cube);
    return { graded: oklabStats(graded), reference: oklabStats(shown) };
  };
  const first = await measure(buildCube(transform));
  const correction = matchTransform(first.graded, first.reference, CORRECTION_LIMITS);
  const cube = buildCube({
    apply: (lab) => correction.apply(rgbToOklab(...oklabToRgb(...transform.apply(lab)))),
  });
  const exported = await measure(cube);
  report.exported = {
    graded: rounded(exported.graded),
    reference: rounded(exported.reference),
    firstPass: rounded(first.graded),
  };
  return { cube, report };
}
