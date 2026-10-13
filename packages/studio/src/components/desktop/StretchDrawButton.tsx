import { memo, useEffect } from "react";
import { Scribble } from "@phosphor-icons/react";
import {
  MAX_AGENT_STRETCHES,
  setStretchDrawing,
  useAgentStretchStore,
} from "../../player/store/agentStretchStore";
import { useDockLayoutStore } from "../dock/dockLayoutStore";
import { Tooltip } from "../ui/Tooltip";
import { flatActive, flatDisabled, flatIdle } from "../timelineToolbarStyles";
import { getDesktopHost } from "../../utils/desktopHost";

/** Toggles stretch drawing (D) and brings the Agent panel forward for each stretch drawn. */
export const StretchDrawButton = memo(function StretchDrawButton() {
  const drawing = useAgentStretchStore((s) => s.drawing);
  const full = useAgentStretchStore((s) => s.stretches.length >= MAX_AGENT_STRETCHES);
  const lastAddedId = useAgentStretchStore((s) => s.lastAddedId);

  useEffect(() => {
    if (lastAddedId === null) return;
    const dock = useDockLayoutStore.getState();
    if (dock.panels.includes("agent")) dock.activatePanel("agent");
  }, [lastAddedId]);

  if (!getDesktopHost()) return null;
  const label = full
    ? `${MAX_AGENT_STRETCHES} stretches are waiting: send them to the agent first`
    : drawing
      ? "Stop drawing (Esc)"
      : "Draw across a stretch to talk to the agent about it (D)";

  return (
    <Tooltip label={label}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={drawing}
        disabled={full && !drawing}
        onClick={() => setStretchDrawing(!drawing)}
        className={full && !drawing ? flatDisabled : drawing ? flatActive : flatIdle}
      >
        <Scribble size={15} aria-hidden="true" />
      </button>
    </Tooltip>
  );
});
