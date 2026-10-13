import { useEffect, useRef, useState } from "react";
import type { ClaudeStatus, DesktopHost } from "../../utils/desktopHost";
import { useDockLayoutStore } from "../dock/dockLayoutStore";

/**
 * Hands the request typed on Home to the agent panel, once Claude's status is known: `sendNow` is
 * false when Claude still needs installing or a sign-in, so the request waits in the composer.
 */
export function useHomeRequest(
  host: DesktopHost,
  claude: ClaudeStatus | null,
  claudeReady: boolean,
  deliver: (prompt: string, sendNow: boolean) => void,
) {
  const ready = claude ? claudeReady : null;
  const [prompt, setPrompt] = useState<string | null>(null);
  const deliverRef = useRef(deliver);
  useEffect(() => {
    deliverRef.current = deliver;
  });

  // No unmount guard: the app hands the request out once, so a discarded answer would lose it.
  useEffect(() => {
    host.agent
      .takePending()
      .then((pending) => pending && setPrompt(pending))
      .catch(() => setPrompt(null));
  }, [host]);

  useEffect(() => {
    if (prompt === null || ready === null) return;
    setPrompt(null);
    const dock = useDockLayoutStore.getState();
    if (dock.panels.includes("agent")) dock.activatePanel("agent");
    deliverRef.current(prompt, ready);
  }, [prompt, ready]);
}
