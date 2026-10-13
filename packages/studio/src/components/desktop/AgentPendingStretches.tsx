import { memo, useEffect, useRef } from "react";
import { X } from "@phosphor-icons/react";
import { usePlayerStore } from "../../player/store/playerStore";
import {
  MAX_AGENT_STRETCHES,
  clearAgentStretches,
  removeAgentStretch,
  updateAgentStretchNote,
  useAgentStretchStore,
} from "../../player/store/agentStretchStore";

/**
 * The stretches drawn on the timeline and not sent yet, each with its note. Enter in a note moves
 * on to the message instead of sending, so several stretches can be gathered into one request.
 */
export const AgentPendingStretches = memo(function AgentPendingStretches({
  disabled,
  onNoteDone,
}: {
  disabled: boolean;
  onNoteDone: () => void;
}) {
  const stretches = useAgentStretchStore((s) => s.stretches);
  const lastAddedId = useAgentStretchStore((s) => s.lastAddedId);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (lastAddedId === null) return;
    listRef.current
      ?.querySelector<HTMLInputElement>(`[data-agent-stretch-note="${lastAddedId}"]`)
      ?.focus();
  }, [lastAddedId]);

  if (stretches.length === 0) return null;

  return (
    <div className="mb-2 border-b border-panel-border pb-2">
      <div className="flex items-center justify-between px-1 pb-1.5 text-[10px] text-panel-text-3">
        <span>
          Pending video edits · {stretches.length}/{MAX_AGENT_STRETCHES}
        </span>
        <button
          type="button"
          onClick={clearAgentStretches}
          disabled={disabled}
          className="rounded px-1 transition-colors hover:text-panel-text-1 disabled:opacity-40"
        >
          Clear
        </button>
      </div>
      <ul ref={listRef} className="max-h-40 space-y-1 overflow-y-auto">
        {stretches.map((stretch, index) => (
          <li key={stretch.id} className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => usePlayerStore.getState().requestSeek(stretch.start)}
              title="Go to this stretch"
              className="shrink-0 rounded-md bg-studio-accent/15 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-accent-ink transition-colors hover:bg-studio-accent/25"
            >
              {index + 1} · {stretch.start.toFixed(2)}–{stretch.end.toFixed(2)} s
            </button>
            <input
              data-agent-stretch-note={stretch.id}
              value={stretch.note}
              disabled={disabled}
              onChange={(event) => updateAgentStretchNote(stretch.id, event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                event.preventDefault();
                onNoteDone();
              }}
              placeholder="What should change here?"
              aria-label={`Note for stretch ${index + 1}`}
              className="min-w-0 flex-1 bg-transparent px-1 text-[12px] text-panel-text-1 outline-none placeholder:text-neutral-500"
            />
            <button
              type="button"
              onClick={() => removeAgentStretch(stretch.id)}
              disabled={disabled}
              aria-label={`Delete stretch ${index + 1}`}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-panel-text-3 transition-colors hover:bg-panel-input hover:text-panel-text-1 disabled:opacity-40"
            >
              <X size={11} aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
});
