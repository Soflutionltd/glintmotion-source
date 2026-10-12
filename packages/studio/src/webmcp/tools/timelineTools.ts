/**
 * Timeline tools for the Glintmotion desktop host: place media, retime, delete,
 * undo and redo, through the same handlers a drag on the timeline uses.
 *
 * Every write goes through Studio's own commit path, so it lands in the same
 * history entry, honours the same edit guards and can be undone by the human.
 * The tools read the clip list back after the write instead of trusting the
 * handler's return value, because several handlers resolve before the preview
 * has reloaded the element list.
 */

import type { TimelineElement } from "../../player/store/timelineElement";
import { toolFailure, toolOk, type ToolResult } from "../toolResult";

export interface TimelineClipSummary {
  id: string;
  label: string | null;
  kind: string | null;
  start: number;
  duration: number;
  track: number;
  src: string | null;
}

export interface TimelineToolDeps {
  getElements: () => TimelineElement[];
  getWriteBlockedReason: () => string | null;
  readHistory: () => {
    canUndo: boolean;
    canRedo: boolean;
    undoLabel: string | null;
    redoLabel: string | null;
  };
  addAsset: (
    path: string,
    placement: { start: number; track: number },
    duration?: number,
  ) => Promise<unknown>;
  moveClip: (element: TimelineElement, updates: { start: number; track: number }) => unknown;
  resizeClip: (
    element: TimelineElement,
    updates: Pick<TimelineElement, "start" | "duration" | "playbackStart">,
  ) => unknown;
  deleteClip: (element: TimelineElement) => Promise<unknown>;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  wait: (ms: number) => Promise<void>;
}

const SETTLE_TIMEOUT_MS = 4000;
const SETTLE_POLL_MS = 100;
const TIME_EPSILON = 0.001;

function summarize(element: TimelineElement): TimelineClipSummary {
  return {
    id: element.id,
    label: element.label ?? null,
    kind: element.kind ?? element.tag ?? null,
    start: element.start,
    duration: element.duration,
    track: element.track,
    src: element.src ?? null,
  };
}

function findClip(deps: TimelineToolDeps, clip: string): TimelineElement | null {
  return deps.getElements().find((element) => element.id === clip || element.key === clip) ?? null;
}

async function settle<T>(deps: TimelineToolDeps, read: () => T | null): Promise<T | null> {
  for (let waited = 0; waited <= SETTLE_TIMEOUT_MS; waited += SETTLE_POLL_MS) {
    const value = read();
    if (value !== null) return value;
    await deps.wait(SETTLE_POLL_MS);
  }
  return null;
}

const near = (a: number, b: number) => Math.abs(a - b) < TIME_EPSILON;

const nonNegative = (value: unknown, fallback: number) =>
  typeof value === "number" && value >= 0 ? value : fallback;
const positive = (value: unknown, fallback: number) =>
  typeof value === "number" && value > 0 ? value : fallback;
const trackIndex = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;

function blocked(deps: TimelineToolDeps) {
  const reason = deps.getWriteBlockedReason();
  return reason
    ? toolFailure("blocked", reason, "Wait for the save queue, then call again.")
    : null;
}

function missingClip(clip: string) {
  return toolFailure(
    "invalid",
    `no clip with id ${clip}`,
    "Call studio_look and pass a `clips[].id` from its answer.",
  );
}

export const STUDIO_ADD_MEDIA_INPUT_SCHEMA = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description:
        "Project-relative path of a video, audio or image file, e.g. assets/music/theme.m4a.",
    },
    start: { type: "number", minimum: 0, description: "Start time in seconds. Default 0." },
    track: {
      type: "integer",
      minimum: 0,
      description:
        "Timeline track. Default: a new track below every existing one, so nothing is covered.",
    },
    duration: {
      type: "number",
      minimum: 0,
      description:
        "Clip length in seconds. Required for images; media files default to their own length.",
    },
  },
  required: ["path"],
} as const;

export const STUDIO_ADD_MEDIA_DESCRIPTION = [
  "Place a media file that is already in the project on the timeline, exactly as dropping it there would.",
  "One undo entry. Returns `ok: true` with the new `clip` (id, start, duration, track) read back from the",
  "timeline, or `ok: false` with `kind`, `reason` and a `hint`.",
].join(" ");

export async function studioAddMedia(
  deps: TimelineToolDeps,
  input: { path?: unknown; start?: unknown; track?: unknown; duration?: unknown },
): Promise<ToolResult<{ clip: TimelineClipSummary }>> {
  const path = typeof input.path === "string" ? input.path.trim().replace(/^\.\//, "") : "";
  if (!path || path.startsWith("/") || path.split("/").includes("..")) {
    return toolFailure(
      "invalid",
      "path must be relative to the project folder",
      "e.g. assets/music/theme.m4a",
    );
  }
  const start = nonNegative(input.start, 0);
  const duration = positive(input.duration, 0) || undefined;
  const before = deps.getElements();
  const track = trackIndex(
    input.track,
    before.reduce((max, element) => Math.max(max, element.track + 1), 0),
  );
  const refusal = blocked(deps);
  if (refusal) return refusal;

  const known = new Set(before.map((element) => element.id));
  await deps.addAsset(path, { start, track }, duration);
  const added = await settle(
    deps,
    () =>
      deps.getElements().find((element) => !known.has(element.id) && near(element.start, start)) ??
      null,
  );
  if (!added) {
    return toolFailure(
      "failed",
      `${path} did not appear on the timeline`,
      "Check the file is inside the project folder, then call studio_look to see what landed.",
    );
  }
  return toolOk({ clip: summarize(added) });
}

export const STUDIO_SET_TIMING_INPUT_SCHEMA = {
  type: "object",
  properties: {
    clip: { type: "string", description: "A `clips[].id` from studio_look." },
    start: { type: "number", minimum: 0, description: "New start in seconds." },
    duration: {
      type: "number",
      minimum: 0,
      description: "New length in seconds (trims or extends the end).",
    },
    track: { type: "integer", minimum: 0, description: "Move the clip to this track." },
  },
  required: ["clip"],
} as const;

export const STUDIO_SET_TIMING_DESCRIPTION = [
  "Move a clip in time or to another track, and/or change its length, like dragging or trimming it on the",
  "timeline. Pass any of start, duration, track. Returns `ok: true` with the clip as read back after the",
  "write and `verified` telling whether every requested value landed, or `ok: false` with a `hint`.",
].join(" ");

interface Timing {
  start: number;
  duration: number;
  track: number;
}

const placedAt = (element: TimelineElement, target: Timing) =>
  near(element.start, target.start) && element.track === target.track;
const timedAs = (element: TimelineElement, target: Timing) =>
  placedAt(element, target) && near(element.duration, target.duration);

function waitForClip(deps: TimelineToolDeps, id: string, matches: (e: TimelineElement) => boolean) {
  return settle(deps, () => {
    const current = findClip(deps, id);
    return current && matches(current) ? current : null;
  });
}

async function applyTiming(deps: TimelineToolDeps, element: TimelineElement, target: Timing) {
  if (!placedAt(element, target)) {
    await deps.moveClip(element, { start: target.start, track: target.track });
  }
  if (near(target.duration, element.duration)) return;
  const moved =
    (await waitForClip(deps, element.id, (e) => placedAt(e, target))) ??
    findClip(deps, element.id) ??
    element;
  await deps.resizeClip(moved, {
    start: moved.start,
    duration: target.duration,
    playbackStart: moved.playbackStart,
  });
}

export async function studioSetTiming(
  deps: TimelineToolDeps,
  input: { clip?: unknown; start?: unknown; duration?: unknown; track?: unknown },
): Promise<ToolResult<{ clip: TimelineClipSummary; verified: boolean }>> {
  const id = typeof input.clip === "string" ? input.clip : "";
  const element = id ? findClip(deps, id) : null;
  if (!element) return missingClip(id);
  const target: Timing = {
    start: nonNegative(input.start, element.start),
    duration: positive(input.duration, element.duration),
    track: trackIndex(input.track, element.track),
  };
  if (timedAs(element, target)) {
    return toolFailure(
      "invalid",
      "nothing to change",
      "Pass a start, duration or track that differs.",
    );
  }
  const refusal = blocked(deps);
  if (refusal) return refusal;

  await applyTiming(deps, element, target);
  const landed = await waitForClip(deps, element.id, (e) => timedAs(e, target));
  const current = landed ?? findClip(deps, element.id);
  if (!current)
    return toolFailure("failed", "the clip is gone after the write", "Call studio_look.");
  return toolOk({ clip: summarize(current), verified: landed !== null });
}

export const STUDIO_DELETE_CLIP_INPUT_SCHEMA = {
  type: "object",
  properties: { clip: { type: "string", description: "A `clips[].id` from studio_look." } },
  required: ["clip"],
} as const;

export const STUDIO_DELETE_CLIP_DESCRIPTION =
  "Remove a clip from the timeline, like pressing Delete on it. One undo entry. Returns `ok: true` with the removed clip, or `ok: false` with a `hint`.";

export async function studioDeleteClip(
  deps: TimelineToolDeps,
  input: { clip?: unknown },
): Promise<ToolResult<{ removed: TimelineClipSummary }>> {
  const id = typeof input.clip === "string" ? input.clip : "";
  const element = id ? findClip(deps, id) : null;
  if (!element) return missingClip(id);
  const refusal = blocked(deps);
  if (refusal) return refusal;
  await deps.deleteClip(element);
  const gone = await settle(deps, () => (findClip(deps, element.id) ? null : true));
  if (!gone) return toolFailure("failed", "the clip is still on the timeline", "Call studio_look.");
  return toolOk({ removed: summarize(element) });
}

export const STUDIO_HISTORY_INPUT_SCHEMA = { type: "object", properties: {} } as const;

export const STUDIO_UNDO_DESCRIPTION =
  "Undo the newest edit in the project, the same as Cmd+Z in the studio. Returns `ok: true` with the label of what was undone and the new history state, or `ok: false` when there is nothing to undo.";
export const STUDIO_REDO_DESCRIPTION =
  "Redo the newest undone edit, the same as Shift+Cmd+Z. Returns `ok: true` with the label of what was redone, or `ok: false` when there is nothing to redo.";

export async function studioHistoryStep(
  deps: TimelineToolDeps,
  direction: "undo" | "redo",
): Promise<ToolResult<{ stepped: string; history: ReturnType<TimelineToolDeps["readHistory"]> }>> {
  const before = deps.readHistory();
  const label = direction === "undo" ? before.undoLabel : before.redoLabel;
  if (direction === "undo" ? !before.canUndo : !before.canRedo) {
    return toolFailure("invalid", `nothing to ${direction}`);
  }
  await deps[direction]();
  return toolOk({ stepped: label ?? direction, history: deps.readHistory() });
}
