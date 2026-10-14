import type { MouseEventHandler, ReactNode } from "react";
import { createPortal } from "react-dom";
import type { AnchoredPopoverState } from "./useAnchoredPopover";

const PANEL_CLASS =
  "fixed z-[1000] rounded-xl border border-panel-border bg-panel-bg p-1.5 shadow-[0_1px_2px_rgba(0,0,0,0.05),0_4px_12px_rgba(0,0,0,0.08),0_12px_40px_rgba(0,0,0,0.06)]";

export function AnchoredPopover({
  popover,
  label,
  className,
  onClick,
  children,
}: {
  popover: AnchoredPopoverState;
  label: string;
  className: string;
  onClick?: MouseEventHandler<HTMLDivElement>;
  children: ReactNode;
}) {
  const { open, anchor, menuRef } = popover;
  if (!open || !anchor) return null;
  return createPortal(
    <div
      ref={menuRef}
      role="dialog"
      aria-label={label}
      style={{ top: anchor.top, right: anchor.right }}
      onClick={onClick}
      className={`${PANEL_CLASS} ${className}`}
    >
      {children}
    </div>,
    document.body,
  );
}
