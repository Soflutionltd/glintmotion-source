/**
 * Beats, downbeats and tempo from signal processing alone: a log-band spectral-flux onset curve, an autocorrelation
 * tempo with a log-normal prior, and dynamic-programming beat placement (Ellis 2007). Times are seconds into the signal.
 */

import type { AudioSignal } from "./audioAnalysis";
import { fft } from "./fft";

export interface Beats {
  /** Empty when there is no steady beat, with `reason` saying so. */
  times: number[];
  /** 0–1: how strongly the onsets repeat at the beat period, scaled by how much stronger they are on the beats. */
  confidence?: number;
  reason?: string;
}

export interface Downbeats {
  times: number[];
  /** Beats per bar, 3 or 4; null when there are too few beats to tell. */
  meter: number | null;
  /** "low" for a guess from where the low end hits hardest. */
  confidence?: "low";
}

export interface TempoPoint {
  t: number;
  bpm: number;
}

export interface Tempo {
  /** Beats per minute from the median beat interval; null without at least two beats. */
  value: number | null;
  /** The tempo over the beats around each point, every few seconds, for music that speeds up or slows down. */
  curve: TempoPoint[];
}

export interface Rhythm {
  beats: Beats;
  downbeats: Downbeats;
}

/** Log energy per frame in log-spaced bands, the frames `fps` per second. */
export interface BandFrames {
  fps: number;
  bands: Float64Array[];
}

const FRAMES_PER_SECOND = 100;
const LOW_BAND_HZ = 150;
const SLOWEST_BPM = 40;
const FASTEST_BPM = 240;
const TIGHTNESS = 100;

const round = (t: number) => Math.round(t * 1000) / 1000;

function bandEdges(sampleRate: number, size: number): number[] {
  const binHz = sampleRate / size;
  const edges: number[] = [];
  for (let hz = 30; hz < Math.min(9000, sampleRate / 2); hz *= 2 ** (1 / 5))
    edges.push(Math.max(1, Math.round(hz / binHz)));
  return edges;
}

/** Add each band's power in the Hann-windowed frame centred on `center` into `into`. */
function addFramePower(
  samples: Float32Array,
  center: number,
  window: Float64Array,
  edges: number[],
  into: Float64Array,
): void {
  const size = window.length;
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const first = center - size / 2;
  for (let i = 0; i < size; i++) {
    const at = first + i;
    re[i] = at >= 0 && at < samples.length ? samples[at]! * window[i]! : 0;
  }
  fft(re, im);
  for (let b = 0; b + 1 < edges.length; b++) {
    const end = Math.max(edges[b]! + 1, edges[b + 1]!);
    let power = 0;
    for (let k = edges[b]!; k < end; k++) power += re[k]! * re[k]! + im[k]! * im[k]!;
    into[b]! += power / (size * size * (end - edges[b]!));
  }
}

/** Per-band log power, summed over channels so a polarity-flipped channel cannot cancel. */
export function bandFrames(signal: AudioSignal): BandFrames {
  const { sampleRate, channels } = signal;
  const hop = Math.max(1, Math.round(sampleRate / FRAMES_PER_SECOND));
  const size = 2 ** Math.round(Math.log2(sampleRate * 0.046));
  const window = Float64Array.from(
    { length: size },
    (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size),
  );
  const edges = bandEdges(sampleRate, size);
  const length = channels[0]?.length ?? 0;
  const bands: Float64Array[] = [];
  for (let center = 0; center < length; center += hop) {
    const power = new Float64Array(Math.max(0, edges.length - 1));
    for (const channel of channels) addFramePower(channel, center, window, edges, power);
    bands.push(power.map((p) => Math.log1p(1e9 * p)));
  }
  return { fps: sampleRate / hop, bands };
}

/** Subtract the mean of the surrounding ±`radius` frames and keep what rises above it. */
function aboveLocalMean(curve: Float64Array, radius: number): Float64Array {
  const sums = new Float64Array(curve.length + 1);
  for (let i = 0; i < curve.length; i++) sums[i + 1] = sums[i]! + curve[i]!;
  return curve.map((value, i) => {
    const from = Math.max(0, i - radius);
    const to = Math.min(curve.length, i + radius + 1);
    return Math.max(0, value - (sums[to]! - sums[from]!) / (to - from));
  });
}

function standardized(curve: Float64Array): Float64Array {
  const mean = curve.reduce((a, b) => a + b, 0) / (curve.length || 1);
  const spread = Math.sqrt(curve.reduce((a, v) => a + (v - mean) ** 2, 0) / (curve.length || 1));
  return spread > 0 ? curve.map((v) => v / spread) : curve.map(() => 0);
}

interface OnsetCurves {
  fps: number;
  /** Rectified rise summed over every band. */
  broad: Float64Array;
  /** Rectified rise of the bands under 150 Hz, where kick drums and bass mark the bar. */
  low: Float64Array;
}

function onsetCurves({ fps, bands }: BandFrames, sampleRate: number): OnsetCurves {
  const size = 2 ** Math.round(Math.log2(sampleRate * 0.046));
  const lowBands = bandEdges(sampleRate, size).filter(
    (bin) => (bin * sampleRate) / size < LOW_BAND_HZ,
  ).length;
  const broad = new Float64Array(bands.length);
  const low = new Float64Array(bands.length);
  for (let f = 1; f < bands.length; f++) {
    const frame = bands[f]!;
    const previous = bands[f - 1]!;
    for (let b = 0; b < frame.length; b++) {
      const rise = Math.max(0, frame[b]! - previous[b]!);
      broad[f]! += rise;
      if (b < lowBands) low[f]! += rise;
    }
  }
  const radius = Math.round(0.4 * fps);
  return {
    fps,
    broad: standardized(aboveLocalMean(broad, radius)),
    low: standardized(aboveLocalMean(low, radius)),
  };
}

/** Autocorrelation of `curve` at lags 0…`maxLag`, normalized by lag 0. */
function autocorrelation(curve: Float64Array, maxLag: number): Float64Array {
  const mean = curve.reduce((a, b) => a + b, 0) / (curve.length || 1);
  const centred = curve.map((v) => v - mean);
  const ac = new Float64Array(maxLag + 1);
  for (let lag = 0; lag <= maxLag && lag < centred.length; lag++) {
    let sum = 0;
    for (let i = lag; i < centred.length; i++) sum += centred[i]! * centred[i - lag]!;
    ac[lag] = sum;
  }
  const zero = ac[0] || 1;
  return ac.map((v) => v / zero);
}

const tempoPrior = (lag: number, fps: number) =>
  Math.exp(-0.5 * Math.log2(60 / (lag / fps) / 120) ** 2);

interface LagRange {
  shortest: number;
  longest: number;
}

const fullRange = (fps: number): LagRange => ({
  shortest: Math.max(1, Math.floor((60 / FASTEST_BPM) * fps)),
  longest: Math.ceil((60 / SLOWEST_BPM) * fps),
});

/** The beat period in frames: prior-weighted autocorrelation plus half its value at twice the lag. */
function beatPeriod(
  curve: Float64Array,
  fps: number,
  { shortest, longest }: LagRange = fullRange(fps),
): { period: number; clarity: number } {
  const ac = autocorrelation(curve, 2 * longest + 1);
  const at = (lag: number) => ac[Math.min(ac.length - 1, Math.max(0, lag))]!;
  const score = (lag: number) =>
    tempoPrior(lag, fps) *
    (at(lag) + 0.5 * at(2 * lag) + 0.25 * (at(2 * lag - 1) + at(2 * lag + 1)));
  let best = shortest;
  for (let lag = shortest; lag <= longest; lag++) if (score(lag) > score(best)) best = lag;
  const [a, b, c] = [score(best - 1), score(best), score(best + 1)];
  const curvature = a - 2 * b + c;
  const shift = curvature ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / curvature)) : 0;
  return { period: best + shift, clarity: Math.max(0, Math.min(1, at(best))) };
}

/** The onset curve smoothed by a Gaussian a thirty-second of a beat wide. */
function smoothed(curve: Float64Array, period: number): Float64Array {
  const half = Math.max(1, Math.round(period / 8));
  const kernel = Array.from({ length: 2 * half + 1 }, (_, i) =>
    Math.exp(-0.5 * (((i - half) * 32) / period) ** 2),
  );
  return curve.map((_, i) => {
    let sum = 0;
    for (let j = 0; j < kernel.length; j++) sum += kernel[j]! * (curve[i + j - half] ?? 0);
    return sum;
  });
}

/** Ellis's recursion: each frame's best score from a predecessor about one period back, penalized by log deviation. */
function cumulativeScore(local: Float64Array, periodAt: (frame: number) => number) {
  const score = new Float64Array(local.length);
  const back = new Int32Array(local.length).fill(-1);
  for (let i = 0; i < local.length; i++) {
    const period = periodAt(i);
    let best = -Infinity;
    let from = -1;
    for (let j = Math.max(0, Math.round(i - 2 * period)); j <= i - Math.round(period / 2); j++) {
      const candidate = score[j]! - TIGHTNESS * Math.log((i - j) / period) ** 2;
      if (candidate > best) [best, from] = [candidate, j];
    }
    score[i] = local[i]! + Math.max(0, best);
    back[i] = best > 0 ? from : -1;
  }
  return { score, back };
}

/** The last local maximum of the cumulative score that reaches half the median of all of them. */
function lastBeat(score: Float64Array): number {
  const maxima: number[] = [];
  for (let i = 1; i + 1 < score.length; i++)
    if (score[i]! > score[i - 1]! && score[i]! >= score[i + 1]!) maxima.push(i);
  if (!maxima.length) return score.length - 1;
  const median = maxima.map((i) => score[i]!).sort((a, b) => a - b)[maxima.length >> 1]!;
  for (let k = maxima.length - 1; k >= 0; k--)
    if (score[maxima[k]!]! >= 0.5 * median) return maxima[k]!;
  return maxima[maxima.length - 1]!;
}

/** Drop beats at either end whose onset strength is under half the RMS of the beats' strengths. */
function trimmed(beats: number[], local: Float64Array): number[] {
  const rms = Math.sqrt(beats.reduce((a, b) => a + local[b]! ** 2, 0) / (beats.length || 1));
  let first = 0;
  let end = beats.length;
  while (first < end && local[beats[first]!]! < 0.5 * rms) first++;
  while (end > first && local[beats[end - 1]!]! < 0.5 * rms) end--;
  return beats.slice(first, end);
}

const LOCAL_WINDOW_SECONDS = 8;

/** The period through the piece: eight-second windows a second apart, held near the global period, median-smoothed. */
function localPeriods(curve: Float64Array, fps: number, period: number): (frame: number) => number {
  const window = Math.round(LOCAL_WINDOW_SECONDS * fps);
  const hop = Math.round(fps);
  const range = {
    shortest: Math.max(fullRange(fps).shortest, Math.floor(period * 0.7)),
    longest: Math.min(fullRange(fps).longest, Math.ceil(period * 1.4)),
  };
  const centres: number[] = [];
  const periods: number[] = [];
  for (let start = 0; start === 0 || start + window <= curve.length; start += hop) {
    const end = Math.min(curve.length, start + window);
    periods.push(beatPeriod(curve.subarray(start, end), fps, range).period);
    centres.push((start + end) / 2);
  }
  const median = periods.map((_, i) => {
    const near = periods.slice(Math.max(0, i - 2), i + 3).sort((a, b) => a - b);
    return near[near.length >> 1]!;
  });
  return (frame) => interpolate(centres, median, frame);
}

function interpolate(xs: number[], ys: number[], x: number): number {
  if (x <= xs[0]!) return ys[0]!;
  for (let i = 1; i < xs.length; i++)
    if (x <= xs[i]!) {
      const t = (x - xs[i - 1]!) / (xs[i]! - xs[i - 1]!);
      return ys[i - 1]! * (1 - t) + ys[i]! * t;
    }
  return ys[ys.length - 1]!;
}

function beatFrames(curve: Float64Array, fps: number, period: number) {
  const local = smoothed(curve, period);
  const { score, back } = cumulativeScore(local, localPeriods(curve, fps, period));
  const beats: number[] = [];
  for (let i = lastBeat(score); i >= 0; i = back[i]!) beats.push(i);
  return { frames: trimmed(beats.reverse(), local), local };
}

/** How much stronger the smoothed onsets are on the beats than on average, as a share: 0 is no stronger. */
function onsetLift(frames: number[], local: Float64Array): number {
  const overall = local.reduce((a, b) => a + b, 0) / (local.length || 1);
  const onBeats = frames.reduce((a, f) => a + local[f]!, 0) / (frames.length || 1);
  return overall > 0 ? onBeats / overall - 1 : 0;
}

/** The meter and bar phase whose beats carry the most low-band onset energy against the others. */
function barPhase(beats: number[], curves: OnsetCurves): { meter: number; phase: number } {
  const strength = (f: number) =>
    Math.max(
      ...[-1, 0, 1, 2].map((d) => (curves.low[f + d] ?? 0) + 0.3 * (curves.broad[f + d] ?? 0)),
    );
  const levels = beats.map(strength);
  let best = { meter: 4, phase: 0, contrast: -Infinity };
  for (const meter of [4, 3])
    for (let phase = 0; phase < meter; phase++) {
      const on = levels.filter((_, k) => (k - phase) % meter === 0);
      const off = levels.filter((_, k) => (k - phase) % meter !== 0);
      const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / (v.length || 1);
      const contrast = (mean(on) - mean(off)) * (meter === 3 ? 0.85 : 1);
      if (contrast > best.contrast) best = { meter, phase, contrast };
    }
  return best;
}

export function medianInterval(times: readonly number[]): number | null {
  const gaps = times
    .slice(1)
    .map((t, i) => t - times[i]!)
    .sort((a, b) => a - b);
  return gaps.length ? gaps[gaps.length >> 1]! : null;
}

const noRhythm = (confidence: number, reason = "no steady beat"): Rhythm => ({
  beats: { times: [], confidence, reason },
  downbeats: { times: [], meter: null, confidence: "low" },
});

/** Two bars of 4/4 at 80 BPM: anything shorter has too few beats to call steady. */
const SHORTEST_SECONDS = 6;

/** Below this the beats are more likely the tracker's own grid than the music's. */
export const STEADY_BEAT_CONFIDENCE = 0.05;

/** Clarity of the period, scaled down when the beats are under three times as strong as the onsets around them. */
const beatConfidence = (clarity: number, lift: number) =>
  round(Math.max(0, Math.min(1, clarity)) * Math.max(0, Math.min(1, lift / 3)));

/** Beats and downbeats of `frames`, the band energies of a signal at `sampleRate`. */
export function rhythmOf(frames: BandFrames, sampleRate: number): Rhythm {
  const curves = onsetCurves(frames, sampleRate);
  const { period, clarity } = beatPeriod(curves.broad, curves.fps);
  if (curves.broad.length < SHORTEST_SECONDS * curves.fps)
    return noRhythm(0, "too short for a steady beat");
  if (!curves.broad.some((v) => v > 0) || curves.broad.length < 2 * period) return noRhythm(0);
  const { frames: beatList, local } = beatFrames(curves.broad, curves.fps, period);
  const confidence = beatConfidence(clarity, onsetLift(beatList, local));
  if (beatList.length < 4 || confidence < STEADY_BEAT_CONFIDENCE) return noRhythm(confidence);
  const times = beatList.map((f) => round(f / curves.fps));
  const bar = beatList.length >= 6 ? barPhase(beatList, curves) : null;
  return {
    beats: { times, confidence },
    downbeats: {
      times: bar ? times.filter((_, k) => (k - bar.phase) % bar.meter === 0) : [],
      meter: bar?.meter ?? null,
      confidence: "low",
    },
  };
}

const TEMPO_STEP_SECONDS = 4;

/** Tempo from beat times, by whichever provider placed them: the median interval, and a curve over ±4 s windows. */
export function tempoOf(times: readonly number[]): Tempo {
  const interval = medianInterval(times);
  if (!interval) return { value: null, curve: [] };
  const bpm = (gap: number) => Math.round(600 / gap) / 10;
  const curve: TempoPoint[] = [];
  const last = times[times.length - 1]!;
  for (let t = times[0]!; t <= last; t += TEMPO_STEP_SECONDS) {
    const gap = medianInterval(times.filter((b) => Math.abs(b - t) <= TEMPO_STEP_SECONDS));
    if (gap) curve.push({ t: round(t), bpm: bpm(gap) });
  }
  return { value: bpm(interval), curve };
}

const measured = new WeakMap<AudioSignal, { frames: BandFrames; rhythm?: Rhythm }>();

/** Band energies of `signal`, computed once per signal for every capability that reads them. */
export function bandFramesOf(signal: AudioSignal): BandFrames {
  let entry = measured.get(signal);
  if (!entry) measured.set(signal, (entry = { frames: bandFrames(signal) }));
  return entry.frames;
}

export function rhythm(signal: AudioSignal): Rhythm {
  const frames = bandFramesOf(signal);
  const entry = measured.get(signal)!;
  return (entry.rhythm ??= rhythmOf(frames, signal.sampleRate));
}
