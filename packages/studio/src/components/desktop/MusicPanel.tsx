import { memo, useEffect, useState } from "react";
import { Key, MusicNotes } from "@phosphor-icons/react";
import { usePlayerStore } from "../../player";
import type { DesktopHost } from "../../utils/desktopHost";
import { hostErrorMessage } from "../../utils/desktopHost";

const inputClass =
  "w-full rounded-lg border border-panel-border bg-panel-input/40 px-2.5 py-2 text-[12px] text-panel-text-1 outline-none placeholder:text-neutral-500 focus:border-studio-accent";

const primaryClass =
  "flex h-8 items-center justify-center gap-1.5 rounded-full bg-panel-text-1 px-4 text-[12px] font-medium text-panel-bg transition-transform hover:scale-105 disabled:opacity-30 disabled:hover:scale-100";

function KeyForm({ host, onSaved }: { host: DesktopHost; onSaved: () => void }) {
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);

  const save = () => {
    setError(null);
    host.music
      .saveKey(key)
      .then(() => {
        setKey("");
        onSaved();
      })
      .catch((reason: unknown) => setError(hostErrorMessage(reason)));
  };

  return (
    <form
      className="space-y-3 px-3 py-4"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <p className="text-[11px] leading-relaxed text-neutral-500">
        Music is composed by Eleven Music. Paste your ElevenLabs API key once: Glintmotion keeps it
        encrypted with your Mac's Keychain.
      </p>
      <input
        type="password"
        value={key}
        onChange={(event) => setKey(event.target.value)}
        placeholder="ElevenLabs API key"
        aria-label="ElevenLabs API key"
        autoComplete="off"
        className={inputClass}
      />
      {error && <p className="text-[11px] text-red-500">{error}</p>}
      <button type="submit" disabled={!key.trim()} className={primaryClass}>
        <Key size={13} aria-hidden="true" />
        Save key
      </button>
    </form>
  );
}

export const MusicPanel = memo(function MusicPanel({
  host,
  onAddAudio,
}: {
  host: DesktopHost;
  onAddAudio: (path: string) => unknown;
}) {
  const duration = usePlayerStore((state) => state.duration);
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [prompt, setPrompt] = useState("");
  const [seconds, setSeconds] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  useEffect(() => {
    host.music
      .hasKey()
      .then(setHasKey)
      .catch(() => setHasKey(false));
  }, [host]);

  const length = seconds.trim() ? Number(seconds) : Math.round(duration * 10) / 10;

  const generate = () => {
    if (busy || !prompt.trim()) return;
    setBusy(true);
    setMessage(null);
    const startedAt = performance.now();
    host.music
      .generate({ prompt, seconds: length })
      .then(async (path) => {
        await onAddAudio(path);
        const took = ((performance.now() - startedAt) / 1000).toFixed(0);
        setMessage({ text: `Added to the timeline: ${path} (${took} s)`, error: false });
      })
      .catch((reason: unknown) => setMessage({ text: hostErrorMessage(reason), error: true }))
      .finally(() => setBusy(false));
  };

  const forgetKey = () => {
    void host.music.clearKey().then(() => host.music.hasKey().then(setHasKey));
  };

  if (hasKey === null) return null;
  if (!hasKey) return <KeyForm host={host} onSaved={() => setHasKey(true)} />;

  return (
    <form
      className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto px-3 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        generate();
      }}
    >
      <label className="space-y-1.5">
        <span className="text-[11px] font-medium text-panel-text-2">Describe the music</span>
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          rows={5}
          placeholder="Joyful pop, 118 BPM, marimba and hand claps, bright final chord"
          className={`${inputClass} resize-none leading-relaxed`}
        />
      </label>
      <label className="flex items-center gap-2">
        <span className="text-[11px] font-medium text-panel-text-2">Length (s)</span>
        <input
          type="number"
          min={3}
          max={600}
          step={0.1}
          value={seconds}
          onChange={(event) => setSeconds(event.target.value)}
          placeholder={duration > 0 ? String(Math.round(duration * 10) / 10) : "30"}
          aria-label="Length in seconds"
          className={`${inputClass} w-20`}
        />
      </label>
      <p className="text-[11px] leading-relaxed text-neutral-500">
        Instrumental, as long as the video unless you set a length, with a fade on the last beat. It
        lands at the start of the timeline. Each track uses ElevenLabs credits.
      </p>
      <button
        type="submit"
        disabled={busy || !prompt.trim() || !(length >= 3)}
        className={`${primaryClass} self-start`}
      >
        <MusicNotes size={13} aria-hidden="true" />
        {busy ? "Composing…" : "Generate music"}
      </button>
      {message && (
        <p
          className={`break-words text-[11px] ${message.error ? "text-red-500" : "text-neutral-500"}`}
        >
          {message.text}
        </p>
      )}
      <button
        type="button"
        onClick={forgetKey}
        className="mt-auto self-start text-[10px] text-neutral-500 underline-offset-2 hover:underline"
      >
        Forget the ElevenLabs key
      </button>
    </form>
  );
});
