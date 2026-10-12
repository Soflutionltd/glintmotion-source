import { useEffect, useRef } from "react";
import { useStudioShellContext } from "../../contexts/StudioContext";
import { usePlayerStore, type TimelineElement } from "../../player";
import { exposeToolsToDesktopHost } from "../../webmcp/desktopToolBridge";
import { runToolBody, type ToolResult } from "../../webmcp/toolResult";
import type { ModelContextTool } from "../../webmcp/types";
import {
  studioAddMedia,
  studioDeleteClip,
  studioHistoryStep,
  studioSetTiming,
  STUDIO_ADD_MEDIA_DESCRIPTION,
  STUDIO_ADD_MEDIA_INPUT_SCHEMA,
  STUDIO_DELETE_CLIP_DESCRIPTION,
  STUDIO_DELETE_CLIP_INPUT_SCHEMA,
  STUDIO_HISTORY_INPUT_SCHEMA,
  STUDIO_REDO_DESCRIPTION,
  STUDIO_SET_TIMING_DESCRIPTION,
  STUDIO_SET_TIMING_INPUT_SCHEMA,
  STUDIO_UNDO_DESCRIPTION,
  type TimelineToolDeps,
} from "../../webmcp/tools/timelineTools";

export interface DesktopTimelineHandlers {
  onAddAsset: TimelineToolDeps["addAsset"];
  onMoveClip: TimelineToolDeps["moveClip"];
  onResizeClip: TimelineToolDeps["resizeClip"];
  onDeleteClip: TimelineToolDeps["deleteClip"];
}

interface TimelineEditingSurface {
  handleTimelineAssetDrop: (
    path: string,
    placement: { start: number; track: number },
    duration?: number,
  ) => Promise<unknown>;
  handleTimelineElementMove: (
    element: TimelineElement,
    updates: { start: number; track: number },
  ) => unknown;
  handleTimelineElementResize: TimelineToolDeps["resizeClip"];
  handleTimelineElementDelete: (element: TimelineElement) => Promise<unknown>;
}

/** The desktop panels' timeline handlers, taken from `useTimelineEditing` in one call so App stays short. */
export function desktopHostHandlers(timeline: TimelineEditingSurface) {
  return {
    onAddAudioAtStart: (path: string) =>
      timeline.handleTimelineAssetDrop(path, { start: 0, track: 0 }),
    onAddAsset: timeline.handleTimelineAssetDrop,
    onMoveClip: timeline.handleTimelineElementMove,
    onResizeClip: timeline.handleTimelineElementResize,
    onDeleteClip: timeline.handleTimelineElementDelete,
  };
}

function buildTimelineTools(depsRef: { readonly current: TimelineToolDeps }): ModelContextTool[] {
  const tool = (
    name: string,
    title: string,
    description: string,
    inputSchema: object,
    run: (deps: TimelineToolDeps, input: Record<string, unknown>) => Promise<ToolResult<object>>,
  ): ModelContextTool => ({
    name,
    title,
    description,
    inputSchema,
    annotations: { readOnlyHint: false },
    execute: (input) =>
      runToolBody(name, () => run(depsRef.current, (input ?? {}) as Record<string, unknown>)),
  });
  return [
    tool(
      "studio_add_media",
      "Place media on the timeline",
      STUDIO_ADD_MEDIA_DESCRIPTION,
      STUDIO_ADD_MEDIA_INPUT_SCHEMA,
      studioAddMedia,
    ),
    tool(
      "studio_set_timing",
      "Move or trim a clip",
      STUDIO_SET_TIMING_DESCRIPTION,
      STUDIO_SET_TIMING_INPUT_SCHEMA,
      studioSetTiming,
    ),
    tool(
      "studio_delete_clip",
      "Remove a clip",
      STUDIO_DELETE_CLIP_DESCRIPTION,
      STUDIO_DELETE_CLIP_INPUT_SCHEMA,
      studioDeleteClip,
    ),
    tool("studio_undo", "Undo", STUDIO_UNDO_DESCRIPTION, STUDIO_HISTORY_INPUT_SCHEMA, (deps) =>
      studioHistoryStep(deps, "undo"),
    ),
    tool("studio_redo", "Redo", STUDIO_REDO_DESCRIPTION, STUDIO_HISTORY_INPUT_SCHEMA, (deps) =>
      studioHistoryStep(deps, "redo"),
    ),
  ];
}

/** Publishes the timeline tools to the Glintmotion Mac app. Renders nothing. */
export function DesktopTimelineTools(handlers: DesktopTimelineHandlers) {
  const { editHistory, writeBlockedReason, handleUndo, handleRedo } = useStudioShellContext();
  const deps: TimelineToolDeps = {
    getElements: () => usePlayerStore.getState().elements,
    getWriteBlockedReason: () => writeBlockedReason,
    readHistory: () => ({
      canUndo: editHistory.canUndo,
      canRedo: editHistory.canRedo,
      undoLabel: editHistory.undoLabel ?? null,
      redoLabel: editHistory.redoLabel ?? null,
    }),
    addAsset: handlers.onAddAsset,
    moveClip: handlers.onMoveClip,
    resizeClip: handlers.onResizeClip,
    deleteClip: handlers.onDeleteClip,
    undo: handleUndo,
    redo: handleRedo,
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
  const depsRef = useRef(deps);
  depsRef.current = deps;

  // Mount-only, like useStudioAgentTools: the deps ref keeps the tools live without re-registering.
  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => {
    const controller = new AbortController();
    exposeToolsToDesktopHost(buildTimelineTools(depsRef), controller.signal, "timeline");
    return () => controller.abort();
  }, []);
  return null;
}
