import { useEffect } from "react";
import { useStudioPlaybackContext, useStudioShellContext } from "../../contexts/StudioContext";
import type { DesktopHost } from "../../utils/desktopHost";

/**
 * Tells the Mac app when an update restart would interrupt something (playback, an export),
 * and writes pending edits to disk before it restarts.
 */
export function DesktopUpdateBridge({ host }: { host: DesktopHost }) {
  const { renderQueue, waitForPendingDomEditSaves } = useStudioShellContext();
  const { isPlaying } = useStudioPlaybackContext();
  const busy = isPlaying || renderQueue.isRendering;

  useEffect(() => host.updates.reportBusy(busy), [host, busy]);
  useEffect(
    () => host.updates.onPrepare(waitForPendingDomEditSaves),
    [host, waitForPendingDomEditSaves],
  );
  return null;
}
