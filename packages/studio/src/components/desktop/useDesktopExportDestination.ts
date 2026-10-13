import { useCallback, useEffect, useMemo, useRef } from "react";
import { getDesktopHost } from "../../utils/desktopHost";
import { useRenderQueue, type RenderJob, type StartRenderOptions } from "../renders/useRenderQueue";

interface ExportQueue {
  jobs: RenderJob[];
  ffmpegMissing: boolean;
  startRender: (options: unknown) => Promise<void>;
}

/**
 * In the Mac app, every Export asks where the file goes before the render starts, then copies the
 * finished render there. The render itself stays in the project's renders folder, where the studio's
 * history, preview and social formats read it.
 */
export function useDesktopExportDestination<Queue extends ExportQueue>(queue: Queue): Queue {
  const host = getDesktopHost();
  const { jobs, ffmpegMissing, startRender } = queue;
  // render job id -> destination id from exports.choose
  const destinations = useRef(new Map<string, string>());

  const startWithDestination = useCallback(
    async (options: unknown) => {
      // Without an encoder the render refuses at once: no point asking where it goes first.
      if (!host || ffmpegMissing) return startRender(options);
      const format = (options as StartRenderOptions | undefined)?.format ?? "mp4";
      const destination = await host.exports.choose({ format });
      if (!destination) return;
      // startRender is typed void for its callers but resolves to the new job's id.
      const jobId: unknown = await startRender(options);
      if (typeof jobId === "string") destinations.current.set(jobId, destination.id);
    },
    [host, ffmpegMissing, startRender],
  );

  useEffect(() => {
    if (!host) return;
    for (const job of jobs) {
      const destination = destinations.current.get(job.id);
      if (!destination || job.status === "rendering") continue;
      destinations.current.delete(job.id);
      if (job.status === "complete") {
        void host.exports.save({ id: destination, filename: job.filename });
      }
    }
  }, [host, jobs]);

  return useMemo(
    () => (host ? { ...queue, startRender: startWithDestination } : queue),
    [host, queue, startWithDestination],
  );
}

/** The studio's render queue, with the Mac app's save panel in front of every Export. */
export function useExportQueue(...args: Parameters<typeof useRenderQueue>) {
  return useDesktopExportDestination(useRenderQueue(...args));
}
