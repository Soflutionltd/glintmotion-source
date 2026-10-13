import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_AGENT_STRETCHES,
  addAgentStretch,
  agentStretchPrompt,
  clearAgentStretches,
  removeAgentStretch,
  setStretchDrawing,
  updateAgentStretchNote,
  useAgentStretchStore,
} from "./agentStretchStore";

afterEach(clearAgentStretches);

describe("agentStretchStore", () => {
  it("keeps a stretch drawn right to left in order, sorted by start, and leaves drawing", () => {
    setStretchDrawing(true);
    addAgentStretch(5, 4);
    addAgentStretch(1, 2);
    const { stretches, drawing, lastAddedId } = useAgentStretchStore.getState();
    expect(stretches.map(({ start, end }) => [start, end])).toEqual([
      [1, 2],
      [4, 5],
    ]);
    expect(drawing).toBe(false);
    expect(lastAddedId).toBe(stretches[0]!.id);
  });

  it("edits and drops one stretch by id", () => {
    addAgentStretch(0, 1);
    addAgentStretch(2, 3);
    const [first, second] = useAgentStretchStore.getState().stretches;
    updateAgentStretchNote(second!.id, "tighten");
    removeAgentStretch(first!.id);
    expect(useAgentStretchStore.getState().stretches).toEqual([
      { id: second!.id, start: 2, end: 3, note: "tighten" },
    ]);
  });

  it(`stops at ${MAX_AGENT_STRETCHES} stretches and refuses to draw more`, () => {
    for (let index = 0; index < MAX_AGENT_STRETCHES; index++) addAgentStretch(index, index + 0.5);
    expect(addAgentStretch(20, 21)).toBe(false);
    setStretchDrawing(true);
    expect(useAgentStretchStore.getState().drawing).toBe(false);
    expect(useAgentStretchStore.getState().stretches).toHaveLength(MAX_AGENT_STRETCHES);
  });
});

describe("agentStretchPrompt", () => {
  const stretch = (start: number, end: number, note: string) => ({ id: 1, start, end, note });

  it("is the message alone when no stretch is drawn", () => {
    expect(agentStretchPrompt("Make it faster", [])).toBe("Make it faster");
  });

  it("lists each stretch under the message, with its note when it has one", () => {
    expect(
      agentStretchPrompt("Keep the colours", [
        stretch(1.2, 3.456, " tighten this "),
        stretch(5, 6, ""),
      ]),
    ).toBe(
      [
        "Keep the colours",
        "",
        "Stretches of the timeline (seconds of the main composition):",
        "1. 1.20 s to 3.46 s: tighten this",
        "2. 5.00 s to 6.00 s",
      ].join("\n"),
    );
  });

  it("asks for the noted changes when there is no message", () => {
    expect(agentStretchPrompt("", [stretch(0, 1, "cut")]).split("\n")[0]).toBe(
      "Change these stretches of the video as noted.",
    );
  });
});
