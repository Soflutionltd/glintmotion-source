import { describe, expect, it, vi } from "vitest";
import type { TimelineElement } from "../../player/store/timelineElement";
import {
  studioAddMedia,
  studioDeleteClip,
  studioHistoryStep,
  studioSetTiming,
  type TimelineToolDeps,
} from "./timelineTools";

function clip(id: string, start: number, duration: number, track: number): TimelineElement {
  return { id, tag: "video", start, duration, track, src: `assets/${id}.mp4` };
}

function makeDeps(initial: TimelineElement[], overrides: Partial<TimelineToolDeps> = {}) {
  let elements = [...initial];
  const deps: TimelineToolDeps = {
    getElements: () => elements,
    getWriteBlockedReason: () => null,
    readHistory: () => ({ canUndo: true, canRedo: false, undoLabel: "Move V1", redoLabel: null }),
    addAsset: vi.fn(
      async (path: string, placement: { start: number; track: number }, duration?: number) => {
        elements = [
          ...elements,
          {
            id: "new",
            tag: "audio",
            src: path,
            start: placement.start,
            track: placement.track,
            duration: duration ?? 12,
          },
        ];
      },
    ),
    moveClip: vi.fn((element: TimelineElement, updates: { start: number; track: number }) => {
      elements = elements.map((e) => (e.id === element.id ? { ...e, ...updates } : e));
    }),
    resizeClip: vi.fn(
      (
        element: TimelineElement,
        updates: Pick<TimelineElement, "start" | "duration" | "playbackStart">,
      ) => {
        elements = elements.map((e) =>
          e.id === element.id ? { ...e, start: updates.start, duration: updates.duration } : e,
        );
      },
    ),
    deleteClip: vi.fn(async (element: TimelineElement) => {
      elements = elements.filter((e) => e.id !== element.id);
    }),
    undo: vi.fn(async () => undefined),
    redo: vi.fn(async () => undefined),
    wait: async () => undefined,
    ...overrides,
  };
  return deps;
}

describe("studio_add_media", () => {
  it("places the file on a new track below the others by default", async () => {
    const deps = makeDeps([clip("v1", 0, 4, 0), clip("cap1", 0, 4, 1)]);
    const result = await studioAddMedia(deps, { path: "assets/music/theme.m4a" });
    expect(deps.addAsset).toHaveBeenCalledWith(
      "assets/music/theme.m4a",
      { start: 0, track: 2 },
      undefined,
    );
    expect(result).toMatchObject({ ok: true, clip: { id: "new", track: 2, start: 0 } });
  });

  it("refuses a path outside the project", async () => {
    const deps = makeDeps([]);
    expect(await studioAddMedia(deps, { path: "../secret.mp4" })).toMatchObject({
      ok: false,
      kind: "invalid",
    });
    expect(await studioAddMedia(deps, { path: "/etc/hosts" })).toMatchObject({
      ok: false,
      kind: "invalid",
    });
    expect(deps.addAsset).not.toHaveBeenCalled();
  });

  it("reports a write that never shows up instead of claiming success", async () => {
    const deps = makeDeps([], { addAsset: vi.fn(async () => undefined) });
    expect(await studioAddMedia(deps, { path: "a.mp4" })).toMatchObject({
      ok: false,
      kind: "failed",
    });
  });

  it("does not write while the save queue is paused", async () => {
    const deps = makeDeps([], { getWriteBlockedReason: () => "save queue paused" });
    expect(await studioAddMedia(deps, { path: "a.mp4" })).toMatchObject({
      ok: false,
      kind: "blocked",
    });
    expect(deps.addAsset).not.toHaveBeenCalled();
  });
});

describe("studio_set_timing", () => {
  it("moves then trims, and verifies both landed", async () => {
    const deps = makeDeps([clip("v1", 0, 4, 0)]);
    const result = await studioSetTiming(deps, { clip: "v1", start: 2, duration: 3, track: 1 });
    expect(deps.moveClip).toHaveBeenCalledTimes(1);
    expect(deps.resizeClip).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      ok: true,
      verified: true,
      clip: { start: 2, duration: 3, track: 1 },
    });
  });

  it("says unverified when the handler did nothing", async () => {
    const deps = makeDeps([clip("v1", 0, 4, 0)], { moveClip: vi.fn() });
    expect(await studioSetTiming(deps, { clip: "v1", start: 2 })).toMatchObject({
      ok: true,
      verified: false,
    });
  });

  it("rejects an unknown clip and a no-op", async () => {
    const deps = makeDeps([clip("v1", 0, 4, 0)]);
    expect(await studioSetTiming(deps, { clip: "nope", start: 1 })).toMatchObject({
      ok: false,
      kind: "invalid",
    });
    expect(await studioSetTiming(deps, { clip: "v1", start: 0 })).toMatchObject({
      ok: false,
      kind: "invalid",
    });
  });
});

describe("studio_delete_clip", () => {
  it("removes the clip and confirms it is gone", async () => {
    const deps = makeDeps([clip("v1", 0, 4, 0)]);
    expect(await studioDeleteClip(deps, { clip: "v1" })).toMatchObject({
      ok: true,
      removed: { id: "v1" },
    });
    expect(deps.getElements()).toHaveLength(0);
  });
});

describe("studio_undo / studio_redo", () => {
  it("undoes and returns the label", async () => {
    const deps = makeDeps([]);
    expect(await studioHistoryStep(deps, "undo")).toMatchObject({ ok: true, stepped: "Move V1" });
    expect(deps.undo).toHaveBeenCalled();
  });

  it("refuses a redo with nothing to redo", async () => {
    const deps = makeDeps([]);
    expect(await studioHistoryStep(deps, "redo")).toMatchObject({ ok: false });
    expect(deps.redo).not.toHaveBeenCalled();
  });
});
