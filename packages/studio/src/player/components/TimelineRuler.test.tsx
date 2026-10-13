// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TimelineRuler } from "./TimelineRuler";
import { setMotionFindings } from "../store/motionCheckStore";
import {
  addAgentStretch,
  clearAgentStretches,
  setStretchComposition,
} from "../store/agentStretchStore";
import { TIMELINE_SCROLL_SETTLE_MS } from "./useTimelineScrollViewport";
import type { TimelineTheme } from "./timelineTheme";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  vi.useRealTimers();
});

describe("TimelineRuler", () => {
  it("masks the one tick label the track header would slice, once the scroll settles", () => {
    vi.useFakeTimers();
    const scroller = document.createElement("div");
    let scrollLeft = 0;
    Object.defineProperty(scroller, "scrollLeft", { get: () => scrollLeft });
    const host = document.createElement("div");
    scroller.append(host);
    const root = createRoot(host);
    act(() =>
      root.render(
        <TimelineRuler
          major={[0, 10, 20]}
          minor={[]}
          pps={20}
          trackContentWidth={600}
          totalH={100}
          effectiveDuration={30}
          majorTickInterval={10}
          theme={{} as TimelineTheme}
          contentOrigin={80}
          scrollRef={{ current: scroller }}
        />,
      ),
    );
    const mask = () =>
      host.querySelector<HTMLElement>("[data-timeline-ruler-label-mask]")?.style.left ?? null;
    const scrollTo = (left: number) =>
      act(() => {
        scrollLeft = left;
        scroller.dispatchEvent(new Event("scroll"));
      });
    const settle = () => act(() => vi.advanceTimersByTime(TIMELINE_SCROLL_SETTLE_MS));

    expect(mask()).toBeNull();
    // The 10s label starts at 200 - 0.5 + 5 = 204.5 in ruler space.
    scrollTo(204);
    expect(mask()).toBeNull();
    settle();
    expect(mask()).toBe("4.5px");
    scrollTo(205);
    expect(mask()).toBeNull();
    settle();
    expect(mask()).toBe("204.5px");
    act(() => root.unmount());
  });

  it("masks right away when the scroll element is swapped mid-scroll", () => {
    vi.useFakeTimers();
    const make = (left: number) => {
      const el = document.createElement("div");
      Object.defineProperty(el, "scrollLeft", { get: () => left });
      return el;
    };
    const first = make(205);
    const host = document.createElement("div");
    const root = createRoot(host);
    const render = (el: HTMLDivElement) =>
      act(() =>
        root.render(
          <TimelineRuler
            major={[0, 10, 20]}
            minor={[]}
            pps={20}
            trackContentWidth={600}
            totalH={100}
            effectiveDuration={30}
            majorTickInterval={10}
            theme={{} as TimelineTheme}
            contentOrigin={80}
            scrollRef={{ current: el }}
          />,
        ),
      );
    render(first);
    act(() => first.dispatchEvent(new Event("scroll")));
    render(make(205));
    expect(host.querySelector<HTMLElement>("[data-timeline-ruler-label-mask]")?.style.left).toBe(
      "204.5px",
    );
    act(() => root.unmount());
  });

  function renderPlainRuler() {
    const host = document.createElement("div");
    const root = createRoot(host);
    act(() =>
      root.render(
        <TimelineRuler
          major={[0, 10]}
          minor={[]}
          pps={20}
          trackContentWidth={600}
          totalH={100}
          effectiveDuration={30}
          majorTickInterval={10}
          theme={{} as TimelineTheme}
          contentOrigin={80}
        />,
      ),
    );
    return { host, root };
  }

  it("marks only the agent stretches drawn on the composition it shows, numbered like the list", () => {
    const { host, root } = renderPlainRuler();
    const shown = () =>
      [...host.querySelectorAll<HTMLElement>("[data-timeline-agent-stretch]")].map((band) => [
        band.style.left,
        band.textContent,
      ]);
    act(() => {
      setStretchComposition("compositions/intro.html");
      addAgentStretch(0, 1);
      setStretchComposition(null);
      addAgentStretch(2, 3);
    });
    expect(shown()).toEqual([["40px", "2"]]);
    act(() => setStretchComposition("compositions/intro.html"));
    expect(shown()).toEqual([["0px", "1"]]);
    act(() => {
      clearAgentStretches();
      setStretchComposition(null);
      root.unmount();
    });
  });

  it("draws a band under each motion finding's tween, gone once the findings clear", () => {
    const { host, root } = renderPlainRuler();
    const bands = () => [...host.querySelectorAll<HTMLElement>("[data-timeline-motion-finding]")];
    expect(bands()).toHaveLength(0);

    act(() =>
      setMotionFindings([
        { issue: "stall", target: "#title", start: 1, end: 2.5, message: "", hint: "" },
      ]),
    );
    expect(bands().map((band) => [band.style.left, band.style.width])).toEqual([["20px", "30px"]]);

    act(() => setMotionFindings([]));
    expect(bands()).toHaveLength(0);
    act(() => root.unmount());
  });
});
