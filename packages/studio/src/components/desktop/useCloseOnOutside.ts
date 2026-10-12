import { useEffect, type RefObject } from "react";

/** Closes a popover on a pointer press outside every `roots` element or on Escape, while it is open. */
export function useCloseOnOutside(
  open: boolean,
  roots: readonly RefObject<HTMLElement | null>[],
  close: () => void,
) {
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!roots.some((root) => root.current?.contains(target))) close();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open, roots, close]);
}
