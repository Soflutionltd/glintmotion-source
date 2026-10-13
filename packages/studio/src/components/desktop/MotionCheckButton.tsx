import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CircleNotch, Pulse } from "@phosphor-icons/react";
import { useStudioPlaybackContext, useStudioShellContext } from "../../contexts/StudioContext";
import { usePlayerStore } from "../../player/store/playerStore";
import { setMotionFindings } from "../../player/store/motionCheckStore";
import { MAIN_COMPOSITION } from "../../player/store/agentStretchStore";
import { Tooltip } from "../ui/Tooltip";
import { flatActive, flatIdle } from "../timelineToolbarStyles";
import type { MotionCheckReport, MotionIssue } from "../../utils/desktopHost";
import { getDesktopHost, hostErrorMessage } from "../../utils/desktopHost";
import { useCloseOnOutside } from "./useCloseOnOutside";

const ISSUE_LABELS: Record<MotionIssue, string> = {
  late_start: "Starts late",
  stall: "Stalls",
  tail_tick: "Ticks on landing",
  early_finish: "Finishes early",
  judder: "Shakes",
};

const NONE: MotionCheckReport["findings"] = [];

type Outcome =
  | { kind: "report"; report: MotionCheckReport; stale: boolean }
  | { kind: "error"; message: string };

function summaryOf(outcome: Outcome): string {
  if (outcome.kind === "error") return outcome.message;
  const { report, stale } = outcome;
  if (stale) return "The project changed during the check: run it again.";
  const checked = `${report.tweensChecked} moving element${report.tweensChecked === 1 ? "" : "s"}, ${report.seconds} s`;
  if (report.findings.length === 0) return `No motion issue (${checked}).`;
  const count = report.findings.length;
  return `${count} issue${count === 1 ? "" : "s"} (${checked}). Click one to go to it.`;
}

/**
 * Runs the Mac app's frame-by-frame motion check on the saved project, lists what reads badly and
 * marks each tween on the ruler. Findings clear when the project's files change.
 */
export const MotionCheckButton = memo(function MotionCheckButton() {
  const host = getDesktopHost();
  const { waitForPendingDomEditSaves, activeCompPath } = useStudioShellContext();
  const onMain = !activeCompPath || activeCompPath === MAIN_COMPOSITION;
  const { refreshKey } = useStudioPlaybackContext();
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);
  const refreshKeyRef = useRef(refreshKey);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const roots = useMemo(() => [buttonRef, menuRef], []);
  useCloseOnOutside(open, roots, close);

  useEffect(() => {
    refreshKeyRef.current = refreshKey;
    setOutcome(null);
  }, [refreshKey]);

  const findings = outcome?.kind === "report" && !outcome.stale ? outcome.report.findings : NONE;
  useEffect(() => setMotionFindings(onMain ? findings : NONE), [findings, onMain]);

  if (!host?.motion) return null;
  const motion = host.motion;

  const showMenu = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) setAnchor({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
    setOpen(true);
  };

  const check = async () => {
    setRunning(true);
    setOutcome(null);
    try {
      await waitForPendingDomEditSaves();
      const startKey = refreshKeyRef.current;
      const report = await motion.check();
      setOutcome({ kind: "report", report, stale: refreshKeyRef.current !== startKey });
    } catch (reason) {
      setOutcome({ kind: "error", message: hostErrorMessage(reason) });
    } finally {
      setRunning(false);
      showMenu();
    }
  };

  const label = running
    ? "Checking motion frame by frame (about 0.3 s per moving element)"
    : "Check motion: find text that stalls, ticks or shakes";

  return (
    <>
      <Tooltip label={label}>
        <button
          ref={buttonRef}
          type="button"
          aria-label={label}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-busy={running}
          onClick={() => {
            if (running) return;
            if (outcome && !open) showMenu();
            else void check();
          }}
          className={`${findings.length > 0 ? flatActive : flatIdle} relative`}
        >
          {running ? (
            <CircleNotch size={15} className="animate-spin" aria-hidden="true" />
          ) : (
            <Pulse size={15} aria-hidden="true" />
          )}
          {findings.length > 0 && (
            <span className="absolute -top-0.5 -right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-amber-500 px-0.5 text-[9px] font-semibold leading-none text-black">
              {findings.length}
            </span>
          )}
        </button>
      </Tooltip>

      {open &&
        anchor &&
        outcome &&
        createPortal(
          <div
            ref={menuRef}
            role="dialog"
            aria-label="Motion check"
            style={{ top: anchor.top, right: anchor.right }}
            className="fixed z-[1000] flex max-h-[60vh] w-80 flex-col rounded-xl border border-panel-border bg-panel-bg p-1.5 shadow-[0_1px_2px_rgba(0,0,0,0.05),0_4px_12px_rgba(0,0,0,0.08),0_12px_40px_rgba(0,0,0,0.06)]"
          >
            <p className="px-2 pt-1 pb-2 text-[11px] leading-relaxed text-panel-text-3">
              {summaryOf(outcome)}
              {!onMain &&
                findings.length > 0 &&
                ` Times are in ${MAIN_COMPOSITION}: open it to go to them.`}
            </p>
            <div className="min-h-0 overflow-y-auto">
              {findings.map((finding, index) => (
                <button
                  key={`${finding.issue}-${finding.target}-${finding.start}-${index}`}
                  type="button"
                  disabled={!onMain}
                  onClick={() => usePlayerStore.getState().requestSeek(finding.start)}
                  className="flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors enabled:hover:bg-panel-input"
                >
                  <span className="flex w-full items-baseline justify-between gap-2 text-[12px]">
                    <span className="min-w-0 truncate font-mono text-panel-text-1">
                      {finding.target}
                    </span>
                    <span className="shrink-0 text-warning-ink">{ISSUE_LABELS[finding.issue]}</span>
                  </span>
                  <span className="font-mono text-[10px] tabular-nums text-panel-text-3">
                    {finding.start.toFixed(2)}–{finding.end.toFixed(2)} s
                  </span>
                  <span className="text-[11px] leading-snug text-panel-text-2">{finding.hint}</span>
                </button>
              ))}
            </div>
            <button
              type="button"
              disabled={running}
              onClick={() => {
                close();
                void check();
              }}
              className="mt-1 rounded-md border-t border-panel-border px-2 pt-2 pb-1 text-left text-[11px] text-studio-accent transition-colors hover:underline disabled:opacity-40"
            >
              Check again
            </button>
          </div>,
          document.body,
        )}
    </>
  );
});
