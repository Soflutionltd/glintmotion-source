import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { buildRangeDocuments, parseRenderRangeArgs, prepareRangeProject } from "./range.js";

const SOURCE = `<!doctype html><html><head><meta charset="utf-8">
<script src="https://cdn.example/gsap.js"></script><style>.a{color:red}</style></head>
<body><div id="root" data-composition-id="main" data-start="0" data-duration="40"
data-width="1080" data-height="1920" data-fps="24"><div class="a">hi</div></div>
<script>window.__timelines = { main: 1 };</script></body></html>`;

describe("parseRenderRangeArgs", () => {
  it("returns no range without flags", () => {
    expect(parseRenderRangeArgs(undefined, undefined)).toEqual({
      ok: true,
      value: undefined,
    });
  });

  it("parses seconds and m:ss", () => {
    expect(parseRenderRangeArgs("12.5", "1:05")).toEqual({
      ok: true,
      value: { from: 12.5, to: 65 },
    });
    expect(parseRenderRangeArgs(undefined, "3")).toEqual({
      ok: true,
      value: { from: 0, to: 3 },
    });
  });

  it("rejects bad values and inverted ranges", () => {
    expect(parseRenderRangeArgs("abc", undefined).ok).toBe(false);
    expect(parseRenderRangeArgs("5", "5").ok).toBe(false);
    expect(parseRenderRangeArgs("-1", undefined).ok).toBe(false);
  });
});

describe("buildRangeDocuments", () => {
  it("hosts the source as a nested composition starting at from", () => {
    const { index, source, duration } = buildRangeDocuments(SOURCE, {
      from: 14,
      to: 18,
    });
    expect(duration).toBe(4);
    expect(index).toContain('data-composition-src="compositions/__hf-range-source.html"');
    expect(index).toContain('data-playback-start="14"');
    expect(index).toContain('data-duration="4"');
    expect(index).toContain('data-fps="24"');
    expect(index).toContain("data-no-timeline");
    expect(source.startsWith("<template>")).toBe(true);
    expect(source).toContain("gsap.js");
    expect(source).toContain(".a{color:red}");
    expect(source).toContain("window.__timelines");
  });

  it("defaults to the end of the composition", () => {
    expect(buildRangeDocuments(SOURCE, { from: 30 }).duration).toBe(10);
  });

  it("rejects ranges outside the composition", () => {
    expect(() => buildRangeDocuments(SOURCE, { from: 40 })).toThrow(/past the end/);
    expect(() => buildRangeDocuments(SOURCE, { from: 1, to: 41 })).toThrow(/past the end/);
  });
});

describe("prepareRangeProject", () => {
  let projectDir: string;

  afterEach(() => rmSync(projectDir, { recursive: true, force: true }));

  it("links assets, keeps the project name, and cleans up", () => {
    projectDir = mkdtempSync(join(tmpdir(), "hf-range-test-"));
    writeFileSync(join(projectDir, "index.html"), SOURCE);
    mkdirSync(join(projectDir, "assets"));
    mkdirSync(join(projectDir, "compositions"));
    writeFileSync(join(projectDir, "compositions", "intro.html"), "<template></template>");

    const range = prepareRangeProject(projectDir, undefined, {
      from: 2,
      to: 6,
    });
    expect(basename(range.dir)).toBe(basename(projectDir));
    expect(lstatSync(join(range.dir, "assets")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(range.dir, "compositions", "intro.html")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(range.dir, "index.html")).isSymbolicLink()).toBe(false);
    expect(
      readFileSync(join(range.dir, "compositions", "__hf-range-source.html"), "utf-8"),
    ).toContain("<template>");

    range.cleanup();
    expect(existsSync(range.dir)).toBe(false);
    expect(readFileSync(join(projectDir, "index.html"), "utf-8")).toBe(SOURCE);
    expect(existsSync(join(projectDir, "compositions", "intro.html"))).toBe(true);
  });
});
