import { memo, useEffect, useState } from "react";
import { Plus, Rows } from "@phosphor-icons/react";
import type { DesktopHost, DesktopProject } from "../../utils/desktopHost";

const rowClass =
  "flex w-full min-w-0 items-center gap-2.5 rounded-md px-2.5 py-[7px] text-left text-[12px] transition-colors";

export const ProjectsPanel = memo(function ProjectsPanel({ host }: { host: DesktopHost }) {
  const [projects, setProjects] = useState<DesktopProject[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([host.listProjects(), host.currentProject()])
      .then(([list, open]) => {
        if (cancelled) return;
        setProjects(list);
        setCurrent(open?.path ?? null);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [host]);

  const open = (project: DesktopProject) => {
    if (project.path === current) return;
    host.openProject(project.path).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason));
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col px-2 py-2.5">
      <button
        type="button"
        onClick={() => void host.home("new")}
        className={`${rowClass} text-panel-text-2 hover:bg-panel-input hover:text-panel-text-1`}
      >
        <Plus size={14} aria-hidden="true" />
        New project
      </button>
      <div className="mt-3 px-2.5 pb-1.5 text-[10px] font-medium uppercase tracking-wider text-neutral-500">
        Recent
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {projects.map((project) => {
          const active = project.path === current;
          return (
            <button
              key={project.path}
              type="button"
              title={project.path}
              aria-current={active || undefined}
              onClick={() => open(project)}
              className={`${rowClass} ${
                active
                  ? "bg-panel-input font-medium text-panel-text-1"
                  : "text-panel-text-3 hover:bg-panel-input/60 hover:text-panel-text-1"
              }`}
            >
              <span
                aria-hidden="true"
                className="h-3 w-3 shrink-0 rounded-[3px] bg-gradient-to-br from-[var(--color-brand-gradient-from)] to-[var(--color-brand-gradient-to)]"
              />
              <span className="truncate">{project.name}</span>
            </button>
          );
        })}
        {error && <p className="px-2.5 py-2 text-[11px] text-red-500">{error}</p>}
      </div>
      <button
        type="button"
        onClick={() => void host.home()}
        className={`${rowClass} mt-2 text-panel-text-3 hover:bg-panel-input hover:text-panel-text-1`}
      >
        <Rows size={14} aria-hidden="true" />
        All projects
        <span className="ml-auto font-mono text-[10px] text-neutral-500">{projects.length}</span>
      </button>
    </div>
  );
});
