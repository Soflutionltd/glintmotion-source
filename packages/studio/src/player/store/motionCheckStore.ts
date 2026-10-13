import { create } from "zustand";
import type { MotionFinding } from "../../utils/desktopHost";

/** The last motion check's findings, drawn on the timeline ruler; empty until one runs. */
export const useMotionCheckStore = create<{ findings: MotionFinding[] }>(() => ({ findings: [] }));

export const setMotionFindings = (findings: MotionFinding[]) =>
  useMotionCheckStore.setState({ findings });
