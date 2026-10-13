import { SidebarSimple } from "@phosphor-icons/react";
import { useDockLayoutStore } from "../dock/dockLayoutStore";

const PROJECTS_TOGGLE_SHORTCUT = "⌘B";

/** Rendered only while the Projects column is in the state `when`, so each header shows one way back. */
export function ProjectsColumnToggle({ when }: { when: "shown" | "hidden" }) {
  const shown = useDockLayoutStore((state) => state.visiblePanels.has("projects"));
  const toggle = useDockLayoutStore((state) => state.toggleProjectsColumn);
  if (shown !== (when === "shown")) return null;
  const label = shown ? "Hide projects" : "Show projects";
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={label}
      title={`${label} (${PROJECTS_TOGGLE_SHORTCUT})`}
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-panel-text-3 transition-colors hover:bg-panel-input hover:text-panel-text-1"
    >
      <SidebarSimple size={14} aria-hidden="true" />
    </button>
  );
}
