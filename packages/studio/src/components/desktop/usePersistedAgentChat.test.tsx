// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { usePersistedAgentChat } from "./usePersistedAgentChat";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

type Item = { id: number; text: string };
let chat: ReturnType<typeof usePersistedAgentChat<Item>>;

function Probe({ projectId }: { projectId: string | null }) {
  chat = usePersistedAgentChat<Item>(projectId);
  return null;
}

let root: Root | null = null;
const mount = (projectId: string | null) => {
  act(() => root?.unmount());
  root = createRoot(document.createElement("div"));
  act(() => root?.render(<Probe projectId={projectId} />));
};

beforeEach(() => localStorage.clear());
afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

describe("usePersistedAgentChat", () => {
  it("brings a project's chat and unsent message back after the studio reloads", () => {
    mount("logo-reel");
    act(() => {
      chat.setItems([{ id: 0, text: "Make the title bigger" }]);
      chat.setDraft("and slower");
    });
    mount("logo-reel");
    expect(chat.items).toEqual([{ id: 0, text: "Make the title bigger" }]);
    expect(chat.draft).toBe("and slower");
  });

  it("keeps each project's chat to itself", () => {
    mount("logo-reel");
    act(() => chat.setItems([{ id: 0, text: "logo" }]));
    mount("appstore-preview");
    expect(chat.items).toEqual([]);
    expect(chat.draft).toBe("");
  });

  it("starts empty from unreadable storage, and stores nothing without a project", () => {
    localStorage.setItem("glintmotion.agentChat.logo-reel", "{oops");
    mount("logo-reel");
    expect(chat.items).toEqual([]);
    localStorage.clear();
    mount(null);
    act(() => chat.setDraft("hello"));
    expect(localStorage.length).toBe(0);
  });
});
