/** Quiet time after the last project write before its video frames are extracted for the next export. */
const PREPARE_IDLE_MS = 3000;

export interface ExportPreparation {
  /** A project file changed: prepare again once the writes have settled. */
  schedule(): void;
  /** An export is starting or the server is closing: drop the pending run and abort the current one. */
  stop(): void;
}

/** Runs `prepare` once the project has been quiet for `idleMs`, never two at once. */
export function createExportPreparation(
  prepare: (signal: AbortSignal) => Promise<void>,
  idleMs = PREPARE_IDLE_MS,
): ExportPreparation {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: AbortController | null = null;
  let changedWhileRunning = false;

  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(start, idleMs);
    timer.unref?.();
  };

  function start(): void {
    timer = null;
    if (running) {
      changedWhileRunning = true;
      return;
    }
    const controller = new AbortController();
    running = controller;
    // The export that follows reports any real failure; a preparation only saves it time.
    void prepare(controller.signal)
      .catch(() => {})
      .finally(() => {
        if (running !== controller) return;
        running = null;
        if (changedWhileRunning) {
          changedWhileRunning = false;
          schedule();
        }
      });
  }

  return {
    schedule,
    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
      changedWhileRunning = false;
      running?.abort();
      running = null;
    },
  };
}
