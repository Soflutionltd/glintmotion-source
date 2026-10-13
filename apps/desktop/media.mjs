import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ELEVEN_MUSIC_URL = "https://api.elevenlabs.io/v1/music?output_format=mp3_48000_192";
const MUSIC_TIMEOUT_MS = 5 * 60_000;
/** The studio's loudness meter target: a bed at this level does not light its "too loud" warning. */
const MUSIC_LUFS = -16;
/** The LGPL ffmpeg built by scripts/build-ffmpeg.sh: Resources/ffmpeg in the app, vendor/ffmpeg in a checkout. */
export const BUNDLED_FFMPEG_DIR = process.resourcesPath && existsSync(join(process.resourcesPath, "ffmpeg"))
  ? join(process.resourcesPath, "ffmpeg")
  : join(dirname(fileURLToPath(import.meta.url)), "vendor", "ffmpeg");
// Homebrew's build first: it has libx264, which the bundled LGPL build cannot include.
const FFMPEG_CANDIDATES = [
  "/opt/homebrew/bin/ffmpeg",
  "/usr/local/bin/ffmpeg",
  join(BUNDLED_FFMPEG_DIR, "ffmpeg"),
  "/Applications/CompressKit.app/Contents/MacOS/ffmpeg",
];

export const DELIVERY_PRESETS = {
  reel: { label: "Reel 9:16", size: [1080, 1920] },
  post: { label: "Post 4:5", size: [1080, 1350] },
  square: { label: "Carré 1:1", size: [1080, 1080] },
  original: { label: "Format d'origine", size: null },
};

function findFfmpeg() {
  const found = FFMPEG_CANDIDATES.find((candidate) => existsSync(candidate));
  if (!found) throw new Error("ffmpeg est introuvable sur ce Mac (brew install ffmpeg).");
  return found;
}

function findFfprobe() {
  const found = FFMPEG_CANDIDATES.map((candidate) => join(dirname(candidate), "ffprobe")).find((candidate) =>
    existsSync(candidate),
  );
  if (!found) throw new Error("ffprobe est introuvable sur ce Mac (brew install ffmpeg).");
  return found;
}

export function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(findFfmpeg(), ["-hide_banner", ...args], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stderr }));
  });
}

/** ffprobe's JSON description of a media file (format and streams). */
export function probeMedia(file) {
  return new Promise((resolve, reject) => {
    const args = ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file];
    const child = spawn(findFfprobe(), args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(JSON.parse(stdout));
      else reject(new Error(`ffprobe n'a pas pu lire ${basename(file)}. ${stderr.slice(-300)}`.trim()));
    });
  });
}

/** The ElevenLabs key, encrypted with a key macOS keeps in the Keychain (Electron safeStorage). */
export function createKeyStore(file, safeStorage) {
  return {
    has: () => existsSync(file) || Boolean(process.env.ELEVENLABS_API_KEY),
    read() {
      if (existsSync(file)) return safeStorage.decryptString(readFileSync(file));
      if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY;
      throw new Error("Aucune clé ElevenLabs enregistrée.");
    },
    save(key) {
      const value = String(key ?? "").trim();
      if (!/^[A-Za-z0-9_-]{20,200}$/.test(value)) throw new Error("Cette clé ElevenLabs n'a pas le bon format.");
      if (!safeStorage.isEncryptionAvailable()) throw new Error("Le Trousseau du Mac n'est pas disponible.");
      writeFileSync(file, safeStorage.encryptString(value), { mode: 0o600 });
    },
    clear: () => rmSync(file, { force: true }),
  };
}

async function elevenError(response) {
  if (response.status === 401) return "Clé ElevenLabs refusée.";
  let detail = "";
  try {
    const body = await response.json();
    detail = body?.detail?.message ?? body?.detail?.status ?? JSON.stringify(body?.detail ?? body);
  } catch {
    detail = "";
  }
  return `ElevenLabs a refusé la demande (${response.status}). ${String(detail).slice(0, 300)}`.trim();
}

/** Composes an instrumental bed for the project, cut to `seconds` with a fade on its last beat. */
export async function generateMusic({ projectDir, prompt, seconds, apiKey }) {
  const text = String(prompt ?? "").trim();
  if (!text) throw new Error("Décris la musique voulue.");
  if (text.length > 4000) throw new Error("Description trop longue (4000 caractères au plus).");
  const length = Number(seconds);
  if (!Number.isFinite(length) || length < 3 || length > 600) {
    throw new Error("La durée doit être comprise entre 3 et 600 secondes.");
  }

  const response = await fetch(ELEVEN_MUSIC_URL, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: text,
      music_length_ms: Math.round(length * 1000),
      model_id: "music_v2_5",
      force_instrumental: true,
    }),
    signal: AbortSignal.timeout(MUSIC_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(await elevenError(response));

  const raw = join(tmpdir(), `glintmotion-music-${process.pid}-${Date.now()}.mp3`);
  writeFileSync(raw, Buffer.from(await response.arrayBuffer()));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const relative = join("assets", "music", `music_${stamp}.m4a`);
  const output = join(projectDir, relative);
  mkdirSync(join(projectDir, "assets", "music"), { recursive: true });
  const fade = Math.min(1.2, length / 4);
  try {
    const { code, stderr } = await runFfmpeg([
      "-y",
      "-i",
      raw,
      "-t",
      length.toFixed(3),
      "-af",
      `loudnorm=I=${MUSIC_LUFS}:TP=-1.5:LRA=11,afade=t=out:st=${(length - fade).toFixed(3)}:d=${fade.toFixed(3)}`,
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-ar",
      "48000",
      output,
    ]);
    if (code !== 0) throw new Error(`La musique n'a pas pu être préparée. ${stderr.slice(-300)}`.trim());
  } finally {
    rmSync(raw, { force: true });
  }
  return relative;
}

function hexColor(value) {
  const color = String(value ?? "").trim();
  if (!color) return "black";
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new Error(`Couleur invalide : ${color}`);
  return `0x${color.slice(1)}`;
}

/** Re-encodes a finished render for social feeds: framed to the preset, HEVC, mixed to -14 LUFS. */
export async function deliverRender({ projectDir, filename, preset, color }) {
  const name = basename(String(filename ?? ""));
  if (!name || name !== filename) throw new Error("Nom de rendu invalide.");
  const source = join(projectDir, "renders", name);
  if (!existsSync(source)) throw new Error(`Rendu introuvable : ${name}`);
  const target = DELIVERY_PRESETS[preset];
  if (!target) throw new Error(`Format inconnu : ${preset}`);

  const probe = await runFfmpeg(["-i", source]);
  const hasAudio = /Stream #\d+:\d+.*: Audio:/.test(probe.stderr);
  const output = join(projectDir, "renders", `${basename(name, extname(name))}_${preset}.mp4`);

  const filters = [];
  if (target.size) {
    const [width, height] = target.size;
    filters.push(
      `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${hexColor(color)}`,
    );
  }
  filters.push("setsar=1");

  const { code, stderr } = await runFfmpeg([
    "-y",
    "-i",
    source,
    "-vf",
    filters.join(","),
    "-c:v",
    "hevc_videotoolbox",
    "-q:v",
    "65",
    "-profile:v",
    "main",
    "-pix_fmt",
    "nv12",
    "-tag:v",
    "hvc1",
    ...(hasAudio
      ? ["-af", "loudnorm=I=-14:TP=-1.5:LRA=11", "-c:a", "aac", "-b:a", "192k", "-ar", "48000"]
      : ["-an"]),
    "-movflags",
    "+faststart",
    output,
  ]);
  if (code !== 0) throw new Error(`L'export ${target.label} a échoué. ${stderr.slice(-300)}`.trim());
  return output;
}
