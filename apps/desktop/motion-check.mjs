// Frame measurements for glintmotion_motion_check. Pure functions over gray crops,
// so they run (and are tested) without Electron.

/** A pixel differs when it moves more than this many levels (codec-free PNG/bitmap noise is 0-2). */
const PIXEL_NOISE = 2;
/** Levels above the crop's background before a pixel counts as ink; keeps grain and gradients out. */
const INK_FLOOR = 12;
/** Identical frames between two movements that read as the motion stopping and restarting. */
const STALL_FRAMES = 3;
/** Identical frames at a tween's start or end before it counts as dead time (about 0.13 s at 30 fps). */
const IDLE_FRAMES = 4;
/** Share of a tween's frames that must be idle before its start or end is reported. */
const IDLE_SHARE = 1 / 3;
/** Fewer frames than this cannot tell judder from a single correction. */
const JUDDER_MIN_STEPS = 8;
/** Share of frame steps that reverse direction; a real judder reverses on most of them. */
const JUDDER_SHARE = 0.6;
/** Centroid steps smaller than this are rasteriser noise, not a change of direction. */
const CENTROID_EPSILON = 0.05;
/** Eases that legitimately reverse direction. */
const OSCILLATING_EASE = /elastic|bounce|wiggle|rough|back/i;

/** BGRA bitmap (Electron's NativeImage.toBitmap) to 8-bit luma. */
export function toGray(bitmap, width, height) {
  const gray = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < gray.length; i += 1, p += 4) {
    gray[i] = (bitmap[p + 2] * 77 + bitmap[p + 1] * 150 + bitmap[p] * 29) >> 8;
  }
  return gray;
}

export function sameFrame(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (Math.abs(a[i] - b[i]) > PIXEL_NOISE) return false;
  return true;
}

function modalLevel(gray) {
  const histogram = new Uint32Array(256);
  for (const level of gray) histogram[level] += 1;
  let mode = 0;
  for (let level = 1; level < 256; level += 1) if (histogram[level] > histogram[mode]) mode = level;
  return mode;
}

/** Ink-weighted centroid of a crop; ink is whatever stands out from its most common level. */
export function inkCentroid(gray, width) {
  const background = modalLevel(gray);
  let weight = 0;
  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < gray.length; i += 1) {
    const ink = Math.abs(gray[i] - background) - INK_FLOOR;
    if (ink <= 0) continue;
    weight += ink;
    sumX += ink * (i % width);
    sumY += ink * Math.floor(i / width);
  }
  return weight > 0 ? { x: sumX / weight, y: sumY / weight, weight } : null;
}

/** One character per frame after the first: "m" moved, "=" same pixels as the previous frame. */
export function holdPattern(samples) {
  let pattern = "";
  for (let i = 1; i < samples.length; i += 1)
    pattern += sameFrame(samples[i - 1].gray, samples[i].gray) ? "=" : "m";
  return pattern;
}

/** Direction changes of the vertical ink centroid. */
export function centroidReversals(samples) {
  let reversals = 0;
  let previous = 0;
  for (let i = 1; i < samples.length; i += 1) {
    const [a, b] = [samples[i - 1].centroid, samples[i].centroid];
    if (!a || !b) continue;
    const step = b.y - a.y;
    if (Math.abs(step) < CENTROID_EPSILON) continue;
    if (previous && Math.sign(step) !== Math.sign(previous)) reversals += 1;
    previous = step;
  }
  return reversals;
}

function round(value, digits = 2) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

const EASE_HINT =
  "The ease's slow end moves less than a pixel per frame, and text snaps to whole pixels vertically: " +
  "use a moderate ease (power2.out, power1.out) or a shorter tween. gsap_ease_freezes_on_frame_clock flags it statically.";

/** Idle frames only count while the element shows; a sweep clipped out of view is not idle. */
function idleRun(pattern, samples, atEnd) {
  const frames = pattern.match(atEnd ? /=*$/ : /^=*/)[0].length;
  const edge = atEnd ? samples.at(-1) : samples[0];
  if (!edge.centroid || frames === pattern.length) return 0;
  return frames >= IDLE_FRAMES && frames >= pattern.length * IDLE_SHARE ? frames : 0;
}

function lateStart(tween, pattern, samples, fps) {
  const frames = idleRun(pattern, samples, false);
  if (!frames) return null;
  const from = round(samples[frames].time);
  return {
    issue: "late_start",
    idleFrames: frames,
    visibleFrom: from,
    message: `${tween.label} only starts moving at ${from} s, ${frames} frames (${round(frames / fps)} s) after its tween starts.`,
    hint: "An ease-in spends its first frames under a pixel: start the tween later and shorten it, or use a gentler ease-in.",
  };
}

/** Stops, moves one more step, stops: the slow end of a strong ease-out, seen as a tick. */
function tailTick(tween, pattern, samples) {
  const crawl = pattern.match(/m(=+)m(=+)$/);
  if (!crawl || crawl[2].length < 2 || crawl[1].length + crawl[2].length < IDLE_FRAMES) return null;
  const tick = round(samples[pattern.length - crawl[2].length].time);
  return {
    issue: "tail_tick",
    idleFrames: crawl[1].length + crawl[2].length,
    tickAt: tick,
    message:
      `${tween.label} settles, then jumps one more pixel at ${tick} s and stops: ` +
      "the last frames of its ease read as a tick instead of a landing.",
    hint: EASE_HINT,
  };
}

function earlyFinish(tween, pattern, samples, fps) {
  const frames = idleRun(pattern, samples, true);
  if (!frames) return null;
  const until = round(samples[pattern.length - frames].time);
  return {
    issue: "early_finish",
    idleFrames: frames,
    visibleUntil: until,
    message:
      `${tween.label} stops moving at ${until} s, ${frames} frames (${round(frames / fps)} s) before its tween ends; ` +
      "anything timed on the tween's end lands late.",
    hint: EASE_HINT,
  };
}

function midStall(tween, pattern, samples, fps) {
  const runs = [...pattern.matchAll(/m(=+)(?=m)/g)].map((match) => ({
    frames: match[1].length,
    from: match.index + 1,
  }));
  const worst = runs.reduce((best, run) => (run.frames > (best?.frames ?? 0) ? run : best), null);
  if (!worst || worst.frames < STALL_FRAMES) return null;
  return {
    issue: "stall",
    idleFrames: worst.frames,
    at: round(samples[worst.from].time),
    message:
      `${tween.label} stops for ${worst.frames} frames (${round(worst.frames / fps)} s) at ${round(samples[worst.from].time)} s, ` +
      "then moves again: a visible hitch.",
    hint: EASE_HINT,
  };
}

function judder(tween, samples) {
  if (!tween.text || tween.textChanges || tween.repeats) return null;
  if (OSCILLATING_EASE.test(tween.ease ?? "") || samples.length - 1 < JUDDER_MIN_STEPS) return null;
  const reversals = centroidReversals(samples);
  if (reversals < 4 || reversals < (samples.length - 1) * JUDDER_SHARE) return null;
  const scaled = tween.props.some((prop) => prop.startsWith("scale"));
  return {
    issue: "judder",
    reversals,
    message: `${tween.label} shakes: its ink changes vertical direction ${reversals} times in ${samples.length} frames.`,
    hint: scaled
      ? 'Pivot the scale on the text baseline (transformOrigin "50% 80%", or measured with a zero-size inline-block probe). ' +
        "gsap_text_scale_center_origin flags it statically."
      : "Look for another tween on the same element, or a layout property animated alongside the transform.",
  };
}

/**
 * Findings for one tween from its captured frames, in order: { time, gray, centroid }.
 * `tween` carries label, start, end, ease, props, and the probe's flags (text, textChanges,
 * repeats). A tween whose first and last frames match never visibly moved.
 */
export function analyzeTween(tween, samples, fps) {
  if (samples.length < IDLE_FRAMES + 1) return [];
  const pattern = holdPattern(samples);
  if (!pattern.includes("m")) return [];
  const found = [
    lateStart(tween, pattern, samples, fps),
    midStall(tween, pattern, samples, fps),
    tailTick(tween, pattern, samples) ?? earlyFinish(tween, pattern, samples, fps),
    judder(tween, samples),
  ].filter(Boolean);
  return found.map((finding) => ({
    target: tween.label,
    start: round(tween.start),
    end: round(tween.end),
    ease: tween.ease,
    properties: tween.props,
    pattern,
    ...finding,
  }));
}
