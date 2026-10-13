import { MotionCheckButton } from "./MotionCheckButton";
import { StretchDrawButton } from "./StretchDrawButton";

/** The Mac app's own timeline toolbar buttons; each renders nothing in a plain browser. */
export function DesktopTimelineActions() {
  return (
    <>
      <StretchDrawButton />
      <MotionCheckButton />
    </>
  );
}
