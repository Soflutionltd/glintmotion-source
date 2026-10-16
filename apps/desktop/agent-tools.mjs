import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, normalize } from "node:path";
import { addEffectArgs, loadEffectsCatalog, searchEffects } from "./effects.mjs";
import { DELIVERY_PRESETS, probeMedia, runFfmpeg } from "./media.mjs";
import {
  cancelSimulatorTake,
  DEFAULT_FPS,
  fitVideoIntoScene,
  MAX_TAKE_SECONDS,
  saveTake,
  startSimulatorTake,
  stopSimulatorTake,
} from "./takes.mjs";
import { MAX_SERIES, SERIES_FILE } from "./templates.mjs";

/** Engine commands an agent may run. Rendering has its own job tool; the rest open UIs, accounts or the network. */
export const CLI_COMMANDS = [
  "add",
  "beats",
  "catalog",
  "check",
  "clean",
  "compare",
  "compositions",
  "doctor",
  "history",
  "info",
  "inspect",
  "keyframes",
  "layout",
  "lint",
  "media-treatment",
  "media-use",
  "normalize-audio",
  "remove-background",
  "snapshot",
  "timeline",
  "transcribe",
  "tts",
];
const CLI_TIMEOUT_S = 120;
const CLI_MAX_TIMEOUT_S = 900;
const OUTPUT_TAIL = 30_000;
const RENDER_WAIT_S = 50;
const MAX_WAIT_S = 600;
const MAX_SHEET_FRAMES = 24;
const MAX_SERIES_TIMES = 8;
const MOTION_TWEENS = 120;
const MAX_MOTION_TWEENS = 400;
const FRAME_FETCH_PARALLEL = 3;
const MEDIA_VIEWS = ["probe", "loudness", "waveform", "filmstrip"];
const SESSION_ACTIONS = ["begin", "end", "undo", "changes", "list", "show"];
const SHARE_FOLDERS = ["renders", "snapshots"];
const SIGNED_UPLOAD_PATH = "/storage/v1/object/upload/sign/";
const UPLOAD_TYPES = { ".mp4": "video/mp4", ".mov": "video/quicktime", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const TAKE_ACTIONS = ["start", "stop", "cancel"];
const TAKE_FIT_PROPERTIES = {
  video: { type: "string", description: "id of the <video> element in the scene that plays the take." },
  composition: { type: "string", description: "Project-relative composition file. Default index.html." },
  name: { type: "string", description: "File name for the take, e.g. 'switch'. Saved as <name>.mp4." },
  output: {
    type: "string",
    description: "Project-relative .mp4 path, e.g. assets/rec/en/switch.mp4. Overrides name and the default folder.",
  },
  rewire: {
    type: "boolean",
    default: true,
    description:
      "false saves the file without touching the composition, for a variant (another language) fed through the video's variable at render time.",
  },
  from: { type: "number", minimum: 0, default: 0, description: "Skip this many seconds at the start of the file." },
  fps: { type: "number", minimum: 1, maximum: 120, default: DEFAULT_FPS },
};

export const text = (value) => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});
export const failure = (message) => ({ content: [{ type: "text", text: message }], isError: true });
const image = (buffer, mimeType) => ({ type: "image", data: buffer.toString("base64"), mimeType });

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const tail = (value, size) => (value.length > size ? `…${value.slice(-size)}` : value);

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function parseJson(output) {
  const trimmed = output.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const last = trimmed.split("\n").reverse().find((line) => line.startsWith("{"));
    try {
      return last ? JSON.parse(last) : null;
    } catch {
      return null;
    }
  }
}

function frameRate(value) {
  const [num, den] = String(value ?? "").split("/").map(Number);
  return num && den ? Math.round((num / den) * 1000) / 1000 : null;
}

function summarizeProbe(file, probe) {
  const format = probe.format ?? {};
  return {
    file,
    container: format.format_name ?? null,
    durationSeconds: Number(format.duration) || null,
    sizeBytes: Number(format.size) || null,
    bitRate: Number(format.bit_rate) || null,
    streams: (probe.streams ?? []).map((stream) => ({
      index: stream.index,
      type: stream.codec_type,
      codec: stream.codec_name,
      durationSeconds: Number(stream.duration) || null,
      ...(stream.codec_type === "video" && {
        width: stream.width,
        height: stream.height,
        fps: frameRate(stream.avg_frame_rate),
        pixelFormat: stream.pix_fmt,
        // VP9 in WebM keeps alpha in a side stream and only says so in a tag.
        alpha:
          /^(yuva|gbrap|ya\d|rgba|argb|bgra|abgr)/.test(String(stream.pix_fmt ?? "")) ||
          stream.tags?.alpha_mode === "1",
      }),
      ...(stream.codec_type === "audio" && {
        sampleRate: Number(stream.sample_rate) || null,
        channels: stream.channels,
        channelLayout: stream.channel_layout ?? null,
      }),
    })),
  };
}

function loudnessOf(stderr) {
  const summary = stderr.slice(stderr.lastIndexOf("Summary:"));
  const read = (pattern) => {
    const match = pattern.exec(summary);
    return match ? Number(match[1]) : null;
  };
  return {
    integratedLufs: read(/I:\s+(-?[\d.]+) LUFS/),
    loudnessRangeLu: read(/LRA:\s+(-?[\d.]+) LU/),
    truePeakDbfs: read(/Peak:\s+(-?[\d.]+) dBFS/),
  };
}

export const AGENT_TOOLS = [
  {
    name: "glintmotion_create_project",
    description:
      "Create a new, blank Glintmotion project folder and open it in the studio. Returns its path.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Folder name: letters, digits, spaces, dashes, dots." },
        resolution: {
          type: "string",
          enum: ["portrait", "post", "landscape", "square"],
          default: "portrait",
          description: "portrait 1080×1920, post 1080×1350 (Instagram feed), landscape 1920×1080, square 1080×1080.",
        },
        parent: { type: "string", description: "Absolute folder to create it in. Default ~/Movies/Glintmotion." },
        open: { type: "boolean", default: true },
      },
      required: ["name"],
    },
  },
  {
    name: "glintmotion_session",
    description: [
      "Group your edits into one undoable turn in the project's history, and see what the person changed.",
      "begin {label} before editing; end when done; undo reverts your whole last turn (or one `entry`);",
      "changes lists what was changed since your last turn (by the person or other agents);",
      "list shows the newest entries; show {entry, diff} shows one entry's files.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: SESSION_ACTIONS },
        label: { type: "string", description: "For begin: what this turn does, e.g. 'Tighten intro timing'." },
        agent: { type: "string", description: "Your name in the history. Default 'Agent'." },
        entry: { type: "string", description: "For undo/show: an entry id (or prefix) from list." },
        diff: { type: "boolean", description: "For show: include a text diff." },
      },
      required: ["action"],
    },
  },
  {
    name: "glintmotion_check",
    description: [
      "Audit the open project the way a reviewer would: lint, layout overlaps, text contrast, broken or",
      "browser-hostile media, sampled across the timeline. Returns the engine's JSON report.",
      "Run it after editing and before rendering.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        strict: { type: "boolean", description: "Also fail on warnings." },
        at: { type: "array", items: { type: "number", minimum: 0 }, description: "Extra times to sample (s)." },
        fix: {
          type: "boolean",
          description:
            "First rewrite the project files to apply the findings marked fixable (eases that freeze text, text scale origin, will-change on scaled text). Call inside a glintmotion_session so it can be undone.",
        },
        variables: {
          type: "object",
          description: "Check with these variable values, e.g. one row of series.json, so a long headline is caught before export.",
        },
      },
    },
  },
  {
    name: "glintmotion_motion_check",
    description: [
      "Watch every moving element frame by frame, the way the render will draw it, and report motion that",
      "reads badly: stall (stops then moves again), tail_tick (settles, jumps one more pixel, stops),",
      "early_finish / late_start (a third or more of the tween shows no movement), judder (text that shakes",
      "while it scales or moves). Each finding gives the target, its tween's times, the per-frame pattern",
      "(m = moved, = same pixels) and a fix. Each element is measured alone, so grain and video do not hide",
      "anything. Run it after glintmotion_check when the video has text in motion. About 0.3 s per tween.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "number", minimum: 0, description: "Only tweens running after this time (s)." },
        to: { type: "number", minimum: 0, description: "Only tweens starting before this time (s)." },
        max_tweens: { type: "integer", minimum: 1, maximum: MAX_MOTION_TWEENS, default: MOTION_TWEENS },
      },
    },
  },
  {
    name: "glintmotion_contact_sheet",
    description: [
      "One image showing the whole video as a grid of frames, so you can judge pacing, layout and",
      "consistency at a glance instead of capturing frames one by one. Frames are rendered from the files",
      "on disk. Saved under snapshots/ and returned as an image with the time of each tile (row by row).",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        count: { type: "integer", minimum: 1, maximum: MAX_SHEET_FRAMES, default: 8 },
        times: {
          type: "array",
          items: { type: "number", minimum: 0 },
          maxItems: MAX_SHEET_FRAMES,
          description: "Exact times in seconds instead of evenly spaced ones.",
        },
        columns: { type: "integer", minimum: 1, maximum: 8, default: 4 },
        width: { type: "integer", minimum: 120, maximum: 960, default: 360, description: "Tile width (px)." },
      },
    },
  },
  {
    name: "glintmotion_inspect_media",
    description: [
      "Understand a media file before using it: probe (codec, size, duration, fps, alpha, audio layout),",
      "loudness (integrated LUFS, range, true peak), waveform (image of the audio), filmstrip (image of",
      "8 frames across a video). For beats run glintmotion_cli ['beats','--json']; for words,",
      "['transcribe', file, '--json'].",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Project-relative path, or an absolute path on this Mac." },
        views: { type: "array", items: { type: "string", enum: MEDIA_VIEWS }, default: ["probe"] },
      },
      required: ["path"],
    },
  },
  {
    name: "glintmotion_fit_video",
    description: [
      "Put a video file into a scene's <video id>: encoded to that element's data-duration (the last frame is",
      "held when the file is shorter, the end is cut when it is longer), at the previous take's size when the",
      "framing matches, constant frame rate, no audio. Saved at `output`, else next to the previous take (else",
      "assets/rec/); the element's src and the default of its data-var-src variable then point at it, unless rewire",
      "is false (the result then gives the renderVariables that select the file). Call inside a glintmotion_session.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Project-relative path, or an absolute path on this Mac." },
        ...TAKE_FIT_PROPERTIES,
      },
      required: ["source", "video"],
    },
  },
  {
    name: "glintmotion_simulator_take",
    description: [
      "Film the iOS Simulator for a scene. start records the booted simulator (udid when several are booted)",
      "and returns once recording has begun; drive the app (sim-mirror or another tool); stop ends the take.",
      "With `video`, stop fits the take into that <video id> like glintmotion_fit_video. Without it, the take is",
      "saved under assets/rec/ at its real length: simctl writes no frame while the screen is still, so the last",
      `frame is held up to the moment of stop. cancel drops the take. A take stops itself after ${MAX_TAKE_SECONDS} s.`,
      "start with `locale` films in another language: the simulator's language is switched, `app` is relaunched in",
      "it, and stop or cancel put the language back and relaunch the app again.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: TAKE_ACTIONS },
        udid: { type: "string", description: "For start: the simulator to film. Default: the only booted one." },
        locale: { type: "string", description: "For start: the language to film in, e.g. en-US or fr_FR." },
        app: {
          type: "string",
          description: "For start: bundle id relaunched before recording (in `locale` when given), e.g. com.example.app.",
        },
        settle: {
          type: "number",
          minimum: 0,
          maximum: 30,
          default: 3,
          description: "For start with app: seconds the relaunched app gets before recording starts.",
        },
        ...TAKE_FIT_PROPERTIES,
      },
      required: ["action"],
    },
  },
  {
    name: "glintmotion_generate_music",
    description: [
      "Compose an instrumental music bed with ElevenLabs (key set by the user in the Music panel),",
      "levelled to -16 LUFS with a fade-out, saved under assets/music/ and placed on the timeline.",
      "Takes 20 s to 2 min.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Style, mood, tempo, instruments." },
        seconds: { type: "number", minimum: 3, maximum: 600, description: "Usually the video's duration." },
        start: { type: "number", minimum: 0, default: 0 },
        track: { type: "integer", minimum: 0, description: "Default: a new track below the others." },
        place: { type: "boolean", default: true, description: "false = only save the file." },
      },
      required: ["prompt", "seconds"],
    },
  },
  {
    name: "glintmotion_render",
    description: [
      "Export the open project with the Glintmotion engine, as a background job.",
      `Waits up to wait_seconds (default ${RENDER_WAIT_S}) and returns the output path if it finished,`,
      "otherwise the job id and progress: then call glintmotion_render_status. One render at a time.",
      "`variables` fills the composition's data-composition-variables; `batch` renders one file per row;",
      `\`series: true\` renders the project's ${SERIES_FILE}, one file per version named after its \`name\`.`,
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        format: { type: "string", enum: ["mp4", "webm", "mov", "gif"], default: "mp4" },
        quality: { type: "string", enum: ["draft", "looks", "delivery"], default: "looks" },
        fps: { type: "number", minimum: 1, maximum: 240 },
        resolution: {
          type: "string",
          enum: ["landscape", "portrait", "square", "landscape-4k", "portrait-4k", "square-4k"],
        },
        composition: { type: "string", description: "Project-relative composition file. Default index.html." },
        from: { type: "number", minimum: 0, description: "Start time in seconds." },
        to: { type: "number", minimum: 0, description: "End time in seconds." },
        variables: { type: "object", description: "Variable values for this render." },
        batch: {
          type: "array",
          items: { type: "object" },
          description: "Variable rows; outputs land in renders/<project>_<stamp>/<index>.<format>.",
        },
        series: { type: "boolean", description: `Render ${SERIES_FILE} instead of \`batch\`.` },
        wait_seconds: { type: "number", minimum: 0, maximum: MAX_WAIT_S },
      },
    },
  },
  {
    name: "glintmotion_render_status",
    description:
      "Progress of a render job (status, %, stage, output). Waits up to wait_seconds for it to finish. Without `job`, lists recent jobs.",
    inputSchema: {
      type: "object",
      properties: {
        job: { type: "string" },
        wait_seconds: { type: "number", minimum: 0, maximum: MAX_WAIT_S, default: 0 },
      },
    },
  },
  {
    name: "glintmotion_render_cancel",
    description: "Stop a running render job.",
    inputSchema: { type: "object", properties: { job: { type: "string" } }, required: ["job"] },
  },
  {
    name: "glintmotion_deliver",
    description: [
      "Make a social-ready copy of a finished render: framed to the preset (padding in `color`), HEVC,",
      "audio mixed to -14 LUFS. Returns the new file's path in renders/.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        render: { type: "string", description: "A file in the project's renders/ folder (name or path)." },
        preset: { type: "string", enum: Object.keys(DELIVERY_PRESETS) },
        color: { type: "string", pattern: "^#[0-9a-fA-F]{6}$", default: "#000000" },
      },
      required: ["render", "preset"],
    },
  },
  {
    name: "glintmotion_upload",
    description: [
      "Send a file from the project's renders/ or snapshots/ folder to a signed upload URL, e.g. the",
      "upload URL a publishing service's MCP hands out, then give that service the media URL it returns.",
      "Only Supabase Storage signed upload URLs are accepted; MP4, MOV or JPEG up to 50 MB.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "A file name or path inside renders/ or snapshots/." },
        upload_url: { type: "string", description: "https URL containing /storage/v1/object/upload/sign/." },
      },
      required: ["file", "upload_url"],
    },
  },
  {
    name: "glintmotion_list_templates",
    description: [
      "The projects the person marked as templates, with size, duration and the variables each declares",
      "(id, type, label, default, options). A template with variables can become a series.",
    ].join(" "),
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "glintmotion_create_series",
    description: [
      "Make a series from a template that declares variables: a copy of the template whose",
      `${SERIES_FILE} holds one row of variable values per version, opened in the studio. The design stays`,
      "the template's; only the variables change. Then glintmotion_series_sheet, glintmotion_check with",
      "each row's variables, and glintmotion_render with series: true.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        template: { type: "string", description: "A template's path or folder name from glintmotion_list_templates." },
        rows: {
          type: "array",
          minItems: 1,
          maxItems: MAX_SERIES,
          items: { type: "object" },
          description:
            "One object per version: a short unique `name` (it names the exported file) plus only the variables that change. Empty text variables keep the template's text.",
        },
        name: { type: "string", description: "Project folder name. Default '<template> série'." },
        open: { type: "boolean", default: true },
      },
      required: ["template", "rows"],
    },
  },
  {
    name: "glintmotion_series_sheet",
    description: [
      `One image comparing every version of the open series project (${SERIES_FILE}) at the same times: one row`,
      "per version, one column per time. Also lists `repeated`: lines of copy shown in several versions but",
      "not all, which usually means two versions say the same thing. Saved under snapshots/.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        at: {
          type: "array",
          minItems: 1,
          maxItems: MAX_SERIES_TIMES,
          items: { type: "number", minimum: 0 },
          description: "Times (s) when the texts that vary are on screen.",
        },
      },
      required: ["at"],
    },
  },
  {
    name: "glintmotion_cli",
    description: [
      "Run a Glintmotion engine command in the open project (or `dir`) and return its output, parsed when",
      "it is JSON. Pass --json where the command supports it. Useful: timeline --json, timeline move/trim/split,",
      "keyframes --json, beats --json, transcribe <file> --json, tts, snapshot --at 1,2.5, compositions,",
      "catalog --query, add <block>, lint, layout, inspect, normalize-audio, doctor --json.",
      `Allowed commands: ${CLI_COMMANDS.join(", ")}. Run '<command> --help' for flags.`,
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        args: { type: "array", items: { type: "string" }, minItems: 1, description: "e.g. ['timeline','--json']" },
        dir: { type: "string", description: "Absolute folder to run in. Default: the open project." },
        timeout_seconds: { type: "number", minimum: 1, maximum: CLI_MAX_TIMEOUT_S, default: CLI_TIMEOUT_S },
      },
      required: ["args"],
    },
  },
  {
    name: "glintmotion_effects",
    description: [
      "Search the Glintmotion Effects catalog: each item's name, title, description (with how to use it),",
      "tags, license and author. Every word of the query must match. Without query nor tag it lists the first",
      "items and the total. The catalog is cached for a day and still answers offline.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "e.g. 'cube', 'page curl', 'glitch'." },
        tag: { type: "string", description: "e.g. 'transition', '3d', 'wipe'." },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 40 },
      },
    },
  },
  {
    name: "glintmotion_add_effect",
    description: [
      "Install an effect from the Glintmotion Effects catalog into the open project (or `dir`), with the items",
      "it depends on. Returns the files written. The project's hyperframes.json keeps its own catalog.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "An item name from glintmotion_effects, e.g. gl-cube." },
        dir: { type: "string", description: "Absolute project folder. Default: the open project." },
      },
      required: ["name"],
    },
  },
];

export const MCP_INSTRUCTIONS = [
  "Glintmotion edits motion-design videos written as HTML (HyperFrames compositions) in the Glintmotion desktop app, while the person watches the studio.",
  "Loop that works:",
  "1. glintmotion_current_project (or glintmotion_open_project / glintmotion_create_project).",
  "2. glintmotion_session begin with a label, so the person can undo your whole turn in one step.",
  "3. Look: studio_look for the structure, glintmotion_contact_sheet for the whole video, studio_frame for one instant.",
  "4. Edit with the studio_* tools (timeline, text, style, animation) or by editing the project files; the studio reloads.",
  "5. Verify: glintmotion_check (fix: true applies the findings marked fixable), glintmotion_motion_check when text moves, then a contact sheet. Fix what they show before going on.",
  "6. glintmotion_session end.",
  "7. Export: glintmotion_render (background job; poll glintmotion_render_status), then glintmotion_deliver for a Reel or Post file.",
  "8. Publish: ask the publishing service's MCP for a signed upload URL, glintmotion_upload to it, then give the service the returned media URL.",
  "Series (several versions of one design): glintmotion_list_templates, glintmotion_create_series with one row of variables per version, glintmotion_series_sheet (rewrite the lines it reports as repeated), glintmotion_check with each row's variables, then glintmotion_render with series: true.",
  "Text in motion: follow the motion-quality skill (moderate eases on y, scale from the baseline, no will-change on scaled text), then glintmotion_motion_check.",
  "Media: glintmotion_inspect_media before placing a file; glintmotion_generate_music for a bed.",
  "App footage: glintmotion_simulator_take start, drive the simulator, then stop with the scene's `video` id; glintmotion_fit_video does the same for a file already recorded. Another language: start with locale and app, stop with output and rewire false.",
  "Effects: glintmotion_effects searches the Glintmotion Effects catalog (shader transitions such as gl-cube, gl-wind…), glintmotion_add_effect installs one; a transition then loads vendor/glintmotion/hyper-shader.js in place of the HyperShader CDN script, plus its own file. The HyperFrames catalog stays on glintmotion_cli catalog/add.",
  "Other engine commands (timeline, keyframes, beats, transcribe, tts, catalog, add…) go through glintmotion_cli.",
].join("\n");

/**
 * @param {{
 *   projectDir: () => string,
 *   projectInfo: () => { duration: number | null } | null,
 *   runEngine: (args: string[], cwd: string) => import("node:child_process").ChildProcess,
 *   studioCall: (name: string, args: object) => Promise<any>,
 *   studioUrl: () => string | null,
 *   motionProbe: (request: { from?: number, to?: number, maxTweens: number }) => Promise<object>,
 *   generateMusic: (request: { prompt: string, seconds: number }) => Promise<string>,
 *   deliver: (request: { filename: string, preset: string, color: string }) => Promise<string>,
 *   createProject: (request: { name: string, parent: string, resolution: string }) => Promise<string>,
 *   openProject: (dir: string) => Promise<void>,
 *   defaultParent: string,
 *   effectsCacheFile?: string,
 *   fetch?: typeof fetch,
 *   listTemplates: () => object[],
 *   createSeries: (request: { template: string, rows: unknown, name?: string }) => { dir: string, unknown: string[] },
 *   renders: ReturnType<typeof import("./render-jobs.mjs").createRenderJobs>,
 * }} app
 */
export function createAgentTools(app) {
  function runCaptured(args, cwd, timeoutSeconds) {
    return new Promise((resolve) => {
      const child = app.runEngine(args, cwd);
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      const done = (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code, stdout, stderr, timedOut });
      };
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, timeoutSeconds * 1000);
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", (error) => {
        stderr += error.message;
        done(null);
      });
      child.on("exit", (code) => done(code));
    });
  }

  function folder(dir) {
    if (dir === undefined) return app.projectDir();
    const path = String(dir);
    if (!isAbsolute(path) || !existsSync(path) || !statSync(path).isDirectory()) {
      throw new Error("dir must be an absolute path to an existing folder.");
    }
    return path;
  }

  function mediaFile(path) {
    const value = String(path ?? "");
    if (!value) throw new Error("path is required.");
    const file = isAbsolute(value) ? value : join(app.projectDir(), normalize(value));
    if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`No file at ${value}.`);
    return file;
  }

  async function cli({ args, dir, timeout_seconds }) {
    if (!Array.isArray(args) || args.length === 0 || !args.every((arg) => typeof arg === "string")) {
      return failure("args must be a non-empty array of strings, e.g. ['timeline','--json'].");
    }
    if (!CLI_COMMANDS.includes(args[0])) {
      return failure(
        `'${args[0]}' is not available here. Allowed: ${CLI_COMMANDS.join(", ")}. Render with glintmotion_render.`,
      );
    }
    const timeout = clampNumber(timeout_seconds, 1, CLI_MAX_TIMEOUT_S, CLI_TIMEOUT_S);
    const run = await runCaptured(args, folder(dir), timeout);
    const json = parseJson(run.stdout);
    const reply = text({
      exitCode: run.code,
      ...(run.timedOut && { timedOut: `stopped after ${timeout} s` }),
      ...(json ? { json } : { stdout: tail(run.stdout, OUTPUT_TAIL) }),
      ...(run.stderr.trim() && { stderr: tail(run.stderr, 4000) }),
    });
    return run.code === 0 ? reply : { ...reply, isError: true };
  }

  async function effects({ query, tag, limit }) {
    const catalog = await loadEffectsCatalog({ cacheFile: app.effectsCacheFile, fetchImpl: app.fetch });
    const found = searchEffects(catalog.items, { query, tag, limit: clampNumber(limit, 1, 200, 40) });
    return text({
      source: catalog.source,
      ...(catalog.warning && { warning: catalog.warning }),
      ...found,
    });
  }

  async function addEffect({ name, dir }) {
    const run = await runCaptured(addEffectArgs(name), folder(dir), CLI_TIMEOUT_S);
    const json = parseJson(run.stdout);
    const reply = text({
      exitCode: run.code,
      ...(json ? { json } : { stdout: tail(run.stdout, OUTPUT_TAIL) }),
      ...(run.stderr.trim() && { stderr: tail(run.stderr, 4000) }),
    });
    return run.code === 0 ? reply : { ...reply, isError: true };
  }

  async function check({ strict, at, fix, variables }) {
    const dir = app.projectDir();
    const args = ["check", dir, "--json"];
    if (strict) args.push("--strict");
    if (fix) args.push("--fix");
    if (variables !== undefined) {
      if (typeof variables !== "object" || variables === null || Array.isArray(variables)) {
        return failure("variables must be an object of variable values.");
      }
      args.push("--variables", JSON.stringify(variables));
    }
    if (Array.isArray(at) && at.length) args.push("--at", at.map(Number).filter(Number.isFinite).join(","));
    const run = await runCaptured(args, dir, 300);
    const report = parseJson(run.stdout);
    if (!report) return failure(`check produced no report (code ${run.code}). ${tail(run.stderr, 1500)}`);
    return text(report);
  }

  async function motionCheck({ from, to, max_tweens }) {
    const report = await app.motionProbe({
      from: clampNumber(from, 0, Number.MAX_SAFE_INTEGER, 0),
      to: clampNumber(to, 0, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
      maxTweens: clampNumber(max_tweens, 1, MAX_MOTION_TWEENS, MOTION_TWEENS),
    });
    return text(report);
  }

  async function fetchFrames(base, times, work) {
    for (let index = 0; index < times.length; index += FRAME_FETCH_PARALLEL) {
      const slice = times.slice(index, index + FRAME_FETCH_PARALLEL);
      await Promise.all(
        slice.map(async (time, offset) => {
          const url = new URL(base);
          url.searchParams.set("t", time.toFixed(3));
          const response = await fetch(url);
          if (!response.ok) throw new Error(`The frame at ${time} s failed to render (${response.status}).`);
          const file = join(work, `f_${String(index + offset).padStart(3, "0")}.png`);
          writeFileSync(file, Buffer.from(await response.arrayBuffer()));
        }),
      );
    }
  }

  function sheetTimes({ times, count }) {
    if (Array.isArray(times) && times.length) {
      const picked = times.map(Number).filter((time) => Number.isFinite(time) && time >= 0);
      if (picked.length !== times.length) throw new Error("times must be non-negative numbers of seconds.");
      return picked.slice(0, MAX_SHEET_FRAMES);
    }
    const duration = app.projectInfo()?.duration;
    if (!duration) throw new Error("The project has no data-duration; pass `times` explicitly.");
    const frames = Math.round(clampNumber(count, 1, MAX_SHEET_FRAMES, 8));
    return Array.from({ length: frames }, (_, i) => Math.round(((i + 0.5) * duration * 1000) / frames) / 1000);
  }

  async function contactSheet(input) {
    const dir = app.projectDir();
    const times = sheetTimes(input);
    const frame = await app.studioCall("studio_frame", {});
    if (!frame?.ok) {
      return failure(frame?.reason ? `The studio could not capture a frame: ${frame.reason}` : "The studio is still loading.");
    }
    const base = new URL(frame.url, app.studioUrl() ?? undefined);
    const columns = Math.round(clampNumber(input.columns, 1, 8, Math.min(4, times.length)));
    const rows = Math.ceil(times.length / columns);
    const width = Math.round(clampNumber(input.width, 120, 960, 360));
    const work = mkdtempSync(join(tmpdir(), "glintmotion-sheet-"));
    try {
      await fetchFrames(base, times, work);
      mkdirSync(join(dir, "snapshots"), { recursive: true });
      const output = join(dir, "snapshots", `contact_${stamp()}.jpg`);
      const { code, stderr } = await runFfmpeg([
        "-y",
        "-framerate",
        "1",
        "-i",
        join(work, "f_%03d.png"),
        "-vf",
        `scale=${width}:-2,tile=${columns}x${rows}:padding=8:margin=8:color=0x101010`,
        "-frames:v",
        "1",
        "-q:v",
        "3",
        output,
      ]);
      if (code !== 0) return failure(`The contact sheet could not be assembled. ${tail(stderr, 600)}`);
      return {
        content: [
          { type: "text", text: JSON.stringify({ output, columns, rows, times }) },
          image(readFileSync(output), "image/jpeg"),
        ],
      };
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  async function mediaImage(args, extension) {
    const work = mkdtempSync(join(tmpdir(), "glintmotion-media-"));
    const output = join(work, `view.${extension}`);
    try {
      const { code, stderr } = await runFfmpeg([...args, output]);
      if (code !== 0) throw new Error(tail(stderr, 400));
      return image(readFileSync(output), extension === "png" ? "image/png" : "image/jpeg");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  async function inspectMedia({ path, views }) {
    const wanted = Array.isArray(views) && views.length ? views : ["probe"];
    const unknown = wanted.filter((view) => !MEDIA_VIEWS.includes(view));
    if (unknown.length) return failure(`Unknown view ${unknown.join(", ")}. Use ${MEDIA_VIEWS.join(", ")}.`);
    const file = mediaFile(path);
    const summary = summarizeProbe(path, await probeMedia(file));
    const hasAudio = summary.streams.some((stream) => stream.type === "audio");
    const video = summary.streams.find((stream) => stream.type === "video");
    const notes = [];
    const images = [];
    if (wanted.includes("loudness")) {
      if (!hasAudio) notes.push("loudness: no audio stream");
      else {
        const run = await runFfmpeg(["-nostats", "-i", file, "-map", "0:a:0", "-af", "ebur128=peak=true:framelog=quiet", "-f", "null", "-"]);
        summary.loudness = loudnessOf(run.stderr);
      }
    }
    if (wanted.includes("waveform")) {
      if (!hasAudio) notes.push("waveform: no audio stream");
      else {
        images.push(
          await mediaImage(
            ["-y", "-i", file, "-filter_complex", "[0:a:0]aformat=channel_layouts=mono,showwavespic=s=1200x240:colors=0x2dd4bf", "-frames:v", "1"],
            "png",
          ),
        );
      }
    }
    if (wanted.includes("filmstrip")) {
      const duration = video?.durationSeconds ?? summary.durationSeconds;
      if (!video || !duration) notes.push("filmstrip: no video stream with a duration");
      else {
        images.push(
          await mediaImage(
            ["-y", "-i", file, "-vf", `fps=${8 / duration},scale=240:-2,tile=8x1:padding=4:color=0x101010`, "-frames:v", "1", "-q:v", "4"],
            "jpg",
          ),
        );
      }
    }
    if (notes.length) summary.notes = notes;
    return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }, ...images] };
  }

  function sessionArgs({ action, label, agent, entry, diff }, dir) {
    const who = String(agent ?? "Agent").trim() || "Agent";
    if (!/^[\p{L}\p{N}][\p{L}\p{N} _.-]{0,39}$/u.test(who)) throw new Error("agent: letters, digits, spaces, up to 40.");
    const common = ["--dir", dir, "--json"];
    switch (action) {
      case "begin":
        if (!String(label ?? "").trim()) throw new Error("begin needs a label.");
        return ["history", "begin", "--who", who, "--label", String(label).trim(), ...common];
      case "end":
        return ["history", "end", ...common];
      case "undo":
        return ["history", "undo", ...(entry ? [String(entry)] : ["--who", who]), ...common];
      case "changes":
        return ["history", "--since", "mine", "--who", who, ...common];
      case "list":
        return ["history", "--limit", "20", ...common];
      case "show":
        if (!entry) throw new Error("show needs an entry id from list.");
        return ["history", "show", String(entry), ...(diff ? ["--diff"] : []), ...common];
      default:
        throw new Error(`action is one of ${SESSION_ACTIONS.join(", ")}.`);
    }
  }

  async function session(input) {
    const dir = app.projectDir();
    const run = await runCaptured(sessionArgs(input, dir), dir, 60);
    const json = parseJson(run.stdout);
    if (!json) return failure(tail(run.stderr.trim() || run.stdout.trim() || `history exited with ${run.code}`, 2000));
    return run.code === 0 ? text(json) : { ...text(json), isError: true };
  }

  function fitOptions({ video, composition, name, output, rewire, from, fps }) {
    return {
      projectDir: app.projectDir(),
      video,
      composition: composition ?? "index.html",
      name,
      output: output ? String(output) : undefined,
      rewire: rewire !== false,
      from: clampNumber(from, 0, 3600, 0),
      fps: clampNumber(fps, 1, 120, DEFAULT_FPS),
    };
  }

  async function fitVideo(input) {
    if (!input.source || !input.video) return failure("source and video are required.");
    return text(await fitVideoIntoScene({ ...fitOptions(input), source: String(input.source) }));
  }

  async function simulatorTake(input) {
    switch (input.action) {
      case "start":
        return text({
          recording: true,
          ...(await startSimulatorTake({ udid: input.udid, locale: input.locale, app: input.app, settle: input.settle })),
          next: "Drive the simulator now, then call glintmotion_simulator_take with action 'stop'.",
        });
      case "stop": {
        const options = fitOptions(input);
        const take = await stopSimulatorTake();
        try {
          const saved = input.video
            ? await fitVideoIntoScene({ ...options, source: take.file, fallbackName: `take-${stamp()}` })
            : await saveTake({ ...options, source: take.file, seconds: take.seconds });
          return text({
            ...saved,
            device: take.device,
            recordedSeconds: take.seconds,
            ...(take.autoStopped && { autoStopped: `stopped at ${MAX_TAKE_SECONDS} s` }),
            ...(take.restored && { restored: take.restored }),
          });
        } finally {
          rmSync(take.work, { recursive: true, force: true });
        }
      }
      case "cancel":
        return text({ cancelled: cancelSimulatorTake() });
      default:
        return failure(`action is one of ${TAKE_ACTIONS.join(", ")}.`);
    }
  }

  async function music({ prompt, seconds, start, track, place }) {
    const path = await app.generateMusic({ prompt, seconds });
    if (place === false) return text({ path });
    const timeline = await app.studioCall("studio_add_media", {
      path,
      start: start ?? 0,
      ...(track !== undefined && { track }),
    });
    return text({ path, timeline: timeline ?? { ok: false, reason: "the studio is not ready" } });
  }

  async function deliver({ render, preset, color }) {
    let filename = String(render ?? "");
    if (isAbsolute(filename)) {
      if (dirname(filename) !== join(app.projectDir(), "renders")) {
        return failure("render must be a file directly inside the project's renders/ folder.");
      }
      filename = basename(filename);
    }
    return text({ output: await app.deliver({ filename, preset, color: color ?? "#000000" }) });
  }

  async function createProject({ name, resolution, parent, open }) {
    const folderPath = parent === undefined ? app.defaultParent : String(parent);
    if (!isAbsolute(folderPath)) return failure("parent must be an absolute path.");
    const dir = await app.createProject({ name, parent: folderPath, resolution: resolution ?? "portrait" });
    if (open !== false) await app.openProject(dir);
    return text({ path: dir, opened: open !== false });
  }

  function shareableFile(file) {
    const dir = app.projectDir();
    const value = String(file ?? "");
    const candidates = isAbsolute(value)
      ? [value]
      : [join(dir, normalize(value)), ...SHARE_FOLDERS.map((folder) => join(dir, folder, basename(value)))];
    const found = candidates.find(
      (path) =>
        SHARE_FOLDERS.some((folder) => dirname(path) === join(dir, folder)) && existsSync(path) && statSync(path).isFile(),
    );
    if (!found) throw new Error(`No file ${value} directly inside renders/ or snapshots/.`);
    return found;
  }

  async function upload({ file, upload_url }) {
    let target;
    try {
      target = new URL(String(upload_url ?? ""));
    } catch {
      return failure("upload_url is not a URL.");
    }
    if (target.protocol !== "https:" || !target.pathname.includes(SIGNED_UPLOAD_PATH)) {
      return failure("Only Supabase Storage signed upload URLs (https, /storage/v1/object/upload/sign/) are accepted.");
    }
    const path = shareableFile(file);
    const contentType = UPLOAD_TYPES[extname(path).toLowerCase()];
    if (!contentType) return failure(`Upload MP4, MOV or JPEG files, not ${extname(path) || "this file"}.`);
    const bytes = readFileSync(path);
    if (bytes.byteLength > MAX_UPLOAD_BYTES) {
      return failure(`${basename(path)} is ${Math.round(bytes.byteLength / 1e6)} MB; the limit is 50 MB. Deliver a lighter copy.`);
    }
    const response = await fetch(target, { method: "PUT", headers: { "Content-Type": contentType }, body: bytes });
    if (!response.ok) {
      return failure(`The upload was refused (${response.status}). ${tail(await response.text(), 400)}`);
    }
    return text({ uploaded: basename(path), bytes: bytes.byteLength, contentType });
  }

  async function createSeries({ template, rows, name, open }) {
    const { dir, unknown } = app.createSeries({ template: String(template ?? ""), rows, name });
    if (open !== false) await app.openProject(dir);
    return text({
      path: dir,
      versions: rows.length,
      opened: open !== false,
      ...(unknown.length && { ignored: unknown, hint: "The template declares no variable with these ids." }),
    });
  }

  async function seriesSheet({ at }) {
    const dir = app.projectDir();
    if (!existsSync(join(dir, SERIES_FILE))) {
      return failure(`The open project has no ${SERIES_FILE}. Make one with glintmotion_create_series.`);
    }
    const times = Array.isArray(at) ? at.map(Number) : [];
    if (times.length === 0 || times.length > MAX_SERIES_TIMES || times.some((time) => !Number.isFinite(time) || time < 0)) {
      return failure(`at must be 1 to ${MAX_SERIES_TIMES} non-negative times in seconds.`);
    }
    mkdirSync(join(dir, "snapshots"), { recursive: true });
    const output = join(dir, "snapshots", `series_${stamp()}.jpg`);
    const args = ["compare", dir, "--batch", join(dir, SERIES_FILE), "--at", times.join(","), "--out", output, "--json"];
    const run = await runCaptured(args, dir, 300);
    const report = parseJson(run.stdout);
    if (run.code !== 0 || !existsSync(output)) {
      return failure(`The series sheet failed (code ${run.code}). ${tail(run.stderr.trim() || run.stdout.trim(), 1500)}`);
    }
    return {
      content: [
        { type: "text", text: JSON.stringify({ output, times: report?.times ?? times, repeated: report?.repeated ?? [] }) },
        image(readFileSync(output), "image/jpeg"),
      ],
    };
  }

  function renderReply(job) {
    const reply = text(
      job.status === "running"
        ? { ...job, hint: "Still rendering. Call glintmotion_render_status with this job and wait_seconds." }
        : job,
    );
    return job.status === "failed" ? { ...reply, isError: true } : reply;
  }

  async function render(input) {
    const job = app.renders.start(app.projectDir(), input);
    return renderReply(await app.renders.wait(job.job, clampNumber(input.wait_seconds, 0, MAX_WAIT_S, RENDER_WAIT_S)));
  }

  async function renderStatus({ job, wait_seconds }) {
    if (!job) return text({ jobs: app.renders.list() });
    return renderReply(await app.renders.wait(job, clampNumber(wait_seconds, 0, MAX_WAIT_S, 0)));
  }

  const handlers = {
    glintmotion_create_project: createProject,
    glintmotion_session: session,
    glintmotion_check: check,
    glintmotion_motion_check: motionCheck,
    glintmotion_contact_sheet: contactSheet,
    glintmotion_inspect_media: inspectMedia,
    glintmotion_fit_video: fitVideo,
    glintmotion_simulator_take: simulatorTake,
    glintmotion_generate_music: music,
    glintmotion_render: render,
    glintmotion_render_status: renderStatus,
    glintmotion_render_cancel: ({ job }) => text(app.renders.cancel(job)),
    glintmotion_deliver: deliver,
    glintmotion_upload: upload,
    glintmotion_list_templates: () => text(app.listTemplates()),
    glintmotion_create_series: createSeries,
    glintmotion_series_sheet: seriesSheet,
    glintmotion_cli: cli,
    glintmotion_effects: effects,
    glintmotion_add_effect: addEffect,
  };

  return {
    /** The tool's reply, or null when `name` is not one of these tools. */
    call: (name, args) => (handlers[name] ? handlers[name](args ?? {}) : null),
  };
}
