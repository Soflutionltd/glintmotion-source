import { useCallback, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { useFileManagerContextOptional } from "../../contexts/FileManagerContext";
import {
  insertMention,
  matchMentionFiles,
  mentionAt,
  mentionedFiles,
  withMentionedFiles,
} from "../../utils/agentMentions";

const NO_FILES: readonly string[] = [];
const ATTACH_DIR = "assets";
/** Keys the open menu takes: a step through the list, or what happens to it. */
const MENU_KEYS: Partial<Record<string, 1 | -1 | "choose" | "close">> = {
  ArrowDown: 1,
  ArrowUp: -1,
  Enter: "choose",
  Tab: "choose",
  Escape: "close",
};

/**
 * `@` in the agent's message: a menu of the project's files while a mention is typed, files
 * dropped or picked from the Mac copied into assets/, and the prompt naming every file mentioned.
 */
export function useAgentMentions(
  draft: string,
  setDraft: (draft: string) => void,
  messageRef: RefObject<HTMLTextAreaElement | null>,
) {
  const fileManager = useFileManagerContextOptional();
  const paths = fileManager?.fileTree ?? NO_FILES;
  const attached = useRef<string[]>([]);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [active, setActive] = useState(0);
  const options = useMemo(
    () => (mention ? matchMentionFiles(paths, mention.query) : []),
    [mention, paths],
  );

  const track = useCallback(() => {
    const field = messageRef.current;
    if (!field) return;
    setMention(mentionAt(field.value, field.selectionStart));
    setActive(0);
  }, [messageRef]);

  const placeCaret = useCallback(
    (caret: number) => {
      requestAnimationFrame(() => {
        const field = messageRef.current;
        field?.focus();
        field?.setSelectionRange(caret, caret);
      });
    },
    [messageRef],
  );

  const choose = useCallback(
    (path: string) => {
      if (!mention) return;
      const caret = messageRef.current?.selectionStart ?? draft.length;
      const next = insertMention(draft, mention.start, caret, path);
      setDraft(next.text);
      setMention(null);
      placeCaret(next.caret);
    },
    [draft, mention, messageRef, placeCaret, setDraft],
  );

  /** True when the key drove the menu and the composer must not act on it. */
  const handleKey = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    const action = MENU_KEYS[event.key];
    if (!action || options.length === 0 || event.nativeEvent.isComposing) return false;
    event.preventDefault();
    if (action === "close") setMention(null);
    else if (action === "choose") choose(options[active] ?? options[0]);
    else setActive((index) => (index + action + options.length) % options.length);
    return true;
  };

  const mentionPaths = useCallback(
    (added: readonly string[]) => {
      if (added.length === 0) return;
      const current = messageRef.current?.value ?? draft;
      const tags = added.map((path) => `@${path}`).join(" ");
      const text = current && !/\s$/.test(current) ? `${current} ${tags} ` : `${current}${tags} `;
      setDraft(text);
      placeCaret(text.length);
    },
    [draft, messageRef, placeCaret, setDraft],
  );

  /** A file dragged from the Files panel, whose payload is `{ path }`. */
  const mentionDropped = useCallback(
    (payload: string) => {
      try {
        const path = (JSON.parse(payload) as { path?: unknown }).path;
        if (typeof path === "string") mentionPaths([path]);
      } catch {
        // Another app's drag that borrowed the type: nothing to mention.
      }
    },
    [mentionPaths],
  );

  const attach = useCallback(
    async (files: Iterable<File>) => {
      if (!fileManager) return;
      const uploaded = await fileManager.uploadProjectFiles(files, ATTACH_DIR);
      attached.current = [...attached.current, ...uploaded];
      mentionPaths(uploaded);
    },
    [fileManager, mentionPaths],
  );

  const resolvePrompt = useCallback(
    (prompt: string) =>
      withMentionedFiles(prompt, mentionedFiles(prompt, [...paths, ...attached.current])),
    [paths],
  );

  return {
    canAttach: fileManager !== null,
    options: mention ? options : [],
    active,
    track,
    choose,
    handleKey,
    mentionDropped,
    attach,
    resolvePrompt,
  };
}
