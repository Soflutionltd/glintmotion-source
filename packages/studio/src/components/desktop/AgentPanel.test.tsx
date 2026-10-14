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

const uploadProjectFiles = vi.fn((files: Iterable<File>, dir?: string) =>
  Promise.resolve(Array.from(files).map((file) => `${dir}/${file.name}`)),
);

vi.mock("../../contexts/FileManagerContext", () => ({
  useFileManagerContextOptional: () => ({
    fileTree: ["index.html", "assets/logo.png", "compositions/slide-01.html"],
    uploadProjectFiles,
  }),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let host = document.createElement("div");
let root: Root | null = null;
let send: ReturnType<typeof vi.fn>;

function desktopHost({ pending = null as string | null, loggedIn = true } = {}): DesktopHost {
  send = vi.fn(() => Promise.resolve());
  return {
    claude: {
      status: () => Promise.resolve({ installed: true, loggedIn, email: null, busy: false }),
      account: vi.fn(),
      cancel: vi.fn(),
    },
    agent: {
      models: () => Promise.resolve(["opus"]),
      send,
      stop: vi.fn(),
      reset: vi.fn(),
      takePending: () => Promise.resolve(pending),
      onEvent: () => () => {},
    },
  } as unknown as DesktopHost;
}

async function mount(options?: Parameters<typeof desktopHost>[0]) {
  act(() => root?.unmount());
  host.remove();
  host = document.createElement("div");
  document.body.append(host);
  const next = createRoot(host);
  root = next;
  await act(async () => next.render(<AgentPanel host={desktopHost(options)} />));
}

beforeEach(() => mount());

afterEach(() => {
  act(() => root?.unmount());
  root = null;
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

describe("AgentPanel @ mentions", () => {
  const message = () => host.querySelector<HTMLTextAreaElement>("textarea")!;
  const typeAtEnd = (value: string) => {
    typeInto(message(), value);
    message().setSelectionRange(value.length, value.length);
    message().dispatchEvent(new Event("select", { bubbles: true }));
  };

  it("offers the matching files, inserts the chosen one, and names it in the prompt", async () => {
    act(() => typeAtEnd("Put @lo"));
    const options = host.querySelectorAll('[role="option"]');
    expect(options).toHaveLength(1);
    expect(options[0].textContent).toContain("logo.png");

    act(() => {
      message().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(message().value).toBe("Put @assets/logo.png ");
    expect(host.querySelector('[role="listbox"]')).toBeNull();

    await act(async () => sendButton().click());
    const [{ prompt }] = send.mock.calls[0] as unknown as [{ prompt: string }];
    expect(prompt).toMatch(/^Put @assets\/logo\.png\n\nFiles the message names with @/);
    expect(prompt).toMatch(/\n- assets\/logo\.png$/);
  });

  it("copies a picked file into assets and mentions it", async () => {
    const picker = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File(["png"], "product.png", { type: "image/png" });
    Object.defineProperty(picker, "files", { value: [file], configurable: true });
    await act(async () => picker.dispatchEvent(new Event("change", { bubbles: true })));

    expect(uploadProjectFiles).toHaveBeenCalledWith([file], "assets");
    expect(message().value).toBe("@assets/product.png ");
  });
});

describe("AgentPanel with a request typed on Home", () => {
  it("sends it as soon as Claude is signed in, and shows it in the chat", async () => {
    await mount({ pending: "Une vidéo de lancement pour tonsite.com" });
    expect(send).toHaveBeenCalledWith({
      model: "opus",
      prompt: "Une vidéo de lancement pour tonsite.com",
    });
    expect(host.textContent).toContain("Une vidéo de lancement pour tonsite.com");
  });

  it("leaves it in the composer while Claude still needs a sign-in", async () => {
    await mount({ pending: "Une vidéo de lancement", loggedIn: false });
    expect(send).not.toHaveBeenCalled();
    expect(host.querySelector("textarea")?.value).toBe("Une vidéo de lancement");
  });
});
