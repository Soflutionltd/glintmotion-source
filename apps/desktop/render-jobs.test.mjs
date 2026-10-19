import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createRenderJobs } from "./render-jobs.mjs";

const project = mkdtempSync(join(tmpdir(), "gm-render-jobs-"));
after(() => rmSync(project, { recursive: true, force: true }));

const trace = (fields) =>
  `[INFO] [Render:trace] ${JSON.stringify({ status: "checkpoint", message: "resolved", ...fields })}\n`;
const CALIBRATED =
  trace({ phase: "capture_calibration" }) + trace({ phase: "capture_strategy", workerCount: 5 });

function fakeEngine(script) {
  const runs = [];
  const runEngine = (args) => {
    runs.push(args);
    const { output, code = 0 } = script(runs.length);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      if (code === 0) writeFileSync(args[args.indexOf("--output") + 1], "");
      child.stdout.emit("data", output);
      child.emit("exit", code, null);
    });
    return child;
  };
  return { runs, runEngine };
}

function memory() {
  const map = new Map();
  return {
    map,
    get: (key) => map.get(key),
    set: (key, value) => map.set(key, value),
    delete: (key) => map.delete(key),
  };
}

async function render(jobs) {
  const { job } = jobs.start(project);
  return jobs.wait(job, 5);
}

const workersArg = (args) =>
  args.includes("--workers") ? Number(args[args.indexOf("--workers") + 1]) : null;

describe("render worker memory", () => {
  it("reuses the calibrated worker count on the next render of the scene", async () => {
    const engine = fakeEngine((run) => ({ output: run === 1 ? CALIBRATED : "" }));
    const jobs = createRenderJobs({ runEngine: engine.runEngine, workerMemory: memory() });
    assert.equal((await render(jobs)).status, "done");
    assert.equal((await render(jobs)).status, "done");
    assert.deepEqual(engine.runs.map(workersArg), [null, 5]);
  });

  it("calibrates again after a failed render with the remembered count", async () => {
    const store = memory();
    const engine = fakeEngine((run) => ({
      output: run === 1 ? CALIBRATED : "",
      code: run === 2 ? 1 : 0,
    }));
    const jobs = createRenderJobs({ runEngine: engine.runEngine, workerMemory: store });
    await render(jobs);
    assert.equal((await render(jobs)).status, "failed");
    await render(jobs);
    assert.deepEqual(engine.runs.map(workersArg), [null, 5, null]);
  });

  it("measures again after ten reuses", async () => {
    const store = memory();
    const engine = fakeEngine((run) => ({ output: run === 1 || run === 12 ? CALIBRATED : "" }));
    const jobs = createRenderJobs({ runEngine: engine.runEngine, workerMemory: store });
    for (let index = 0; index < 13; index += 1) await render(jobs);
    const workers = engine.runs.map(workersArg);
    assert.equal(workers[0], null);
    assert.ok(workers.slice(1, 11).every((count) => count === 5));
    assert.equal(workers[11], null);
    assert.equal(workers[12], 5);
  });

  it("stores nothing when the engine skipped calibration", async () => {
    const store = memory();
    const engine = fakeEngine(() => ({
      output: trace({ phase: "capture_strategy", workerCount: 1 }),
    }));
    const jobs = createRenderJobs({ runEngine: engine.runEngine, workerMemory: store });
    await render(jobs);
    assert.equal(store.map.size, 0);
  });
});
