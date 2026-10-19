import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createExportPreparation } from "./exportPreparation.js";

function controlledRuns() {
  const runs: Array<{ signal: AbortSignal; finish: () => void }> = [];
  const prepare = (signal: AbortSignal) =>
    new Promise<void>((finish) => {
      runs.push({ signal, finish });
    });
  return { runs, prepare };
}

/** Starts one run, then reports a change while it is still going. */
async function changeDuringRun() {
  const { runs, prepare } = controlledRuns();
  const preparation = createExportPreparation(prepare, 100);
  preparation.schedule();
  await vi.advanceTimersByTimeAsync(100);
  preparation.schedule();
  await vi.advanceTimersByTimeAsync(100);
  return { runs, preparation };
}

describe("export preparation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits until the project has been quiet for the idle time", async () => {
    const { runs, prepare } = controlledRuns();
    const preparation = createExportPreparation(prepare, 3000);
    preparation.schedule();
    await vi.advanceTimersByTimeAsync(2000);
    preparation.schedule();
    await vi.advanceTimersByTimeAsync(2999);
    expect(runs).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(runs).toHaveLength(1);
  });

  it("never runs two at once, and runs once more for changes made during a run", async () => {
    const { runs, preparation } = await changeDuringRun();
    preparation.schedule();
    await vi.advanceTimersByTimeAsync(100);
    expect(runs).toHaveLength(1);

    runs[0]!.finish();
    await vi.advanceTimersByTimeAsync(100);
    expect(runs).toHaveLength(2);
    runs[1]!.finish();
    await vi.advanceTimersByTimeAsync(1000);
    expect(runs).toHaveLength(2);
  });

  it("stop aborts the current run and drops the pending one", async () => {
    const { runs, preparation } = await changeDuringRun();
    preparation.stop();
    expect(runs[0]!.signal.aborted).toBe(true);

    runs[0]!.finish();
    await vi.advanceTimersByTimeAsync(1000);
    expect(runs).toHaveLength(1);
  });

  it("keeps scheduling after a run fails", async () => {
    const prepare = vi.fn(() => Promise.reject(new Error("composition does not compile")));
    const preparation = createExportPreparation(prepare, 100);
    preparation.schedule();
    await vi.advanceTimersByTimeAsync(100);
    preparation.schedule();
    await vi.advanceTimersByTimeAsync(100);
    expect(prepare).toHaveBeenCalledTimes(2);
  });
});
