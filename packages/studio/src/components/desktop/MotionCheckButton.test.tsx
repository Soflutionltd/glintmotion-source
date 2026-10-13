// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MotionCheckReport } from "../../utils/desktopHost";
import { useMotionCheckStore } from "../../player/store/motionCheckStore";
import { usePlayerStore } from "../../player/store/playerStore";
import { MotionCheckButton } from "./MotionCheckButton";

const studio = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state = {
    refreshKey: 0,
    waitForPendingDomEditSaves: vi.fn(() => Promise.resolve()),
    setRefreshKey: (value: number) => {
      state.refreshKey = value;
      listeners.forEach((listener) => listener());
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
  return state;
});

vi.mock("../../contexts/StudioContext", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useStudioShellContext: () => ({
      waitForPendingDomEditSaves: studio.waitForPendingDomEditSaves,
    }),
    useStudioPlaybackContext: () => ({
      refreshKey: useSyncExternalStore(studio.subscribe, () => studio.refreshKey),
    }),
  };
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const STALL = {
  issue: "stall" as const,
  target: "#title",
  start: 1.2,
  end: 2,
  message: "#title stops for 4 frames",
  hint: "Use a gentler ease.",
};

function report(findings: MotionCheckReport["findings"]): MotionCheckReport {
  return { tweensChecked: 3, seconds: 1.4, findings };
}

let host: HTMLDivElement;
let root: Root;
let check: ReturnType<typeof vi.fn<() => Promise<MotionCheckReport>>>;

const render = () => act(() => root.render(<MotionCheckButton />));
const button = () => host.querySelector<HTMLButtonElement>("button")!;
const dialog = () => document.body.querySelector<HTMLElement>('[role="dialog"]');
const click = (element: HTMLElement) => act(async () => element.click());

beforeEach(() => {
  studio.setRefreshKey(0);
  check = vi.fn<() => Promise<MotionCheckReport>>();
  Object.assign(window, { glintmotion: { agent: {}, motion: { check } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete (window as Window & { glintmotion?: unknown }).glintmotion;
  useMotionCheckStore.setState({ findings: [] });
});

describe("MotionCheckButton", () => {
  it("renders nothing outside the Mac app", () => {
    delete (window as Window & { glintmotion?: unknown }).glintmotion;
    render();
    expect(host.innerHTML).toBe("");
  });

  it("checks the saved project, lists the findings, marks them and seeks to one", async () => {
    check.mockResolvedValue(report([STALL]));
    render();
    await click(button());

    expect(studio.waitForPendingDomEditSaves).toHaveBeenCalled();
    expect(useMotionCheckStore.getState().findings).toEqual([STALL]);
    expect(dialog()?.textContent).toContain("1 issue (3 moving elements, 1.4 s)");
    expect(dialog()?.textContent).toContain("Stalls");
    expect(button().textContent).toBe("1");

    const seek = vi.spyOn(usePlayerStore.getState(), "requestSeek");
    await click(
      [...dialog()!.querySelectorAll("button")].find((b) => b.textContent?.includes("#title"))!,
    );
    expect(seek).toHaveBeenCalledWith(1.2);
  });

  it("says so when nothing reads badly", async () => {
    check.mockResolvedValue(report([]));
    render();
    await click(button());
    expect(dialog()?.textContent).toContain("No motion issue (3 moving elements, 1.4 s).");
    expect(useMotionCheckStore.getState().findings).toEqual([]);
  });

  it("shows the app's error without Electron's IPC wrapper", async () => {
    check.mockRejectedValue(
      new Error(
        "Error invoking remote method 'motion:check': Error: A motion check is already running.",
      ),
    );
    render();
    await click(button());
    expect(dialog()?.textContent).toContain("A motion check is already running.");
  });

  it("clears the findings once the project's files change", async () => {
    check.mockResolvedValue(report([STALL]));
    render();
    await click(button());
    expect(useMotionCheckStore.getState().findings).toHaveLength(1);

    act(() => studio.setRefreshKey(1));
    expect(useMotionCheckStore.getState().findings).toEqual([]);
    expect(button().textContent).toBe("");
  });

  it("keeps a check's findings off the ruler when the files changed while it ran", async () => {
    let finish: (value: MotionCheckReport) => void = () => {};
    check.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    render();
    await click(button());
    expect(check).toHaveBeenCalled();
    act(() => studio.setRefreshKey(1));
    await act(async () => finish(report([STALL])));

    expect(useMotionCheckStore.getState().findings).toEqual([]);
    expect(dialog()?.textContent).toContain("The project changed during the check");
  });
});
