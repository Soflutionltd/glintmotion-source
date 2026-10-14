import { useCallback, useMemo, useRef, useState } from "react";
import { useCloseOnOutside } from "./useCloseOnOutside";

type PopoverAnchor = { top: number; right: number };

/** A popover pinned under its button's right edge, closed by a press outside both or by Escape. */
export function useAnchoredPopover() {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<PopoverAnchor | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const roots = useMemo(() => [buttonRef, menuRef], []);
  useCloseOnOutside(open, roots, close);

  const place = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) setAnchor({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
  };
  const show = () => {
    place();
    setOpen(true);
  };
  const toggle = () => {
    place();
    setOpen((value) => !value);
  };

  return { open, anchor, buttonRef, menuRef, show, toggle, close };
}

export type AnchoredPopoverState = ReturnType<typeof useAnchoredPopover>;
