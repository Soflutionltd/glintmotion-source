import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  DownloadSimple,
  NotePencil,
  Paperclip,
  SignIn,
  Square,
  Wrench,
} from "@phosphor-icons/react";
import type {
  AgentEvent,
  ClaudeAccountAction,
  ClaudeStatus,
  DesktopHost,
} from "../../utils/desktopHost";
import { hostErrorMessage } from "../../utils/desktopHost";
import { ClaudeAccountMenu } from "./ClaudeAccountMenu";
import { ProjectsColumnToggle } from "./ProjectsColumnToggle";
import { AgentPendingStretches } from "./AgentPendingStretches";
import { usePersistedAgentChat, useStudioProjectId } from "./usePersistedAgentChat";
import { useHomeRequest } from "./useHomeRequest";
import { useAgentMentions } from "./useAgentMentions";
import { AgentMentionMenu } from "./AgentMentionMenu";
import { TIMELINE_ASSET_MIME } from "../../utils/timelineAssetDrop";
import {
  agentStretchPrompt,
  clearAgentStretches,
  useAgentStretchStore,
} from "../../player/store/agentStretchStore";

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

function composerLabels(stretchCount: number) {
  if (stretchCount === 0)
    return { send: "Send", placeholder: "Ask Claude Code to change the video. @ names a file…" };
  return {
    send: `Send ${stretchCount} edit${stretchCount === 1 ? "" : "s"} to Claude Code`,
    placeholder: "Add a note for all of them (optional)…",
  };
}

export const AgentPanel = memo(function AgentPanel({ host }: { host: DesktopHost }) {
  const projectId = useStudioProjectId();
  const { items, setItems, draft, setDraft } = usePersistedAgentChat<ChatItem>(projectId);
  const [busy, setBusy] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState("opus");
  const [claude, setClaude] = useState<ClaudeStatus | null>(null);
  const [pending, setPending] = useState<ClaudeAccountAction | null>(null);
  const stretches = useAgentStretchStore((s) => s.stretches);
  const nextId = useRef(items.reduce((next, item) => Math.max(next, item.id + 1), 0));
  const listRef = useRef<HTMLDivElement>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const pickerRef = useRef<HTMLInputElement>(null);
  const mentions = useAgentMentions(draft, setDraft, messageRef);

  const push = useCallback(
    (item: NewChatItem) =>
      setItems((prev) => [...prev, { ...item, id: nextId.current++ } as ChatItem]),
    [setItems],
  );

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
  }, [host, push]);

  useEffect(() => {
    const refresh = () => {
      host.claude
        .status()
        .then(setClaude)
        .catch(() => setClaude(null));
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [host]);

  const runAccount = (action: ClaudeAccountAction) => {
    if (pending || busy) return;
    setPending(action);
    host.claude
      .account(action)
      .then(setClaude)
      .catch((reason: unknown) =>
        push({
          role: "status",
          text: hostErrorMessage(reason),
          error: true,
        }),
      )
      .finally(() => setPending(null));
  };

  const ready = Boolean(claude?.installed && claude.loggedIn) && !pending;

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [items]);

  const send = (text = draft) => {
    const message = text.trim();
    if ((!message && stretches.length === 0) || busy || !ready) return;
    const prompt = mentions.resolvePrompt(agentStretchPrompt(message, stretches));
    push({ role: "user", text: prompt });
    setDraft("");
    clearAgentStretches();
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

  useHomeRequest(host, claude, ready, (prompt, sendNow) =>
    sendNow ? send(prompt) : setDraft(prompt),
  );

  const labels = composerLabels(stretches.length);

  const reset = () => {
    if (busy) return;
    void host.agent.reset();
    setItems([]);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-3 pt-2.5 pb-2">
        <ProjectsColumnToggle when="hidden" />
        <ClaudeAccountMenu
          status={claude}
          pending={pending}
          disabled={busy}
          onAction={runAccount}
          onCancel={() => void host.claude.cancel()}
        />
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
        {items.length === 0 && claude && !ready && (
          <div className="flex flex-col items-center gap-3 px-1 pt-6 text-center">
            <p className="text-[11px] leading-relaxed text-neutral-500">
              {pending
                ? "Finish in your browser, then come back here."
                : claude.installed
                  ? "Sign in with your Claude account to let the agent edit this project."
                  : "The agent runs on Claude Code. Install it to edit this project by chat."}
            </p>
            {!pending && (
              <button
                type="button"
                onClick={() => runAccount(claude.installed ? "login" : "install")}
                className="flex items-center gap-1.5 rounded-full bg-panel-text-1 px-4 py-1.5 text-[12px] font-medium text-panel-bg transition-transform hover:scale-105"
              >
                {claude.installed ? (
                  <SignIn size={13} aria-hidden="true" />
                ) : (
                  <DownloadSimple size={13} aria-hidden="true" />
                )}
                {claude.installed ? "Sign in to Claude" : "Install Claude Code"}
              </button>
            )}
          </div>
        )}
        {items.length === 0 && ready && (
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
        className="relative m-2.5 shrink-0 rounded-xl border border-panel-border bg-panel-input/40 p-2"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
        onDragOver={(event) => {
          const types = event.dataTransfer.types;
          if (types.includes("Files") || types.includes(TIMELINE_ASSET_MIME))
            event.preventDefault();
        }}
        onDrop={(event) => {
          const asset = event.dataTransfer.getData(TIMELINE_ASSET_MIME);
          if (!asset && event.dataTransfer.files.length === 0) return;
          event.preventDefault();
          if (asset) mentions.mentionDropped(asset);
          else void mentions.attach(Array.from(event.dataTransfer.files));
        }}
      >
        <AgentMentionMenu
          options={mentions.options}
          active={mentions.active}
          onChoose={mentions.choose}
        />
        <AgentPendingStretches disabled={busy} onNoteDone={() => messageRef.current?.focus()} />
        <textarea
          ref={messageRef}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            mentions.track();
          }}
          onSelect={mentions.track}
          onBlur={() => requestAnimationFrame(mentions.track)}
          onKeyDown={(event) => {
            if (mentions.handleKey(event)) return;
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              send();
            }
          }}
          rows={3}
          placeholder={labels.placeholder}
          aria-label="Message to the agent"
          className="w-full resize-none bg-transparent px-1 text-[12px] leading-relaxed text-panel-text-1 outline-none placeholder:text-neutral-500"
        />
        <div className="flex items-center justify-between">
          {mentions.canAttach ? (
            <>
              <button
                type="button"
                onClick={() => pickerRef.current?.click()}
                aria-label="Attach a file"
                title="Attach a file, or type @ to name one of the project's"
                className="flex h-7 w-7 items-center justify-center rounded-full text-panel-text-3 transition-colors hover:bg-panel-input hover:text-panel-text-1"
              >
                <Paperclip size={14} aria-hidden="true" />
              </button>
              <input
                ref={pickerRef}
                type="file"
                multiple
                hidden
                onChange={(event) => {
                  const files = Array.from(event.target.files ?? []);
                  event.target.value = "";
                  void mentions.attach(files);
                }}
              />
            </>
          ) : (
            <span />
          )}
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
              disabled={(!draft.trim() && stretches.length === 0) || !ready}
              aria-label={labels.send}
              title={labels.send}
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
