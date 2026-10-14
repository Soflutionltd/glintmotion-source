import { memo, useState } from "react";
import { ShareNetwork } from "@phosphor-icons/react";
import type { DeliveryPreset } from "../../utils/desktopHost";
import { getDesktopHost, hostErrorMessage } from "../../utils/desktopHost";
import { AnchoredPopover } from "./AnchoredPopover";
import { useAnchoredPopover } from "./useAnchoredPopover";

const COLOR_STORAGE_KEY = "glintmotion.deliverColor";

const PRESETS: { id: DeliveryPreset; label: string; hint: string }[] = [
  { id: "reel", label: "Reel / Story", hint: "1080 × 1920" },
  { id: "post", label: "Feed post", hint: "1080 × 1350" },
  { id: "square", label: "Square", hint: "1080 × 1080" },
  { id: "original", label: "Same size", hint: "as rendered" },
];

/** Empty until one is picked: the colour input then shows black, and the app pads in black. */
function savedColor(): string {
  const value = localStorage.getItem(COLOR_STORAGE_KEY);
  return value && /^#[0-9a-fA-F]{6}$/.test(value) ? value : "";
}

/** Re-encodes a finished render for Instagram and TikTok through the Glintmotion Mac app. */
export const DeliverMenu = memo(function DeliverMenu({ filename }: { filename: string }) {
  const host = getDesktopHost();
  const popover = useAnchoredPopover();
  const [color, setColor] = useState(savedColor);
  const [running, setRunning] = useState<DeliveryPreset | null>(null);
  const [result, setResult] = useState<{ text: string; file: string | null } | null>(null);

  if (!host) return null;

  const deliver = async (preset: DeliveryPreset) => {
    if (running) return;
    setRunning(preset);
    setResult(null);
    try {
      const target = await host.exports.choose({ format: "mp4", suffix: preset });
      if (!target) return;
      const file = await host.deliver.render({ filename, preset, color, target: target.id });
      setResult({ text: `Saved ${file.split("/").pop() ?? file}`, file });
    } catch (reason: unknown) {
      setResult({ text: hostErrorMessage(reason), file: null });
    } finally {
      setRunning(null);
    }
  };

  const changeColor = (value: string) => {
    setColor(value);
    localStorage.setItem(COLOR_STORAGE_KEY, value);
  };

  return (
    <div onClick={(event) => event.stopPropagation()}>
      <button
        ref={popover.buttonRef}
        type="button"
        onClick={popover.toggle}
        aria-haspopup="dialog"
        aria-expanded={popover.open}
        aria-label={`Export ${filename} for social media`}
        title="Export for social media"
        className="flex h-6 w-6 items-center justify-center rounded-md text-text-4 transition-colors hover:bg-hover hover:text-text-2"
      >
        <ShareNetwork size={13} aria-hidden="true" />
      </button>

      <AnchoredPopover
        popover={popover}
        label="Export for social media"
        className="w-60"
        onClick={(event) => event.stopPropagation()}
      >
        <p className="px-2 pt-1 pb-2 text-[11px] leading-relaxed text-panel-text-3">
          HEVC, sound levelled for Instagram (-14 LUFS). You choose where it is saved.
        </p>
        {PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            disabled={running !== null}
            onClick={() => void deliver(preset.id)}
            className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-panel-text-1 transition-colors hover:bg-panel-input disabled:opacity-40"
          >
            <span>{running === preset.id ? "Exporting…" : preset.label}</span>
            <span className="text-[10px] text-panel-text-3">{preset.hint}</span>
          </button>
        ))}
        <label className="mt-1 flex items-center justify-between gap-2 border-t border-panel-border px-2 pt-2 pb-1 text-[11px] text-panel-text-2">
          Margin colour
          <input
            type="color"
            value={color}
            onChange={(event) => changeColor(event.target.value)}
            aria-label="Margin colour"
            className="h-6 w-10 cursor-pointer rounded border border-panel-border bg-transparent"
          />
        </label>
        {result && (
          <div className="flex items-center justify-between gap-2 px-2 pt-1.5 pb-1 text-[10px] text-panel-text-3">
            <span className="min-w-0 break-words">{result.text}</span>
            {result.file && (
              <button
                type="button"
                onClick={() => void host.deliver.reveal(result.file as string)}
                className="shrink-0 text-studio-accent hover:underline"
              >
                Show
              </button>
            )}
          </div>
        )}
      </AnchoredPopover>
    </div>
  );
});
