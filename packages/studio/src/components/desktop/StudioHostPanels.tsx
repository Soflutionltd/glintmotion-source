import { memo } from "react";
import { Dock } from "../dock/Dock";
import { getDesktopHost } from "../../utils/desktopHost";
import { AgentPanel } from "./AgentPanel";
import { FilesPanel } from "./FilesPanel";
import { MusicPanel } from "./MusicPanel";
import { ProjectsPanel } from "./ProjectsPanel";

export const StudioHostPanels = memo(function StudioHostPanels({
  onAddAudioAtStart,
}: {
  onAddAudioAtStart: (path: string) => unknown;
}) {
  const host = getDesktopHost();
  if (!host) return null;
  return (
    <>
      <Dock.Panel id="projects">
        <ProjectsPanel host={host} />
      </Dock.Panel>
      <Dock.Panel id="agent">
        <AgentPanel host={host} />
      </Dock.Panel>
      <Dock.Panel id="music">
        <MusicPanel host={host} onAddAudio={onAddAudioAtStart} />
      </Dock.Panel>
      <Dock.Panel id="files">
        <FilesPanel />
      </Dock.Panel>
    </>
  );
});
