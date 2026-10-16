import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeMedia, runFfmpeg } from "./media.mjs";
import { findVideo } from "./takes.mjs";

export const REFERENCE_DIR = "reference";
export const SHOTS_DIR = "assets/shots";
export const MIN_SHOT_SECONDS = 0.2;
export const MAX_SHOTS = 80;
const SHEET_TILES = 24;
const SHEET_COLUMNS = 6;
const SHEET_TILE_WIDTH = 200;
const ANALYSIS_WIDTH = 160;
/** A beat this close to a cut counts as "the cut lands on the beat" (about two frames at 30 fps). */
const ON_BEAT_SECONDS = 0.07;
const DEFAULT_SNAP_SECONDS = 0.15;
const PLACEHOLDER_FPS = 30;

export const RESOLUTION_SIZES = {
  portrait: [1080, 1920],
  post: [1080, 1350],
  landscape: [1920, 1080],
  square: [1080, 1080],
};

/**
 * How easily a frame counts as a cut. A cut is a frame whose scene score is the highest of its
 * neighbours and stands well above the usual change around it: screen recordings move little, so a
 * fixed threshold misses their cuts while it catches every camera move in live footage.
 */
const SENSITIVITY = {
  low: { floor: 0.12, ratio: 6 },
  normal: { floor: 0.05, ratio: 4 },
  high: { floor: 0.03, ratio: 3 },
};

const round = (value, digits = 3) => Math.round(value * 10 ** digits) / 10 ** digits;

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** One `{ time, score }` per decoded frame, from ffmpeg's `metadata=print` output. */
export function parseSceneScores(stderr) {
  const frames = [];
  let time = null;
  for (const line of String(stderr).split("\n")) {
    const pts = /pts_time:(-?[\d.]+)/.exec(line);
    if (pts) {
      time = Number(pts[1]);
      continue;
    }
    const score = /lavfi\.scene_score=([\d.]+)/.exec(line);
    if (score && time !== null) {
      frames.push({ time, score: Number(score[1]) });
      time = null;
    }
  }
  return frames;
}

/** Indexes of the frames that start a new shot. */
export function detectCuts(frames, { sensitivity = "normal", minShot = MIN_SHOT_SECONDS } = {}) {
  const rule = SENSITIVITY[sensitivity];
  if (!rule) throw new Error(`sensitivity is one of ${Object.keys(SENSITIVITY).join(", ")}.`);
  const fps =
    frames.length > 1
      ? (frames.length - 1) / Math.max(1e-6, frames.at(-1).time - frames[0].time)
      : 30;
  const near = Math.max(1, Math.round(fps / 10));
  const around = Math.max(near + 1, Math.round(fps / 2));
  const cuts = [];
  for (let i = 1; i < frames.length; i++) {
    const { score, time } = frames[i];
    if (score < rule.floor) continue;
    const neighbours = frames
      .slice(Math.max(0, i - near), i + near + 1)
      .map((frame) => frame.score);
    if (score < Math.max(...neighbours)) continue;
    const usual = median(
      frames.slice(Math.max(0, i - around), i + around + 1).map((frame) => frame.score),
    );
    if (score < usual * rule.ratio + 0.02) continue;
    const previous = cuts.length ? frames[cuts.at(-1)].time : frames[0].time;
    if (time - previous < minShot) {
      if (cuts.length && score > frames[cuts.at(-1)].score) cuts[cuts.length - 1] = i;
      continue;
    }
    cuts.push(i);
  }
  return cuts;
}

function motionLabel(level) {
  if (level < 0.01) return "still";
  if (level < 0.04) return "moderate";
  return "strong";
}

/** Shots between the cuts, with how much moves inside each (the mean scene score, the cut excluded). */
export function shotsFromCuts(frames, cuts, duration) {
  const starts = [0, ...cuts];
  return starts.map((startIndex, n) => {
    const endIndex = n + 1 < starts.length ? starts[n + 1] : frames.length;
    const start = n === 0 ? 0 : frames[startIndex].time;
    const end = n + 1 < starts.length ? frames[endIndex].time : duration;
    const inner = frames.slice(startIndex + 1, endIndex).map((frame) => frame.score);
    const motion = inner.length ? inner.reduce((sum, value) => sum + value, 0) / inner.length : 0;
    const middle = Math.min(
      frames.length - 1,
      Math.round((startIndex + Math.max(startIndex, endIndex - 1)) / 2),
    );
    return {
      id: `shot-${String(n + 1).padStart(2, "0")}`,
      start: round(start),
      duration: round(end - start),
      motion: motionLabel(motion),
      motionLevel: round(motion, 4),
      frame: middle,
    };
  });
}

/** Share of cuts that fall on a beat of the music. */
export function cutsOnBeat(shots, beats) {
  const cuts = shots.slice(1).map((shot) => shot.start);
  if (cuts.length === 0 || beats.length === 0) return null;
  const hits = cuts.filter((cut) =>
    beats.some((beat) => Math.abs(beat - cut) <= ON_BEAT_SECONDS),
  ).length;
  return round(hits / cuts.length, 2);
}

/** Shots stretched or squeezed to `target` seconds, every cut keeping its place in proportion. */
export function scaleShots(shots, total, target) {
  if (!target || Math.abs(target - total) < 1e-3) return shots.map((shot) => ({ ...shot }));
  const factor = target / total;
  const ends = shots.map((shot) => round((shot.start + shot.duration) * factor));
  return shots.map((shot, n) => {
    const start = n === 0 ? 0 : ends[n - 1];
    const end = n === shots.length - 1 ? round(target) : ends[n];
    return { ...shot, start, duration: round(end - start) };
  });
}

/** The format closest to the reference's aspect ratio. */
export function resolutionFor(width, height) {
  const ratio = width / height;
  if (ratio < 0.68) return "portrait";
  if (ratio < 0.9) return "post";
  if (ratio < 1.25) return "square";
  return "landscape";
}

function hex(rgb) {
  return `#${rgb.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

/** Placeholder colour of a shot: its average colour, darkened so white text stays readable on it. */
export function placeholderColor(rgb) {
  return hex(rgb.map((value) => Math.round(value * 0.55)));
}

function selectFrames(indexes) {
  return `select='${indexes.map((index) => `eq(n\\,${index})`).join("+")}'`;
}

function sampleForSheet(shots) {
  if (shots.length <= SHEET_TILES) return shots;
  return Array.from(
    { length: SHEET_TILES },
    (_, i) => shots[Math.round((i * (shots.length - 1)) / (SHEET_TILES - 1))],
  );
}

async function scoreFrames(file) {
  const { code, stderr } = await runFfmpeg([
    "-nostats",
    "-i",
    file,
    "-an",
    "-vf",
    `scale=${ANALYSIS_WIDTH}:-2,select='gte(scene\\,0)',metadata=print:key=lavfi.scene_score`,
    "-f",
    "null",
    "-",
  ]);
  if (code !== 0)
    throw new Error(`ffmpeg could not read the reference. ${stderr.slice(-400)}`.trim());
  return parseSceneScores(stderr);
}

async function averageColors(file, indexes, work) {
  const output = join(work, "colors.rgb");
  const { code, stderr } = await runFfmpeg([
    "-y",
    "-i",
    file,
    "-an",
    "-vf",
    `${selectFrames(indexes)},scale=1:1:flags=area,format=rgb24`,
    "-fps_mode",
    "passthrough",
    "-f",
    "rawvideo",
    output,
  ]);
  if (code !== 0)
    throw new Error(`The shot colours could not be read. ${stderr.slice(-400)}`.trim());
  const bytes = readFileSync(output);
  return indexes.map((_, i) => [bytes[i * 3] ?? 0, bytes[i * 3 + 1] ?? 0, bytes[i * 3 + 2] ?? 0]);
}

async function shotSheet(file, shots, output) {
  const tiles = sampleForSheet(shots);
  const rows = Math.ceil(tiles.length / SHEET_COLUMNS);
  const columns = Math.min(SHEET_COLUMNS, tiles.length);
  const { code, stderr } = await runFfmpeg([
    "-y",
    "-i",
    file,
    "-an",
    "-vf",
    `${selectFrames(tiles.map((shot) => shot.frame))},scale=${SHEET_TILE_WIDTH}:-2,tile=${columns}x${rows}:padding=6:margin=6:color=0x101010`,
    "-fps_mode",
    "passthrough",
    "-frames:v",
    "1",
    "-q:v",
    "4",
    output,
  ]);
  if (code !== 0)
    throw new Error(`The shot sheet could not be assembled. ${stderr.slice(-400)}`.trim());
  return tiles.map((shot) => shot.id);
}

/** Beat times of the reference's sound, found by the engine's own detector in a throwaway project. */
async function referenceBeats(file, duration, runBeats, work) {
  const audio = join(work, "music.wav");
  const extracted = await runFfmpeg(["-y", "-i", file, "-vn", "-ac", "1", "-ar", "44100", audio]);
  if (extracted.code !== 0 || !existsSync(audio)) return { beats: [], bpm: null };
  writeFileSync(
    join(work, "index.html"),
    `<!doctype html><html><body><div id="root" data-composition-id="main" data-start="0" data-duration="${duration}" data-width="1080" data-height="1920"><audio id="music" data-timeline-role="music" src="music.wav" data-start="0" data-duration="${duration}" data-track-index="0"></audio></div></body></html>`,
  );
  const run = await runBeats(work);
  const beatFile = join(work, "beats", "music.wav.json");
  if (run.code !== 0 || !existsSync(beatFile)) return { beats: [], bpm: null };
  const data = JSON.parse(readFileSync(beatFile, "utf-8"));
  let bpm = null;
  try {
    bpm = JSON.parse(run.stdout.trim()).bpm ?? null;
  } catch {
    bpm = null;
  }
  return { beats: (data.beats ?? []).map((beat) => beat.time).filter(Number.isFinite), bpm };
}

/**
 * The structure of a reference edit: its cuts, how much moves in each shot, the shots' colours and the
 * beats of its music. Nothing of the reference is kept but these numbers and a small sheet of its shots.
 *
 * @param {{ file: string, sheet?: string, sensitivity?: string, runBeats: (dir: string) => Promise<{ code: number | null, stdout: string }> }} request
 */
export async function analyzeReference({ file, sheet, sensitivity = "normal", runBeats }) {
  const probe = await probeMedia(file);
  const video = (probe.streams ?? []).find((stream) => stream.codec_type === "video");
  if (!video?.width || !video?.height) throw new Error("The reference has no video stream.");
  const duration = Number(probe.format?.duration) || Number(video.duration);
  if (!duration) throw new Error("The reference has no duration.");
  const hasAudio = (probe.streams ?? []).some((stream) => stream.codec_type === "audio");

  const frames = await scoreFrames(file);
  if (frames.length < 2) throw new Error("The reference is too short to analyse.");
  const cuts = detectCuts(frames, { sensitivity });
  if (cuts.length + 1 > MAX_SHOTS) {
    throw new Error(
      `The reference has ${cuts.length + 1} shots; up to ${MAX_SHOTS} are supported. Try sensitivity 'low'.`,
    );
  }
  const shots = shotsFromCuts(frames, cuts, duration);

  const work = mkdtempSync(join(tmpdir(), "glintmotion-reference-"));
  try {
    const colors = await averageColors(
      file,
      shots.map((shot) => shot.frame),
      work,
    );
    shots.forEach((shot, i) => {
      shot.color = hex(colors[i]);
      shot.brightness = round(
        (0.2126 * colors[i][0] + 0.7152 * colors[i][1] + 0.0722 * colors[i][2]) / 255,
        2,
      );
    });
    const sheetShots = sheet ? await shotSheet(file, shots, sheet) : null;
    const { beats, bpm } = hasAudio
      ? await referenceBeats(file, duration, runBeats, work)
      : { beats: [], bpm: null };
    const lengths = shots.map((shot) => shot.duration);
    return {
      width: video.width,
      height: video.height,
      durationSeconds: round(duration),
      resolution: resolutionFor(video.width, video.height),
      shotCount: shots.length,
      averageShotSeconds: round(duration / shots.length, 2),
      shortestShotSeconds: round(Math.min(...lengths), 2),
      longestShotSeconds: round(Math.max(...lengths), 2),
      bpm,
      cutsOnBeat: cutsOnBeat(shots, beats),
      beats: beats.map((beat) => round(beat)),
      shots: shots.map(({ frame: _frame, ...shot }) => shot),
      ...(sheetShots && { sheetShots }),
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** The composition: one `<video id="shot-NN">` per shot, back to back on one track, cut like the reference. */
export function compositionHtml({ resolution, shots, duration, title }) {
  const [width, height] = RESOLUTION_SIZES[resolution];
  const videos = shots
    .map(
      (shot) =>
        `      <video id="${shot.id}" class="shot" src="${SHOTS_DIR}/${shot.id}.mp4" muted playsinline data-start="${shot.start}" data-duration="${shot.duration}" data-track-index="1"></video>`,
    )
    .join("\n");
  const resolutionAttribute = resolution === "post" ? "" : ` data-resolution="${resolution}"`;
  return `<!doctype html>
<html lang="fr"${resolutionAttribute}>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${width}, height=${height}" />
    <title>${title.replace(/[<>&"]/g, "")}</title>
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>
      * {
        margin: 0;
        padding: 0;
        box-sizing: border-box;
      }
      html,
      body {
        margin: 0;
        width: ${width}px;
        height: ${height}px;
        overflow: hidden;
        background: #0a0a0a;
      }
      #root {
        position: relative;
        width: 100%;
        height: 100%;
        overflow: hidden;
      }
      .shot {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        object-fit: cover;
      }
    </style>
  </head>
  <body>
    <div
      id="root"
      data-composition-id="main"
      data-start="0"
      data-duration="${duration}"
      data-width="${width}"
      data-height="${height}"
    >
${videos}
    </div>
    <script>
      const tl = gsap.timeline({ paused: true });
      window.__timelines["main"] = tl;
      tl.seek(0);
    </script>
  </body>
</html>
`;
}

/** A solid-colour clip that holds a shot's place until a real take replaces it. */
async function writePlaceholder(output, { width, height, color, seconds }) {
  const { code, stderr } = await runFfmpeg([
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=c=0x${color.slice(1)}:s=${width}x${height}:r=${PLACEHOLDER_FPS}:d=${seconds}`,
    "-c:v",
    "h264_videotoolbox",
    "-q:v",
    "50",
    "-g",
    String(PLACEHOLDER_FPS),
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    output,
  ]);
  if (code !== 0)
    throw new Error(`A placeholder shot could not be encoded. ${stderr.slice(-400)}`.trim());
}

/**
 * Lays the reference's structure out in a fresh project: the composition, one placeholder clip per shot,
 * and reference/analysis.json for the agent.
 */
export async function writeReferenceProject({ dir, analysis, resolution, duration, title }) {
  const shots = scaleShots(analysis.shots, analysis.durationSeconds, duration);
  const total = round(shots.at(-1).start + shots.at(-1).duration);
  const [width, height] = RESOLUTION_SIZES[resolution];
  mkdirSync(join(dir, SHOTS_DIR), { recursive: true });
  for (const shot of shots) {
    await writePlaceholder(join(dir, SHOTS_DIR, `${shot.id}.mp4`), {
      width,
      height,
      color: placeholderColor(hexToRgb(shot.color)),
      seconds: shot.duration,
    });
  }
  writeFileSync(
    join(dir, "index.html"),
    compositionHtml({ resolution, shots, duration: total, title }),
  );
  mkdirSync(join(dir, REFERENCE_DIR), { recursive: true });
  const scale = total / analysis.durationSeconds;
  const saved = {
    ...analysis,
    builtDurationSeconds: total,
    beats: analysis.beats.map((beat) => round(beat * scale)),
    shots,
  };
  writeFileSync(join(dir, REFERENCE_DIR, "analysis.json"), `${JSON.stringify(saved, null, 2)}\n`);
  return { shots, durationSeconds: total };
}

/** What the studio's agent receives for a project built from Home's « Refaire un montage ». */
export function referencePrompt({ source, analysis, built }) {
  const last = built.shots.at(-1).id;
  const tempo = analysis.bpm ? ` à environ ${analysis.bpm} bpm` : "";
  return [
    `Ce projet reprend le montage de « ${source} » : ${built.shots.length} plans sur ${built.durationSeconds} s${analysis.bpm ? `, musique à ${analysis.bpm} bpm` : ""}.`,
    `Les plans shot-01 à ${last} sont des aplats de couleur en attente. La planche des plans est dans reference/shots.jpg, l'analyse dans reference/analysis.json.`,
    "1. Regarde reference/shots.jpg. Si je n'ai pas dit ce que la vidéo doit montrer, demande-le-moi avant d'aller plus loin.",
    "2. glintmotion_session begin.",
    `3. glintmotion_generate_music pour ${built.durationSeconds} s${tempo}, puis glintmotion_reference snap pour caler les coupes sur ses temps.`,
    "4. Remplis chaque plan avec glintmotion_fit_video ou glintmotion_simulator_take, video et name = l'id du plan.",
    "5. glintmotion_check, glintmotion_contact_sheet, puis glintmotion_session end.",
  ].join("\n");
}

function hexToRgb(color) {
  return [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16));
}

/**
 * Moves each cut onto the nearest beat within `tolerance` seconds. The first start and the last end stay;
 * a cut that would leave a shot shorter than MIN_SHOT_SECONDS stays where it is.
 */
export function snapCuts(shots, beats, tolerance = DEFAULT_SNAP_SECONDS) {
  const ends = shots.map((shot) => round(shot.start + shot.duration));
  const moved = [];
  for (let n = 0; n < shots.length - 1; n++) {
    const cut = ends[n];
    const beat = beats.reduce(
      (best, time) => (Math.abs(time - cut) < Math.abs(best - cut) ? time : best),
      Infinity,
    );
    if (!Number.isFinite(beat) || Math.abs(beat - cut) > tolerance || Math.abs(beat - cut) < 1e-3)
      continue;
    const previousEnd = n === 0 ? shots[0].start : ends[n - 1];
    if (beat - previousEnd < MIN_SHOT_SECONDS || ends[n + 1] - beat < MIN_SHOT_SECONDS) continue;
    moved.push({ cut: n + 1, from: cut, to: round(beat) });
    ends[n] = round(beat);
  }
  const snapped = shots.map((shot, n) => {
    const start = n === 0 ? shot.start : ends[n - 1];
    return { ...shot, start, duration: round(ends[n] - start) };
  });
  return { shots: snapped, moved };
}

/** The shots of the open composition: its `<video id="shot-NN">` elements in time order. */
export function readShots(html) {
  const shots = [];
  for (const match of html.matchAll(/<video\b[^>]*\bid=(["'])(shot-\d+)\1[^>]*>/gs)) {
    const tag = match[0];
    const start = Number(/\sdata-start=(["'])([\d.]+)\1/.exec(tag)?.[2]);
    const duration = Number(/\sdata-duration=(["'])([\d.]+)\1/.exec(tag)?.[2]);
    if (Number.isFinite(start) && Number.isFinite(duration))
      shots.push({ id: match[2], start, duration });
  }
  return shots.sort((a, b) => a.start - b.start);
}

/** Writes new start and duration on each shot's `<video>`, leaving every other attribute as it was. */
export function retimeShots(html, shots) {
  let next = html;
  for (const shot of shots) {
    const video = findVideo(next, shot.id);
    if (!video) throw new Error(`No <video id="${shot.id}"> in the composition.`);
    const tag = video.tag
      .replace(/(\sdata-start=)(["'])[\d.]+\2/, `$1$2${shot.start}$2`)
      .replace(/(\sdata-duration=)(["'])[\d.]+\2/, `$1$2${shot.duration}$2`);
    next = next.slice(0, video.index) + tag + next.slice(video.index + video.tag.length);
  }
  return next;
}
