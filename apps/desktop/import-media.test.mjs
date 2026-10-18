import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createAgentTools } from "./agent-tools.mjs";

let project;
beforeEach(() => (project = mkdtempSync(join(tmpdir(), "gm-import-"))));
afterEach(() => rmSync(project, { recursive: true, force: true }));

const toolsServing = (body, headers) =>
  createAgentTools({
    projectDir: () => project,
    projectInfo: () => null,
    runEngine: null,
    renders: null,
    fetch: async () => new Response(body, { status: 200, headers }),
  });

const reply = (result) => JSON.parse(result.content[0].text);

describe("glintmotion_import_media", () => {
  it("saves a generated clip under assets/generated without overwriting", async () => {
    const tools = toolsServing("mp4-bytes", { "Content-Type": "video/mp4" });
    const first = reply(
      await tools.call("glintmotion_import_media", {
        url: "https://cdn.example/out/abc.mp4",
        name: "shot 03",
      }),
    );
    const second = reply(
      await tools.call("glintmotion_import_media", {
        url: "https://cdn.example/out/abc.mp4",
        name: "shot 03",
      }),
    );
    assert.deepEqual(first, { path: "assets/generated/shot-03.mp4", bytes: 9 });
    assert.equal(second.path, "assets/generated/shot-03-2.mp4");
    assert.equal(readFileSync(join(project, first.path), "utf-8"), "mp4-bytes");
  });

  it("takes the extension from the URL when the type is generic", async () => {
    const tools = toolsServing("png", { "Content-Type": "application/octet-stream" });
    const result = reply(
      await tools.call("glintmotion_import_media", { url: "https://cdn.example/x/frame.PNG" }),
    );
    assert.equal(result.path, "assets/generated/frame.png");
  });

  it("refuses plain http and non-media files", async () => {
    const tools = toolsServing("<html>", { "Content-Type": "text/html" });
    assert.equal(
      (await tools.call("glintmotion_import_media", { url: "http://cdn.example/a.mp4" })).isError,
      true,
    );
    const html = await tools.call("glintmotion_import_media", { url: "https://cdn.example/page" });
    assert.equal(html.isError, true);
    assert.match(html.content[0].text, /not text\/html/);
  });
});
