import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname } from "node:path";
import { localhostHostValidation, NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { Server } from "@modelcontextprotocol/server";

export const MCP_PORT = 47821;
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

const text = (value) => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});
const failure = (message) => ({ content: [{ type: "text", text: message }], isError: true });

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
  {
    name: "glintmotion_render",
    description:
      "Export the open project to a video file with the Glintmotion engine and return the output path. Takes about as long as the video on a Mac.",
    inputSchema: {
      type: "object",
      properties: {
        format: { type: "string", enum: ["mp4", "webm", "mov", "gif"], default: "mp4" },
        from: { type: "number", description: "Start time in seconds (optional)." },
        to: { type: "number", description: "End time in seconds (optional)." },
      },
    },
  },
];

/**
 * @param {{
 *   token: string,
 *   window: () => import("electron").BrowserWindow | null,
 *   studioUrl: () => string | null,
 *   listProjects: () => unknown[],
 *   currentProject: () => unknown,
 *   openProject: (dir: string) => Promise<void>,
 *   render: (options: { format: string, from?: number, to?: number }) => Promise<string>,
 * }} app
 */
export function startMcpServer(app) {
  const studioPage = () => {
    const win = app.window();
    return win && app.studioUrl() ? win.webContents : null;
  };

  async function studioTools() {
    const page = studioPage();
    if (!page) return [];
    const tools = await page.executeJavaScript(`${STUDIO_TOOLS} ? ${STUDIO_TOOLS}.list() : []`);
    return tools.map((tool) => ({ ...tool, inputSchema: tool.inputSchema ?? { type: "object" } }));
  }

  async function frameImage(result) {
    const base = app.studioUrl();
    if (!base || typeof result?.url !== "string") return null;
    const response = await fetch(new URL(result.url, base));
    if (!response.ok) return null;
    const data = Buffer.from(await response.arrayBuffer()).toString("base64");
    return { type: "image", data, mimeType: response.headers.get("content-type") ?? "image/png" };
  }

  async function callStudioTool(name, args) {
    const page = studioPage();
    if (!page) return failure("No project is open in Glintmotion. Call glintmotion_open_project first.");
    const result = await page.executeJavaScript(
      `${STUDIO_TOOLS} ? ${STUDIO_TOOLS}.call(${JSON.stringify(name)}, ${JSON.stringify(args ?? {})}) : null`,
    );
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
      case "glintmotion_render":
        return text({ output: await app.render(args ?? {}) });
      default:
        return null;
    }
  }

  function buildServer() {
    const server = new Server(
      { name: "glintmotion", version: "0.1.0" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler("tools/list", async () => ({
      tools: [...APP_TOOLS, ...(await studioTools())],
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
