// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TimelineStretchDrawLayer } from "./TimelineStretchDrawLayer";
import {
  clearAgentStretches,
  setStretchDrawing,
  useAgentStretchStore,
} from "../store/agentStretchStore";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let host: HTMLDivElement;
let root: Root;
const parentPointerDown = vi.fn();

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  parentPointerDown.mockClear();
  act(() =>
    root.render(
      <div onPointerDown={parentPointerDown}>
        <TimelineStretchDrawLayer
          pps={100}
          contentOrigin={40}
          trackContentWidth={1000}
          totalH={200}
          effectiveDuration={10}
        />
      </div>,
    ),
  );
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  clearAgentStretches();
});

const layer = () => host.querySelector<HTMLElement>("[data-timeline-stretch-draw]");

function drag(fromX: number, toX: number) {
  const target = layer()!;
  vi.spyOn(target, "getBoundingClientRect").mockReturnValue({ left: 40 } as DOMRect);
  const pointer = (type: string, clientX: number) =>
    target.dispatchEvent(
      new PointerEvent(type, { clientX, button: 0, pointerId: 1, bubbles: true }),
    );
  act(() => pointer("pointerdown", fromX));
  act(() => pointer("pointermove", (fromX + toX) / 2));
  act(() => pointer("pointermove", toX));
  act(() => pointer("pointerup", toX));
}

describe("TimelineStretchDrawLayer", () => {
  it("is not there until stretch drawing is on", () => {
    expect(layer()).toBeNull();
    act(() => setStretchDrawing(true));
    expect(layer()?.style.left).toBe("40px");
  });

  it("turns one drag into a stretch, clamped to the composition, without starting a timeline gesture", () => {
    act(() => setStretchDrawing(true));
    drag(160, 1400);
    const { stretches, drawing } = useAgentStretchStore.getState();
    expect(stretches.map(({ start, end }) => [start, end])).toEqual([[1.2, 10]]);
    expect(drawing).toBe(false);
    expect(parentPointerDown).not.toHaveBeenCalled();
  });

  it("takes a click for a click, not a stretch", () => {
    act(() => setStretchDrawing(true));
    drag(300, 305);
    expect(useAgentStretchStore.getState().stretches).toEqual([]);
    expect(useAgentStretchStore.getState().drawing).toBe(true);
  });
});
