import { memo, useEffect, useRef, useState } from "react";
import { ArrowUp, NotePencil, Sparkle, Square, Wrench } from "@phosphor-icons/react";
import type { AgentEvent, DesktopHost } from "../../utils/desktopHost";

type ChatItem =
  | { id: number; role: "user"; text: string }
  | { id: number; role: "assistant"; text: string }
  | { id: number; role: "tool"; name: string; target: string }
  | { id: number; role: "status"; text: string; error: boolean };

type NewChatItem = ChatItem extends infer Item
  ? Item extends ChatItem
    ? Omit<Item, "id">
    : never
  : never;

const MODEL_LABELS: Record<string, string> = { opus: "Opus", sonnet: "Sonnet", haiku: "Haiku" };

function describeDone(event: Extract<AgentEvent, { kind: "done" }>): string {
  if (event.stopped) return "Stopped.";
  const parts: string[] = [];
  if (event.durationMs != null) parts.push(`${(event.durationMs / 1000).toFixed(1)} s`);
  if (event.costUsd != null) parts.push(`$${event.costUsd.toFixed(3)}`);
  return parts.length ? `Done · ${parts.join(" · ")}` : "Done.";
}

export const AgentPanel = memo(function AgentPanel({ host }: { host: DesktopHost }) {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState("opus");
  const nextId = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);

  const push = (item: NewChatItem) =>
    setItems((prev) => [...prev, { ...item, id: nextId.current++ } as ChatItem]);

  useEffect(() => {
    host.agent
      .models()
      .then(setModels)
      .catch(() => setModels([]));
    return host.agent.onEvent((event) => {
      if (event.kind === "text") push({ role: "assistant", text: event.text });
      else if (event.kind === "tool")
        push({ role: "tool", name: event.name, target: event.target });
      else {
        setBusy(false);
        push({
          role: "status",
          text: event.error ?? describeDone(event),
          error: Boolean(event.error),
        });
      }
    });
  }, [host]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [items]);

  const send = () => {
    const prompt = draft.trim();
    if (!prompt || busy) return;
    push({ role: "user", text: prompt });
    setDraft("");
    setBusy(true);
    host.agent.send({ prompt, model }).catch((reason: unknown) => {
      setBusy(false);
      push({
        role: "status",
        text: reason instanceof Error ? reason.message : String(reason),
        error: true,
      });
    });
  };

  const reset = () => {
    if (busy) return;
    void host.agent.reset();
    setItems([]);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-3 pt-2.5 pb-2">
        <span className="flex items-center gap-1.5 text-[12px] font-medium text-panel-text-1">
          <Sparkle size={14} weight="fill" className="text-studio-accent" aria-hidden="true" />
          Claude Code
        </span>
        <select
          value={model}
          onChange={(event) => setModel(event.target.value)}
          disabled={busy}
          aria-label="Model"
          className="h-6 rounded-md bg-panel-input px-1.5 text-[11px] text-panel-text-2 outline-none"
        >
          {models.map((id) => (
            <option key={id} value={id}>
              {MODEL_LABELS[id] ?? id}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={reset}
          disabled={busy || items.length === 0}
          aria-label="New conversation"
          title="New conversation"
          className="ml-auto flex h-6 w-6 items-center justify-center rounded-md text-panel-text-3 transition-colors hover:bg-panel-input hover:text-panel-text-1 disabled:opacity-30"
        >
          <NotePencil size={14} aria-hidden="true" />
        </button>
      </div>

      <div ref={listRef} className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-3 py-2">
        {items.length === 0 && (
          <p className="px-1 pt-6 text-center text-[11px] leading-relaxed text-neutral-500">
            Describe the change you want. The agent edits this project and the preview reloads by
            itself.
          </p>
        )}
        {items.map((item) => {
          if (item.role === "user") {
            return (
              <div
                key={item.id}
                className="ml-6 whitespace-pre-wrap rounded-xl bg-panel-input px-3 py-2 text-[12px] leading-relaxed text-panel-text-1"
              >
                {item.text}
              </div>
            );
          }
          if (item.role === "assistant") {
            return (
              <div
                key={item.id}
                className="whitespace-pre-wrap px-1 text-[12px] leading-relaxed text-panel-text-2"
              >
                {item.text}
              </div>
            );
          }
          if (item.role === "tool") {
            return (
              <div
                key={item.id}
                className="flex min-w-0 items-center gap-1.5 px-1 font-mono text-[10px] text-neutral-500"
              >
                <Wrench size={11} aria-hidden="true" className="shrink-0" />
                <span className="shrink-0">{item.name}</span>
                <span className="truncate">{item.target}</span>
              </div>
            );
          }
          return (
            <div
              key={item.id}
              className={`px-1 text-[10px] ${item.error ? "text-red-500" : "text-neutral-500"}`}
            >
              {item.text}
            </div>
          );
        })}
        {busy && <div className="px-1 text-[11px] text-neutral-500 animate-pulse">Working…</div>}
      </div>

      <form
        className="m-2.5 shrink-0 rounded-xl border border-panel-border bg-panel-input/40 p-2"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              send();
            }
          }}
          rows={3}
          placeholder="Ask Claude Code to change the video…"
          aria-label="Message to the agent"
          className="w-full resize-none bg-transparent px-1 text-[12px] leading-relaxed text-panel-text-1 outline-none placeholder:text-neutral-500"
        />
        <div className="flex justify-end">
          {busy ? (
            <button
              type="button"
              onClick={() => void host.agent.stop()}
              aria-label="Stop"
              className="flex h-7 w-7 items-center justify-center rounded-full bg-panel-text-1 text-panel-bg transition-transform hover:scale-105"
            >
              <Square size={11} weight="fill" aria-hidden="true" />
            </button>
          ) : (
            <button
              type="submit"
              disabled={!draft.trim()}
              aria-label="Send"
              className="flex h-7 w-7 items-center justify-center rounded-full bg-panel-text-1 text-panel-bg transition-transform hover:scale-105 disabled:opacity-30"
            >
              <ArrowUp size={13} weight="bold" aria-hidden="true" />
            </button>
          )}
        </div>
      </form>
    </div>
  );
});
