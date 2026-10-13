import { create } from "zustand";

/** The project's root composition, the one the Mac app renders and checks. */
export const MAIN_COMPOSITION = "index.html";

/** A stretch of the timeline drawn for the agent, in seconds of the composition it was drawn on. */
export interface AgentStretch {
  id: number;
  composition: string;
  start: number;
  end: number;
  note: string;
}

export const MAX_AGENT_STRETCHES = 10;

interface AgentStretchState {
  /** The timeline takes drags as stretches instead of clip and scrub gestures. */
  drawing: boolean;
  /** The composition the timeline shows, so a stretch keeps whose seconds it counts. */
  composition: string;
  stretches: AgentStretch[];
  lastAddedId: number | null;
}

let nextId = 1;

export const useAgentStretchStore = create<AgentStretchState>(() => ({
  drawing: false,
  composition: MAIN_COMPOSITION,
  stretches: [],
  lastAddedId: null,
}));

export const setStretchComposition = (composition: string | null) =>
  useAgentStretchStore.setState({ composition: composition || MAIN_COMPOSITION });

export const setStretchDrawing = (drawing: boolean) =>
  useAgentStretchStore.setState({
    drawing: drawing && useAgentStretchStore.getState().stretches.length < MAX_AGENT_STRETCHES,
  });

/** Adds the stretch and leaves drawing mode, so the note can be typed; false when the list is full. */
export function addAgentStretch(from: number, to: number): boolean {
  const { stretches, composition } = useAgentStretchStore.getState();
  if (stretches.length >= MAX_AGENT_STRETCHES) return false;
  const id = nextId++;
  const stretch = { id, composition, start: Math.min(from, to), end: Math.max(from, to), note: "" };
  useAgentStretchStore.setState({
    drawing: false,
    stretches: [...stretches, stretch],
    lastAddedId: id,
  });
  return true;
}

export const updateAgentStretchNote = (id: number, note: string) =>
  useAgentStretchStore.setState(({ stretches }) => ({
    stretches: stretches.map((stretch) => (stretch.id === id ? { ...stretch, note } : stretch)),
  }));

export const removeAgentStretch = (id: number) =>
  useAgentStretchStore.setState(({ stretches }) => ({
    stretches: stretches.filter((stretch) => stretch.id !== id),
  }));

export const clearAgentStretches = () =>
  useAgentStretchStore.setState({ stretches: [], lastAddedId: null, drawing: false });

const seconds = (value: number) => `${value.toFixed(2)} s`;

/** One request for the agent: the typed message, then each stretch with its note. */
export function agentStretchPrompt(message: string, stretches: readonly AgentStretch[]): string {
  if (stretches.length === 0) return message;
  const lines = stretches.map((stretch, index) => {
    const range = `${index + 1}. ${stretch.composition}, ${seconds(stretch.start)} to ${seconds(stretch.end)}`;
    const note = stretch.note.trim();
    return note ? `${range}: ${note}` : range;
  });
  return [
    message || "Change these stretches of the video as noted.",
    "",
    "Stretches of the timeline (composition file, then seconds from that composition's start):",
    ...lines,
  ].join("\n");
}
