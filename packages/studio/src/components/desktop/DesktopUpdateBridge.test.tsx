// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopHost } from "../../utils/desktopHost";
import { DesktopUpdateBridge } from "./DesktopUpdateBridge";

const studio = vi.hoisted(() => ({
  isPlaying: false,
  isRendering: false,
  waitForPendingDomEditSaves: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../contexts/StudioContext", () => ({
  useStudioShellContext: () => ({
    waitForPendingDomEditSaves: studio.waitForPendingDomEditSaves,
    renderQueue: { isRendering: studio.isRendering },
  }),
  useStudioPlaybackContext: () => ({ isPlaying: studio.isPlaying }),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root;
let host: DesktopHost;
let reportBusy: ReturnType<typeof vi.fn>;
let prepare: (() => Promise<void>) | null;
let unsubscribe: ReturnType<typeof vi.fn>;

const show = (next: { isPlaying?: boolean; isRendering?: boolean } = {}) => {
  Object.assign(studio, next);
  act(() => root.render(<DesktopUpdateBridge host={host} />));
};

beforeEach(() => {
  reportBusy = vi.fn();
  unsubscribe = vi.fn();
  prepare = null;
  host = {
    updates: {
      reportBusy,
      onPrepare: (callback: () => Promise<void>) => {
        prepare = callback;
        return unsubscribe;
      },
    },
  } as unknown as DesktopHost;
  root = createRoot(document.createElement("div"));
  show({ isPlaying: false, isRendering: false });
});

afterEach(() => act(() => root.unmount()));

describe("DesktopUpdateBridge", () => {
  it("reports playback and studio exports as work an update restart must wait for", () => {
    expect(reportBusy).toHaveBeenLastCalledWith(false);
    show({ isPlaying: true });
    expect(reportBusy).toHaveBeenLastCalledWith(true);
    show({ isPlaying: false, isRendering: true });
    expect(reportBusy).toHaveBeenLastCalledWith(true);
    show({ isRendering: false });
    expect(reportBusy).toHaveBeenLastCalledWith(false);
  });

  it("writes pending edits to disk when the app prepares to restart, and stops listening on unmount", async () => {
    expect(prepare).not.toBeNull();
    await prepare?.();
    expect(studio.waitForPendingDomEditSaves).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
    expect(unsubscribe).toHaveBeenCalled();
    root = createRoot(document.createElement("div"));
  });
});
