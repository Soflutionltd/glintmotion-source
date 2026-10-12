import { getDesktopHost } from "../utils/desktopHost";
import type { ModelContextTool } from "./types";

interface DesktopToolBridge {
  list: () => Array<Pick<ModelContextTool, "name" | "title" | "description" | "inputSchema">>;
  call: (name: string, input: object) => Promise<unknown>;
}

declare global {
  interface Window {
    /** Read by the Glintmotion Mac app, which relays these tools over its local MCP server. */
    __glintmotionStudioTools?: DesktopToolBridge;
  }
}

/** Publishes Studio's agent tools to the desktop host; a no-op in a plain browser. */
export function exposeToolsToDesktopHost(tools: ModelContextTool[], signal: AbortSignal): void {
  if (!getDesktopHost()) return;
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const bridge: DesktopToolBridge = {
    list: () =>
      tools.map(({ name, title, description, inputSchema }) => ({
        name,
        title,
        description,
        inputSchema,
      })),
    call: async (name, input) => {
      const tool = byName.get(name);
      if (!tool) return { ok: false, kind: "invalid", reason: `Unknown studio tool: ${name}` };
      return tool.execute(input, { signal: new AbortController().signal });
    },
  };
  window.__glintmotionStudioTools = bridge;
  signal.addEventListener("abort", () => {
    if (window.__glintmotionStudioTools === bridge) delete window.__glintmotionStudioTools;
  });
}
