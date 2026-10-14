import { memo } from "react";
import { File, FilmStrip, Image as ImageIcon, MusicNote } from "@phosphor-icons/react";
import { AUDIO_EXT, IMAGE_EXT, VIDEO_EXT } from "../../utils/mediaTypes";

function FileIcon({ path }: { path: string }) {
  const Icon = IMAGE_EXT.test(path)
    ? ImageIcon
    : VIDEO_EXT.test(path)
      ? FilmStrip
      : AUDIO_EXT.test(path)
        ? MusicNote
        : File;
  return <Icon size={12} aria-hidden="true" className="shrink-0 text-panel-text-3" />;
}

/** The project files that match the `@` being typed, above the agent's message. */
export const AgentMentionMenu = memo(function AgentMentionMenu({
  options,
  active,
  onChoose,
}: {
  options: readonly string[];
  active: number;
  onChoose: (path: string) => void;
}) {
  if (options.length === 0) return null;
  return (
    <ul
      role="listbox"
      aria-label="Project files"
      className="absolute inset-x-0 bottom-full mb-1.5 max-h-56 overflow-y-auto rounded-lg border border-panel-border bg-panel-bg p-1 shadow-lg"
    >
      {options.map((path, index) => {
        const slash = path.lastIndexOf("/");
        return (
          <li key={path} role="option" aria-selected={index === active}>
            <button
              type="button"
              // Keeps the caret in the message, where the mention goes.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onChoose(path)}
              className={`flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-left text-[11.5px] transition-colors ${
                index === active
                  ? "bg-panel-input text-panel-text-1"
                  : "text-panel-text-2 hover:bg-panel-input/60"
              }`}
            >
              <FileIcon path={path} />
              <span className="shrink-0">{path.slice(slash + 1)}</span>
              {slash > 0 && (
                <span className="truncate text-[10.5px] text-panel-text-3">
                  {path.slice(0, slash)}
                </span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
});
