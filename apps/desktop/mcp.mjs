import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname } from "node:path";
import { localhostHostValidation, NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { Server } from "@modelcontextprotocol/server";
import { AGENT_TOOLS, createAgentTools, failure, MCP_INSTRUCTIONS, text } from "./agent-tools.mjs";

export const MCP_PORT = Number(process.env.GLINTMOTION_MCP_PORT) || 47821;
const MCP_PATH = "/mcp";
const STUDIO_TOOLS = "window.__glintmotionStudioTools";

export function loadMcpToken(file) {
  if (existsSync(file)) {
    const saved = readFileSync(file, "utf-8").trim();
    if (saved.length >= 32) return saved;
  }
  const token = randomBytes(32).toString("hex");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, token, { mode: 0o600 });
  return token;
}

function authorized(header, token) {
  const expected = Buffer.from(`Bearer ${token}`);
  const given = Buffer.from(String(header ?? ""));
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const APP_TOOLS = [
  {
    name: "glintmotion_list_projects",
    description: "List the recent Glintmotion projects with their folder, size and duration.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "glintmotion_current_project",
    description:
      "The project open in the Glintmotion studio right now (folder, size, duration), or null. The studio_* tools act on it.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "glintmotion_open_project",
    description: "Open a project folder (it must contain index.html) in the Glintmotion studio.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Absolute path of the project folder." } },
      required: ["path"],
    },
  },
  {
    name: "glintmotion_screenshot",
    description: "A PNG screenshot of the Glintmotion window as the user sees it.",
    inputSchema: { type: "object", properties: {} },
  },
];

function readToolCache(file) {
  try {
    const tools = JSON.parse(readFileSync(file, "utf-8"));
    return Array.isArray(tools) ? tools : [];
  } catch {
    return [];
  }
}

/**
 * @param {{
 *   token: string,
 *   toolCacheFile: string,
 *   window: () => import("electron").BrowserWindow | null,
 *   studioUrl: () => string | null,
 *   listProjects: () => unknown[],
 *   currentProject: () => unknown,
 *   openProject: (dir: string) => Promise<void>,
 *   agent: Omit<Parameters<typeof createAgentTools>[0], "studioCall" | "studioUrl" | "openProject">,
 * }} app
 */
export function startMcpServer(app) {
  const studioPage = () => {
    const win = app.window();
    return win && app.studioUrl() ? win.webContents : null;
  };

  // Clients read tools/list once, often before a project is open: the last studio list is
  // served from disk so the studio_* tools exist from the start and fail clearly until one opens.
  let cachedStudioTools = readToolCache(app.toolCacheFile);

  async function studioTools() {
    const page = studioPage();
    const live = page ? await page.executeJavaScript(`${STUDIO_TOOLS} ? ${STUDIO_TOOLS}.list() : []`) : [];
    if (live.length) {
      const tools = live.map((tool) => ({ ...tool, inputSchema: tool.inputSchema ?? { type: "object" } }));
      if (JSON.stringify(tools) !== JSON.stringify(cachedStudioTools)) {
        cachedStudioTools = tools;
        mkdirSync(dirname(app.toolCacheFile), { recursive: true });
        writeFileSync(app.toolCacheFile, JSON.stringify(tools));
      }
    }
    return cachedStudioTools;
  }

  /** The studio tool's own result object, or null while the studio page is still loading. */
  async function studioCall(name, args) {
    const page = studioPage();
    if (!page) throw new Error("No project is open in Glintmotion. Call glintmotion_open_project first.");
    return page.executeJavaScript(
      `${STUDIO_TOOLS} ? ${STUDIO_TOOLS}.call(${JSON.stringify(name)}, ${JSON.stringify(args ?? {})}) : null`,
    );
  }

  const agentTools = createAgentTools({
    ...app.agent,
    studioCall,
    studioUrl: app.studioUrl,
    openProject: app.openProject,
  });

  async function frameImage(result) {
    const base = app.studioUrl();
    if (!base || typeof result?.url !== "string") return null;
    const response = await fetch(new URL(result.url, base));
    if (!response.ok) return null;
    const data = Buffer.from(await response.arrayBuffer()).toString("base64");
    return { type: "image", data, mimeType: response.headers.get("content-type") ?? "image/png" };
  }

  async function callStudioTool(name, args) {
    const result = await studioCall(name, args);
    if (result == null) return failure("The studio is still loading. Try again in a moment.");
    const reply = text(result);
    if (name === "studio_frame" && result.ok) {
      const image = await frameImage(result);
      if (image) reply.content.push(image);
    }
    return result.ok === false ? { ...reply, isError: true } : reply;
  }

  async function callAppTool(name, args) {
    switch (name) {
      case "glintmotion_list_projects":
        return text(app.listProjects());
      case "glintmotion_current_project":
        return text(app.currentProject());
      case "glintmotion_open_project": {
        if (typeof args?.path !== "string") return failure("path is required.");
        await app.openProject(args.path);
        return text(app.currentProject());
      }
      case "glintmotion_screenshot": {
        const win = app.window();
        if (!win) return failure("The Glintmotion window is closed.");
        const image = await win.webContents.capturePage();
        return { content: [{ type: "image", data: image.toPNG().toString("base64"), mimeType: "image/png" }] };
      }
      default:
        return agentTools.call(name, args);
    }
  }

  function buildServer() {
    const server = new Server(
      { name: "glintmotion", version: "0.2.0" },
      { capabilities: { tools: {} }, instructions: MCP_INSTRUCTIONS },
    );
    server.setRequestHandler("tools/list", async () => ({
      tools: [...APP_TOOLS, ...AGENT_TOOLS, ...(await studioTools())],
    }));
    server.setRequestHandler("tools/call", async (request) => {
      const { name, arguments: args } = request.params;
      try {
        if (name.startsWith("studio_")) return await callStudioTool(name, args);
        return (await callAppTool(name, args)) ?? failure(`Unknown tool: ${name}`);
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
      }
    });
    return server;
  }

  const validateHost = localhostHostValidation();
  const http = createServer(async (req, res) => {
    if (!validateHost(req, res)) return;
    if (!req.url?.startsWith(MCP_PATH)) {
      res.writeHead(404).end();
      return;
    }
    if (!authorized(req.headers.authorization, app.token)) {
      res.writeHead(401, { "content-type": "application/json" }).end('{"error":"unauthorized"}');
      return;
    }
    const server = buildServer();
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });
  http.listen(MCP_PORT, "127.0.0.1");
  return { url: `http://127.0.0.1:${MCP_PORT}${MCP_PATH}`, close: () => http.close(), http };
}
