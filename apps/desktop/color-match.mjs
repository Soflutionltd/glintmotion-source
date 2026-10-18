import { spawn } from "node:child_process";
import { extname } from "node:path";
import { findFfmpeg, probeMedia } from "./media.mjs";

export const MATCH_CUBE_SIZE = 33;
const SAMPLE_FRAMES = 8;
const SAMPLE_WIDTH = 64;
/** Black bars and fades say nothing about a shot's look and would drag its mean down. */
const MIN_SAMPLE_LIGHTNESS = 0.04;
const MIN_SAMPLES = 200;
/** Spread ratios past these bounds come from a mismatch of content, not of grade. */
const LIGHTNESS_SPREAD_LIMITS = [0.7, 1.4];
const CHROMA_SPREAD_LIMITS = [0.5, 2];
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

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

/** Mean and standard deviation of L, a, b over rgb24 pixels, black pixels left out. */
export function oklabStats(rgb24) {
  const sums = [0, 0, 0];
  const squares = [0, 0, 0];
  let count = 0;
  for (let index = 0; index + 2 < rgb24.length; index += 3) {
    const lab = rgbToOklab(rgb24[index] / 255, rgb24[index + 1] / 255, rgb24[index + 2] / 255);
    if (lab[0] < MIN_SAMPLE_LIGHTNESS) continue;
    for (let channel = 0; channel < 3; channel += 1) {
      sums[channel] += lab[channel];
      squares[channel] += lab[channel] * lab[channel];
    }
    count += 1;
  }
  if (count < MIN_SAMPLES) throw new Error("Not enough lit pixels to measure this file's colors.");
  const mean = sums.map((sum) => sum / count);
  const std = squares.map((square, channel) =>
    Math.sqrt(Math.max(1e-8, square / count - mean[channel] ** 2)),
  );
  return { mean, std, pixels: count };
}

/** The Oklab mean/spread transfer that gives `source` the look of `reference`, with bounded spread ratios. */
export function matchTransform(source, reference) {
  const ratios = [0, 1, 2].map((channel) =>
    clampRange(
      reference.std[channel] / source.std[channel],
      channel === 0 ? LIGHTNESS_SPREAD_LIMITS : CHROMA_SPREAD_LIMITS,
    ),
  );
  const apply = (lab) =>
    lab.map(
      (value, channel) =>
        (value - source.mean[channel]) * ratios[channel] + reference.mean[channel],
    );
  return { ratios, apply };
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
export async function samplePixels(file, { ffmpeg = findFfmpeg(), probe = probeMedia } = {}) {
  const isImage = IMAGE_EXTENSIONS.has(extname(file).toLowerCase());
  const filters = [`scale=${SAMPLE_WIDTH}:-2:flags=area`, "format=rgb24"];
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

/** Measures both files and returns the .cube text that matches `sourceFile` to `referenceFile`. */
export async function colorMatch(sourceFile, referenceFile, options = {}) {
  const [sourcePixels, referencePixels] = await Promise.all([
    samplePixels(sourceFile, options),
    samplePixels(referenceFile, options),
  ]);
  const source = oklabStats(sourcePixels);
  const reference = oklabStats(referencePixels);
  const transform = matchTransform(source, reference);
  return {
    cube: buildCube(transform),
    report: {
      space: "Oklab L, a, b",
      source: rounded(source),
      reference: rounded(reference),
      predicted: rounded(predictStats(sourcePixels, transform)),
      spreadRatios: transform.ratios.map((value) => Number(value.toFixed(3))),
    },
  };
}
