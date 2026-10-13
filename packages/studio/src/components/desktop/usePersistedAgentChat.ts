import { useEffect, useState } from "react";
import { useStudioShellContextOptional } from "../../contexts/StudioContext";

// Enough to scroll back through a long session; the agent's own memory is its session id.
const MAX_ITEMS = 300;

const storageKey = (projectId: string) => `glintmotion.agentChat.${projectId}`;

function parseChat<Item>(raw: string | null): { items: Item[]; draft: string } {
  const stored: { items?: unknown; draft?: unknown } = Object(JSON.parse(raw ?? "{}"));
  return {
    items: Array.isArray(stored.items) ? (stored.items as Item[]) : [],
    draft: typeof stored.draft === "string" ? stored.draft : "",
  };
}

function readChat<Item>(projectId: string | null): { items: Item[]; draft: string } {
  try {
    return parseChat<Item>(projectId ? localStorage.getItem(storageKey(projectId)) : null);
  } catch {
    return { items: [], draft: "" };
  }
}

/** The project open in the studio, or null outside one. */
export function useStudioProjectId(): string | null {
  return useStudioShellContextOptional()?.projectId ?? null;
}

/** One project's agent chat and unsent message, kept so an app restart reopens them as they were. */
export function usePersistedAgentChat<Item>(projectId: string | null) {
  const [initial] = useState(() => readChat<Item>(projectId));
  const [items, setItems] = useState<Item[]>(initial.items);
  const [draft, setDraft] = useState(initial.draft);

  useEffect(() => {
    if (!projectId) return;
    try {
      localStorage.setItem(
        storageKey(projectId),
        JSON.stringify({ items: items.slice(-MAX_ITEMS), draft }),
      );
    } catch {
      // Storage full or unavailable: the chat still works, it just won't outlive a restart.
    }
  }, [projectId, items, draft]);

  return { items, setItems, draft, setDraft };
}
