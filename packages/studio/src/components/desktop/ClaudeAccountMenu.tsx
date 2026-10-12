import { memo, useCallback, useMemo, useRef, useState } from "react";
import {
  ArrowsClockwise,
  CaretDown,
  DownloadSimple,
  SignIn,
  SignOut,
  Sparkle,
  X,
} from "@phosphor-icons/react";
import type { ClaudeAccountAction, ClaudeStatus } from "../../utils/desktopHost";
import { useCloseOnOutside } from "./useCloseOnOutside";

const PENDING_LABELS: Record<ClaudeAccountAction, string> = {
  install: "Installing Claude Code…",
  login: "Finish signing in in your browser…",
  switch: "Finish signing in in your browser…",
  logout: "Signing out…",
};

function statusLine(status: ClaudeStatus | null): string {
  if (!status) return "Checking Claude Code…";
  if (!status.installed) return "Claude Code is not installed on this Mac";
  if (!status.loggedIn) return "Not signed in to Claude";
  return status.email ? `Signed in as ${status.email}` : "Signed in to Claude";
}

function dotClass(status: ClaudeStatus | null): string {
  if (!status) return "bg-neutral-400";
  return status.loggedIn ? "bg-emerald-500" : "bg-amber-500";
}

interface ClaudeAccountMenuProps {
  status: ClaudeStatus | null;
  pending: ClaudeAccountAction | null;
  disabled: boolean;
  onAction: (action: ClaudeAccountAction) => void;
  onCancel: () => void;
}

export const ClaudeAccountMenu = memo(function ClaudeAccountMenu({
  status,
  pending,
  disabled,
  onAction,
  onCancel,
}: ClaudeAccountMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const roots = useMemo(() => [rootRef], []);
  useCloseOnOutside(open, roots, close);

  const choose = (action: ClaudeAccountAction) => {
    setOpen(false);
    onAction(action);
  };

  const cancel = () => {
    setOpen(false);
    onCancel();
  };

  const itemClass =
    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-panel-text-1 transition-colors hover:bg-panel-input disabled:opacity-40";

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={statusLine(status)}
        className="flex h-6 items-center gap-1.5 rounded-md px-1.5 text-[12px] font-medium text-panel-text-1 transition-colors hover:bg-panel-input"
      >
        <Sparkle size={14} weight="fill" className="text-studio-accent" aria-hidden="true" />
        Claude Code
        <span className={`h-1.5 w-1.5 rounded-full ${dotClass(status)}`} aria-hidden="true" />
        <CaretDown size={10} className="text-panel-text-3" aria-hidden="true" />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute left-0 top-7 z-50 w-64 rounded-xl border border-panel-border bg-panel-bg p-1 shadow-[0_1px_2px_rgba(0,0,0,0.05),0_4px_12px_rgba(0,0,0,0.08),0_12px_40px_rgba(0,0,0,0.06)]"
        >
          <div className="flex min-w-0 items-center gap-2 px-2 pt-1.5 pb-2 text-[11px] text-panel-text-3">
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotClass(status)}`}
              aria-hidden="true"
            />
            <span className="truncate">
              {pending ? PENDING_LABELS[pending] : statusLine(status)}
            </span>
          </div>

          {pending ? (
            <button type="button" role="menuitem" onClick={cancel} className={itemClass}>
              <X size={13} aria-hidden="true" />
              Cancel
            </button>
          ) : status && !status.installed ? (
            <button
              type="button"
              role="menuitem"
              disabled={disabled}
              onClick={() => choose("install")}
              className={itemClass}
            >
              <DownloadSimple size={13} aria-hidden="true" />
              Install Claude Code
            </button>
          ) : status && !status.loggedIn ? (
            <button
              type="button"
              role="menuitem"
              disabled={disabled}
              onClick={() => choose("login")}
              className={itemClass}
            >
              <SignIn size={13} aria-hidden="true" />
              Sign in to Claude
            </button>
          ) : status ? (
            <>
              <button
                type="button"
                role="menuitem"
                disabled={disabled}
                onClick={() => choose("switch")}
                className={itemClass}
              >
                <ArrowsClockwise size={13} aria-hidden="true" />
                Switch account
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={disabled}
                onClick={() => choose("logout")}
                className={itemClass}
              >
                <SignOut size={13} aria-hidden="true" />
                Sign out
              </button>
            </>
          ) : null}
        </div>
      )}
    </div>
  );
});
