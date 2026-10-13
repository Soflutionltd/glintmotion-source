import { memo, useState, type PointerEvent } from "react";
import { addAgentStretch, useAgentStretchStore } from "../store/agentStretchStore";

/** Shorter than this is a click, not a stretch. */
const MIN_STRETCH_SECONDS = 0.1;

interface TimelineStretchDrawLayerProps {
  pps: number;
  contentOrigin: number;
  trackContentWidth: number;
  totalH: number;
  effectiveDuration: number;
}

/**
 * While stretch drawing is on, takes over the timeline's drags: one drag across it becomes a
 * stretch for the agent. Over the clips and the ruler (under the playhead), so no clip or scrub
 * gesture starts.
 */
export const TimelineStretchDrawLayer = memo(function TimelineStretchDrawLayer({
  pps,
  contentOrigin,
  trackContentWidth,
  totalH,
  effectiveDuration,
}: TimelineStretchDrawLayerProps) {
  const drawing = useAgentStretchStore((s) => s.drawing);
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
  if (!drawing) return null;

  const timeAt = (event: PointerEvent<HTMLDivElement>) => {
    const left = event.currentTarget.getBoundingClientRect().left;
    return Math.min(effectiveDuration, Math.max(0, (event.clientX - left) / pps));
  };

  const finish = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    setDrag(null);
    const to = timeAt(event);
    if (Math.abs(to - drag.from) >= MIN_STRETCH_SECONDS) addAgentStretch(drag.from, to);
  };

  const band = drag && {
    left: Math.min(drag.from, drag.to) * pps,
    width: Math.abs(drag.to - drag.from) * pps,
  };

  return (
    <div
      data-timeline-stretch-draw=""
      className="absolute top-0 cursor-crosshair select-none"
      style={{ left: contentOrigin, width: trackContentWidth, height: totalH, zIndex: 95 }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.stopPropagation();
        event.preventDefault();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        const time = timeAt(event);
        setDrag({ from: time, to: time });
      }}
      onPointerMove={(event) => {
        if (!drag) return;
        event.stopPropagation();
        setDrag({ from: drag.from, to: timeAt(event) });
      }}
      onPointerUp={(event) => {
        event.stopPropagation();
        finish(event);
      }}
      onPointerCancel={() => setDrag(null)}
    >
      <div className="pointer-events-none sticky top-1 left-2 z-10 inline-flex rounded-md bg-panel-bg/90 px-2 py-1 text-[11px] text-panel-text-2 shadow-[0_1px_2px_rgba(0,0,0,0.05),0_4px_12px_rgba(0,0,0,0.08)]">
        Drag across a stretch to talk about it · Esc to cancel
      </div>
      {band && (
        <div
          data-timeline-stretch-preview=""
          className="pointer-events-none absolute top-0 bottom-0 border-x border-studio-accent bg-studio-accent/15"
          style={band}
        />
      )}
    </div>
  );
});
