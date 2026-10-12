import { memo, useCallback, useRef } from "react";
import { liveTime, usePlayerStore } from "../store/playerStore";
import { useMountEffect } from "../../hooks/useMountEffect";

interface PreviewScrubBarProps {
  onSeek: (time: number) => void;
  disabled?: boolean;
}

export function currentPlayhead(): number {
  const state = usePlayerStore.getState();
  return state.isPlaying ? liveTime.latest() : state.currentTime;
}

function clampRatio(value: number): number {
  return Math.min(1, Math.max(0, value));
}

// Progress is written straight to the DOM from liveTime so playback never re-renders React.
export const PreviewScrubBar = memo(function PreviewScrubBar({
  onSeek,
  disabled = false,
}: PreviewScrubBarProps) {
  const duration = usePlayerStore((s) => s.duration);
  const timelineReady = usePlayerStore((s) => s.timelineReady);
  const trackRef = useRef<HTMLDivElement>(null);
  const fillRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const durationRef = useRef(duration);
  durationRef.current = duration;
  const inactive = disabled || !timelineReady || duration <= 0;

  const paint = useCallback((time: number) => {
    const total = durationRef.current;
    const ratio = total > 0 ? clampRatio(time / total) : 0;
    const percent = `${ratio * 100}%`;
    if (fillRef.current) fillRef.current.style.width = percent;
    if (thumbRef.current) thumbRef.current.style.left = percent;
    trackRef.current?.setAttribute("aria-valuenow", time.toFixed(2));
  }, []);

  useMountEffect(() => {
    const unsubscribe = liveTime.subscribe(paint);
    paint(usePlayerStore.getState().currentTime);
    return unsubscribe;
  });

  const seekFromPointer = useCallback(
    (clientX: number) => {
      const track = trackRef.current;
      const total = durationRef.current;
      if (!track || total <= 0) return;
      const rect = track.getBoundingClientRect();
      const time = clampRatio((clientX - rect.left) / rect.width) * total;
      paint(time);
      onSeek(time);
    },
    [onSeek, paint],
  );

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (inactive || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    seekFromPointer(event.clientX);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    seekFromPointer(event.clientX);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (inactive) return;
    const step = event.shiftKey ? 5 : 1;
    const now = currentPlayhead();
    if (event.key === "ArrowRight") onSeek(Math.min(durationRef.current, now + step));
    else if (event.key === "ArrowLeft") onSeek(Math.max(0, now - step));
    else return;
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div className="px-3 pt-2">
      <div
        ref={trackRef}
        role="slider"
        tabIndex={inactive ? -1 : 0}
        aria-label="Playback position"
        aria-valuemin={0}
        aria-valuemax={Number(duration.toFixed(2))}
        aria-disabled={inactive || undefined}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onKeyDown={handleKeyDown}
        className={`group relative flex h-3 items-center outline-none ${
          inactive ? "pointer-events-none opacity-40" : "cursor-pointer"
        }`}
      >
        <div className="relative h-[3px] w-full overflow-hidden rounded-full bg-white/15 transition-[height] group-hover:h-[5px] group-focus-visible:h-[5px]">
          <div ref={fillRef} className="absolute inset-y-0 left-0 bg-neutral-100" />
        </div>
        <div
          ref={thumbRef}
          className="pointer-events-none absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 scale-0 rounded-full bg-white shadow transition-transform group-hover:scale-100 group-focus-visible:scale-100"
        />
      </div>
    </div>
  );
});
