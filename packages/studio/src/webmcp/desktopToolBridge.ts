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

/** Each mounted tool set, by source, so the timeline tools and the scene tools come and go independently. */
const sources = new Map<string, ModelContextTool[]>();

function publish(): void {
  const tools = [...sources.values()].flat();
  if (tools.length === 0) {
    delete window.__glintmotionStudioTools;
    return;
  }
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  window.__glintmotionStudioTools = {
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
}

/** Publishes Studio's agent tools to the desktop host; a no-op in a plain browser. */
export function exposeToolsToDesktopHost(
  tools: ModelContextTool[],
  signal: AbortSignal,
  source = "studio",
): void {
  if (!getDesktopHost()) return;
  sources.set(source, tools);
  publish();
  signal.addEventListener("abort", () => {
    if (sources.get(source) !== tools) return;
    sources.delete(source);
    publish();
  });
}
