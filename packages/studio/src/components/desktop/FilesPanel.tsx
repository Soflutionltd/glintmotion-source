import { memo, useMemo, useRef, useState } from "react";
import { CaretRight, File, FolderSimple, Plus } from "@phosphor-icons/react";
import { SearchInput } from "../ui/SearchInput";
import { useFileManagerContext } from "../../contexts/FileManagerContext";
import { useDockLayoutStore } from "../dock/dockLayoutStore";
import { isMediaFile } from "../../utils/mediaTypes";
import { TIMELINE_ASSET_MIME } from "../../utils/timelineAssetDrop";

interface FolderNode {
  name: string;
  path: string;
  folders: FolderNode[];
  files: string[];
  count: number;
}

function buildTree(paths: readonly string[]): FolderNode {
  const root: FolderNode = { name: "", path: "", folders: [], files: [], count: 0 };
  for (const path of paths) {
    const parts = path.split("/");
    let node = root;
    node.count += 1;
    for (const part of parts.slice(0, -1)) {
      const childPath = node.path ? `${node.path}/${part}` : part;
      let child = node.folders.find((folder) => folder.name === part);
      if (!child) {
        child = { name: part, path: childPath, folders: [], files: [], count: 0 };
        node.folders.push(child);
      }
      child.count += 1;
      node = child;
    }
    node.files.push(path);
  }
  const sort = (node: FolderNode) => {
    node.folders.sort((a, b) => a.name.localeCompare(b.name));
    node.files.sort((a, b) => a.localeCompare(b));
    node.folders.forEach(sort);
  };
  sort(root);
  return root;
}

const rowClass =
  "flex w-full min-w-0 items-center gap-1.5 rounded-md py-[5px] pr-2 text-left text-[12px] transition-colors";

function FolderRow({
  node,
  depth,
  expanded,
  forceOpen,
  onToggle,
  onOpenFile,
}: {
  node: FolderNode;
  depth: number;
  expanded: ReadonlySet<string>;
  forceOpen: boolean;
  onToggle: (path: string) => void;
  onOpenFile: (path: string) => void;
}) {
  const open = forceOpen || expanded.has(node.path);
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => onToggle(node.path)}
        className={`${rowClass} text-panel-text-2 hover:bg-panel-input/60 hover:text-panel-text-1`}
        style={{ paddingLeft: 8 + depth * 14 }}
      >
        <CaretRight
          size={10}
          aria-hidden="true"
          className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
        />
        <FolderSimple size={14} aria-hidden="true" className="shrink-0" />
        <span className="truncate">{node.name}</span>
        <span className="ml-auto pl-2 font-mono text-[10px] text-neutral-500">{node.count}</span>
      </button>
      {open && (
        <TreeChildren
          node={node}
          depth={depth + 1}
          expanded={expanded}
          forceOpen={forceOpen}
          onToggle={onToggle}
          onOpenFile={onOpenFile}
        />
      )}
    </>
  );
}

function TreeChildren(props: {
  node: FolderNode;
  depth: number;
  expanded: ReadonlySet<string>;
  forceOpen: boolean;
  onToggle: (path: string) => void;
  onOpenFile: (path: string) => void;
}) {
  const { node, depth, onOpenFile } = props;
  return (
    <>
      {node.folders.map((folder) => (
        <FolderRow key={folder.path} {...props} node={folder} />
      ))}
      {node.files.map((path) => {
        const media = isMediaFile(path);
        return (
          <button
            key={path}
            type="button"
            title={path}
            draggable={media}
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = "copy";
              event.dataTransfer.setData(TIMELINE_ASSET_MIME, JSON.stringify({ path }));
              event.dataTransfer.setData("text/plain", path);
            }}
            onClick={() => onOpenFile(path)}
            className={`${rowClass} text-panel-text-3 hover:bg-panel-input/60 hover:text-panel-text-1`}
            style={{ paddingLeft: 8 + depth * 14 + 16 }}
          >
            <File size={13} aria-hidden="true" className="shrink-0" />
            <span className="truncate">{path.split("/").pop()}</span>
          </button>
        );
      })}
    </>
  );
}

export const FilesPanel = memo(function FilesPanel() {
  const { fileTree, handleFileSelect, handleImportFiles } = useFileManagerContext();
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const inputRef = useRef<HTMLInputElement>(null);

  const needle = query.trim().toLowerCase();
  const visible = useMemo(() => {
    const shown = fileTree.filter((path) => !path.split("/").some((part) => part.startsWith(".")));
    return needle ? shown.filter((path) => path.toLowerCase().includes(needle)) : shown;
  }, [fileTree, needle]);
  const tree = useMemo(() => buildTree(visible), [visible]);

  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const openFile = (path: string) => {
    handleFileSelect(path);
    useDockLayoutStore.getState().activatePanel("code");
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-3 pt-2.5 pb-2">
        <SearchInput
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search files..."
          aria-label="Search files"
          className="flex-1"
        />
        <button
          type="button"
          aria-label="Import files"
          title="Import files"
          onClick={() => inputRef.current?.click()}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-studio-accent text-white transition-transform hover:scale-105 active:scale-95"
        >
          <Plus size={14} weight="bold" aria-hidden="true" />
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(event) => {
            const files = event.target.files;
            if (files?.length) void handleImportFiles(files);
            event.target.value = "";
          }}
        />
      </div>
      <div className="flex shrink-0 items-center justify-between px-4 pb-1.5 text-[10px] font-medium uppercase tracking-wider text-neutral-500">
        <span>This project</span>
        <span className="font-mono">{tree.count}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        <TreeChildren
          node={tree}
          depth={0}
          expanded={expanded}
          forceOpen={needle.length > 0}
          onToggle={toggle}
          onOpenFile={openFile}
        />
        {tree.count === 0 && (
          <p className="px-3 py-6 text-center text-[11px] text-neutral-500">
            {needle ? "No file matches this search." : "This project has no files yet."}
          </p>
        )}
      </div>
    </div>
  );
});
