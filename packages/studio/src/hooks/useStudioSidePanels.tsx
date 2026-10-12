import { useMemo, type ComponentProps } from "react";
import { StudioLeftPanels } from "../components/StudioLeftPanels";
import { StudioRightPanels } from "../components/StudioRightPanels";
import { StudioHostPanels } from "../components/desktop/StudioHostPanels";
import { useStableHandlers } from "./useStableHandlers";

/** Both side panels as one element that changes only when a panel's data does, never for a new handler. */
export function useStudioSidePanels(
  left: ComponentProps<typeof StudioLeftPanels>,
  right: ComponentProps<typeof StudioRightPanels>,
  projectId: string | null,
  host: ComponentProps<typeof StudioHostPanels>,
) {
  const stableLeft = useStableHandlers(left, projectId);
  const stableRight = useStableHandlers(right, projectId);
  const stableHost = useStableHandlers(host, projectId);
  return useMemo(
    () => (
      <>
        <StudioLeftPanels {...stableLeft} />
        <StudioRightPanels {...stableRight} />
        <StudioHostPanels {...stableHost} />
      </>
    ),
    [stableLeft, stableRight, stableHost],
  );
}
