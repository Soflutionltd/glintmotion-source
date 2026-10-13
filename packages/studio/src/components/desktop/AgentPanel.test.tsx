// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopHost } from "../../utils/desktopHost";
import {
  addAgentStretch,
  clearAgentStretches,
  useAgentStretchStore,
} from "../../player/store/agentStretchStore";
import { AgentPanel } from "./AgentPanel";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let host: HTMLDivElement;
let root: Root;
let send: ReturnType<typeof vi.fn>;

function desktopHost(): DesktopHost {
  send = vi.fn(() => Promise.resolve());
  return {
    claude: {
      status: () => Promise.resolve({ installed: true, loggedIn: true, email: null, busy: false }),
      account: vi.fn(),
      cancel: vi.fn(),
    },
    agent: {
      models: () => Promise.resolve(["opus"]),
      send,
      stop: vi.fn(),
      reset: vi.fn(),
      onEvent: () => () => {},
    },
  } as unknown as DesktopHost;
}

beforeEach(async () => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<AgentPanel host={desktopHost()} />));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  clearAgentStretches();
});

const sendButton = () => host.querySelector<HTMLButtonElement>('button[type="submit"]')!;

function typeInto(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = Object.getPrototypeOf(element) as object;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("AgentPanel with stretches drawn on the timeline", () => {
  it("lists them, focuses the new one's note, and sends them with the message as one request", async () => {
    expect(sendButton().disabled).toBe(true);
    act(() => void addAgentStretch(1, 2.5));

    const note = host.querySelector<HTMLInputElement>('input[aria-label="Note for stretch 1"]')!;
    expect(document.activeElement).toBe(note);
    expect(sendButton().getAttribute("aria-label")).toBe("Send 1 edit to Claude Code");
    expect(sendButton().disabled).toBe(false);

    act(() => typeInto(note, "tighten this part"));
    act(() => typeInto(host.querySelector<HTMLTextAreaElement>("textarea")!, "Keep the music"));
    await act(async () => sendButton().click());

    expect(send).toHaveBeenCalledWith({
      model: "opus",
      prompt: [
        "Keep the music",
        "",
        "Stretches of the timeline (composition file, then seconds from that composition's start):",
        "1. index.html, 1.00 s to 2.50 s: tighten this part",
      ].join("\n"),
    });
    expect(useAgentStretchStore.getState().stretches).toEqual([]);
    expect(host.querySelector('input[aria-label="Note for stretch 1"]')).toBeNull();
  });

  it("moves on to the message on Enter in a note instead of sending", () => {
    act(() => void addAgentStretch(0, 1));
    const note = host.querySelector<HTMLInputElement>('input[aria-label="Note for stretch 1"]')!;
    act(() => {
      note.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(send).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(host.querySelector("textarea"));
  });
});
