import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, normalize } from "node:path";
import { loadSeries, seriesOutputKey } from "./templates.mjs";

const FORMATS = ["mp4", "webm", "mov", "gif"];
const QUALITIES = ["draft", "looks", "delivery"];
const RESOLUTIONS = ["landscape", "portrait", "square", "landscape-4k", "portrait-4k", "square-4k"];
const KEEP_JOBS = 20;
const LOG_TAIL = 4000;

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

function projectRelative(value, label) {
  const path = normalize(String(value));
  if (isAbsolute(path) || path.startsWith("..")) throw new Error(`${label} must be relative to the project folder.`);
  return path;
}

/** Engine arguments for one render request; validates every field the agent controls. */
export function renderArgs(dir, options, batchFile, outputKey = "index") {
  const format = options.format ?? "mp4";
  if (!FORMATS.includes(format)) throw new Error(`Unsupported format: ${format}`);
  const args = ["render", dir, "--format", format];
  if (options.quality !== undefined) {
    if (!QUALITIES.includes(options.quality)) throw new Error(`quality is one of ${QUALITIES.join(", ")}`);
    args.push("--quality", options.quality);
  }
  if (options.fps !== undefined) args.push("--fps", String(options.fps));
  if (options.resolution !== undefined) {
    if (!RESOLUTIONS.includes(options.resolution)) {
      throw new Error(`resolution is one of ${RESOLUTIONS.join(", ")}`);
    }
    args.push("--resolution", options.resolution);
  }
  if (options.composition !== undefined) {
    args.push("--composition", projectRelative(options.composition, "composition"));
  }
  if (options.variables !== undefined) {
    if (typeof options.variables !== "object" || options.variables === null || Array.isArray(options.variables)) {
      throw new Error("variables must be an object of variable values.");
    }
    args.push("--variables", JSON.stringify(options.variables));
  }
  const name = `${basename(dir)}_${stamp()}`;
  if (batchFile) {
    args.push("--batch", batchFile, "--json", "--output", join(dir, "renders", name, `{${outputKey}}.${format}`));
    return { args, output: null };
  }
  if (typeof options.from === "number") args.push("--from", String(options.from));
  if (typeof options.to === "number") args.push("--to", String(options.to));
  const output = join(dir, "renders", `${name}.${format}`);
  args.push("--output", output);
  return { args, output };
}

/** Reads `@hf-progress {...}` and `  ███  42%  Capturing frame 12/300` lines from the engine. */
export function readProgress(line) {
  if (line.startsWith("@hf-progress ")) {
    try {
      const pct = JSON.parse(line.slice(13)).pct;
      return typeof pct === "number" ? { progress: pct } : null;
    } catch {
      return null;
    }
  }
  const match = /(\d{1,3})%\s{2,}(.+)$/.exec(line);
  return match ? { progress: Number(match[1]), stage: match[2].trim() } : null;
}

function batchResult(log) {
  const line = log
    .split("\n")
    .reverse()
    .find((l) => l.startsWith('{"type":"batch-complete"'));
  if (!line) return null;
  const done = JSON.parse(line);
  return {
    outputs: done.rows.filter((row) => row.status === "completed").map((row) => row.outputPath),
    failed: done.rows
      .filter((row) => row.status === "failed")
      .map((row) => ({ index: row.index, error: row.error })),
  };
}

/** One engine render at a time, run in the background so an agent can poll instead of holding a call open. */
export function createRenderJobs({ runEngine }) {
  const jobs = new Map();
  let counter = 0;

  const publicJob = (job) => ({
    job: job.id,
    status: job.status,
    progress: job.progress,
    stage: job.stage,
    output: job.output,
    outputs: job.outputs,
    failed: job.failed,
    error: job.error,
    elapsedSeconds: Math.round(((job.endedAt ?? Date.now()) - job.startedAt) / 100) / 10,
  });

  function prune() {
    const finished = [...jobs.values()].filter((job) => job.status !== "running");
    for (const job of finished.slice(0, Math.max(0, jobs.size - KEEP_JOBS))) jobs.delete(job.id);
  }

  function finish(job, code, signal) {
    job.endedAt = Date.now();
    if (job.batchFile) rmSync(job.batchFile, { force: true });
    if (job.status === "cancelled") return;
    const batch = job.batchFile ? batchResult(job.log) : null;
    if (batch) Object.assign(job, batch);
    const produced = batch ? batch.outputs.length > 0 : job.output && existsSync(job.output);
    if (code === 0 && produced) {
      job.status = "done";
      job.progress = 100;
    } else {
      job.status = "failed";
      job.error = `Render failed (${signal ?? `code ${code}`}). ${job.log.slice(-600)}`.trim();
    }
    for (const resolve of job.waiters.splice(0)) resolve();
  }

  function start(dir, options = {}) {
    const running = [...jobs.values()].find((job) => job.status === "running");
    if (running) throw new Error(`Render ${running.id} is still running; wait for it or cancel it first.`);
    let batchFile = null;
    let outputKey = "index";
    if (options.series === true) {
      if (options.batch !== undefined) throw new Error("Pass either series or batch, not both.");
      const rows = loadSeries(dir);
      outputKey = seriesOutputKey(rows);
      options = { ...options, batch: rows };
    }
    if (options.batch !== undefined) {
      if (!Array.isArray(options.batch) || options.batch.length === 0) {
        throw new Error("batch must be a non-empty array of variable objects.");
      }
      batchFile = join(tmpdir(), `glintmotion-batch-${process.pid}-${Date.now()}.json`);
      writeFileSync(batchFile, JSON.stringify(options.batch));
    }
    const { args, output } = renderArgs(dir, options, batchFile, outputKey);
    mkdirSync(join(dir, "renders"), { recursive: true });
    const child = runEngine(args, dir);
    const job = {
      id: `r${++counter}`,
      dir,
      child,
      batchFile,
      status: "running",
      progress: 0,
      stage: "Starting",
      output,
      outputs: null,
      failed: null,
      error: null,
      log: "",
      startedAt: Date.now(),
      endedAt: null,
      waiters: [],
    };
    jobs.set(job.id, job);
    prune();
    let pending = "";
    const onData = (chunk) => {
      const text = chunk.toString();
      job.log = (job.log + text).slice(-LOG_TAIL * 4);
      pending += text;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const update = readProgress(line);
        if (update) Object.assign(job, update);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (error) => {
      job.log += `\n${error.message}`;
      finish(job, null, "spawn error");
    });
    child.on("exit", (code, signal) => finish(job, code, signal));
    return publicJob(job);
  }

  function get(id) {
    const job = jobs.get(String(id));
    if (!job) throw new Error(`No render job ${id}. Call glintmotion_render_status without a job to list them.`);
    return job;
  }

  /** Resolves with the job once it finishes, or after `seconds` with it still running. */
  async function wait(id, seconds) {
    const job = get(id);
    if (job.status === "running" && seconds > 0) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, seconds * 1000);
        job.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    return publicJob(job);
  }

  function cancel(id) {
    const job = get(id);
    if (job.status !== "running") return publicJob(job);
    job.status = "cancelled";
    job.child.kill("SIGTERM");
    for (const resolve of job.waiters.splice(0)) resolve();
    return publicJob(job);
  }

  return {
    start,
    wait,
    cancel,
    list: () => [...jobs.values()].reverse().map(publicJob),
    /** The project's most recent job, or null: what Home shows on that project's card. */
    latestFor: (dir) => {
      const job = [...jobs.values()].reverse().find((entry) => entry.dir === dir);
      return job ? publicJob(job) : null;
    },
    stopAll: () => {
      for (const job of jobs.values()) if (job.status === "running") cancel(job.id);
    },
  };
}
