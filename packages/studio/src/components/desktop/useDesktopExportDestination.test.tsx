// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RenderJob } from "../renders/useRenderQueue";
import { useDesktopExportDestination } from "./useDesktopExportDestination";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

type Queue = {
  jobs: RenderJob[];
  ffmpegMissing: boolean;
  startRender: (options: unknown) => Promise<void>;
};

let root: Root;
let wrapped: Queue;
let choose: ReturnType<typeof vi.fn>;
let save: ReturnType<typeof vi.fn>;
let startRender: ReturnType<typeof vi.fn>;

function Probe({ queue }: { queue: Queue }) {
  wrapped = useDesktopExportDestination(queue);
  return null;
}

const job = (status: RenderJob["status"]): RenderJob => ({
  id: "logo-reel_2026-10-13",
  status,
  progress: status === "complete" ? 100 : 40,
  filename: "logo-reel_2026-10-13.mp4",
  createdAt: 0,
});

function show(jobs: RenderJob[], ffmpegMissing = false) {
  act(() =>
    root.render(
      <Probe queue={{ jobs, ffmpegMissing, startRender: startRender as Queue["startRender"] }} />,
    ),
  );
}

beforeEach(() => {
  choose = vi.fn(() =>
    Promise.resolve({ id: "target-1", path: "/Users/me/Desktop/logo-reel.mp4" }),
  );
  save = vi.fn(() => Promise.resolve("/Users/me/Desktop/logo-reel.mp4"));
  startRender = vi.fn(() => Promise.resolve("logo-reel_2026-10-13"));
  Object.assign(window, { glintmotion: { agent: {}, exports: { choose, save } } });
  root = createRoot(document.createElement("div"));
  show([]);
});

afterEach(() => {
  act(() => root.unmount());
  Reflect.deleteProperty(window, "glintmotion");
});

describe("useDesktopExportDestination", () => {
  it("asks where the export goes, then copies the render there once it is finished", async () => {
    await act(() => wrapped.startRender({ format: "mov" }));
    expect(choose).toHaveBeenCalledWith({ format: "mov" });
    expect(startRender).toHaveBeenCalledWith({ format: "mov" });

    show([job("rendering")]);
    expect(save).not.toHaveBeenCalled();
    show([job("complete")]);
    expect(save).toHaveBeenCalledWith({ id: "target-1", filename: "logo-reel_2026-10-13.mp4" });
    show([job("complete")]);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("starts nothing when the person cancels the save panel", async () => {
    choose.mockResolvedValueOnce(null);
    await act(() => wrapped.startRender(undefined));
    expect(choose).toHaveBeenCalledWith({ format: "mp4" });
    expect(startRender).not.toHaveBeenCalled();
  });

  it("copies nothing for a render that failed", async () => {
    await act(() => wrapped.startRender({}));
    show([job("failed")]);
    expect(save).not.toHaveBeenCalled();
  });

  it("lets the render refuse at once, without asking, when FFmpeg is missing", async () => {
    show([], true);
    await act(() => wrapped.startRender({}));
    expect(choose).not.toHaveBeenCalled();
    expect(startRender).toHaveBeenCalled();
  });
});
