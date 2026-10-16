import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { probeMedia, runFfmpeg } from "./media.mjs";
import {
  findVideo,
  fitArgs,
  fitVideoIntoScene,
  languageCommands,
  localeDefaults,
  parseDefaultsArray,
  retargetVideo,
  setVariableDefault,
  targetSize,
} from "./takes.mjs";

const SCENE = `<!DOCTYPE html>
<html data-composition-variables="[
    {&quot;id&quot;:&quot;lang&quot;,&quot;type&quot;:&quot;enum&quot;,&quot;default&quot;:&quot;fr&quot;},
    {&quot;id&quot;:&quot;recGrid&quot;,&quot;type&quot;:&quot;string&quot;,&quot;label&quot;:&quot;Feed&quot;,&quot;default&quot;:&quot;assets/rec/fr/grid.mp4&quot;}
  ]">
<body>
  <video data-hf-id="v-grid" id="v-other" src="assets/other.mp4" data-start="0" data-duration="2"></video>
  <video data-hf-id="hf-3quf" id="v-grid" src="assets/rec/fr/grid.mp4" data-var-src="recGrid" muted data-start="3.2" data-duration="1.5" data-media-start="0.4"></video>
</body>
</html>`;

describe("findVideo", () => {
  it("matches the id attribute, not data-hf-id", () => {
    const video = findVideo(SCENE, "v-grid");
    assert.equal(video.src, "assets/rec/fr/grid.mp4");
    assert.equal(video.variable, "recGrid");
    assert.equal(video.duration, 1.5);
  });

  it("returns null for an unknown id", () => {
    assert.equal(findVideo(SCENE, "v-none"), null);
  });
});

describe("retargetVideo", () => {
  it("rewrites src, the variable default and drops the old offset", () => {
    const { html, variableUpdated, clearedOffset } = retargetVideo(SCENE, "v-grid", "assets/rec/fr/switch.mp4");
    const video = findVideo(html, "v-grid");
    assert.equal(video.src, "assets/rec/fr/switch.mp4");
    assert.equal(variableUpdated, true);
    assert.deepEqual(clearedOffset, ["data-media-start"]);
    assert.ok(!video.tag.includes("data-media-start"));
    assert.ok(html.includes("&quot;default&quot;:&quot;assets/rec/fr/switch.mp4&quot;}"));
    assert.ok(html.includes("&quot;default&quot;:&quot;fr&quot;}"), "other variables keep their default");
    assert.equal(findVideo(html, "v-other").src, "assets/other.mp4");
  });

  it("throws when the video is missing", () => {
    assert.throws(() => retargetVideo(SCENE, "v-none", "a.mp4"), /No <video id="v-none">/);
  });
});

describe("setVariableDefault", () => {
  it("handles raw JSON in single quotes", () => {
    const html = `<html data-composition-variables='[{"id": "clip", "type": "string", "default": "a.mp4"}, {"id": "b", "default": "x"}]'>`;
    const next = setVariableDefault(html, "clip", "takes/b.mp4");
    assert.equal(next, `<html data-composition-variables='[{"id": "clip", "type": "string", "default": "takes/b.mp4"}, {"id": "b", "default": "x"}]'>`);
  });

  it("returns null for an undeclared variable", () => {
    assert.equal(setVariableDefault(SCENE, "recNone", "a.mp4"), null);
  });
});

describe("targetSize", () => {
  it("keeps the previous take's size when the framing matches", () => {
    assert.deepEqual(targetSize({ width: 1320, height: 2868 }, { width: 900, height: 1956 }), { width: 900, height: 1956 });
  });

  it("keeps the previous width and the take's framing otherwise", () => {
    assert.deepEqual(targetSize({ width: 1920, height: 1080 }, { width: 900, height: 1956 }), { width: 900, height: 506 });
  });

  it("caps a take without predecessor to 2160 on its long side", () => {
    assert.deepEqual(targetSize({ width: 1320, height: 2868 }, null), { width: 994, height: 2160 });
  });
});

describe("fitArgs", () => {
  it("holds the last frame and cuts at the scene length", () => {
    const args = fitArgs({ source: "in.mp4", output: "out.mp4", width: 900, height: 1956, fps: 30, seconds: 5.4, from: 0.5 });
    assert.deepEqual(args.slice(0, 5), ["-y", "-ss", "0.5", "-i", "in.mp4"]);
    assert.match(args[args.indexOf("-vf") + 1], /^fps=30,scale=900:1956:.*tpad=stop_mode=clone:stop_duration=5.4$/);
    assert.equal(args[args.indexOf("-t") + 1], "5.4");
    assert.equal(args[args.indexOf("-g") + 1], "30");
  });
});

describe("simulator language", () => {
  it("parses the array defaults prints", () => {
    assert.deepEqual(parseDefaultsArray('(\n    "fr-FR",\n    "en-US"\n)\n'), ["fr-FR", "en-US"]);
    assert.deepEqual(parseDefaultsArray("(\n    en\n)"), ["en"]);
  });

  it("derives the language and the region format from one locale", () => {
    assert.deepEqual(localeDefaults("en-US"), { languages: ["en-US"], appleLocale: "en_US" });
    assert.deepEqual(localeDefaults("fr_FR"), { languages: ["fr-FR"], appleLocale: "fr_FR" });
    assert.throws(() => localeDefaults("en US; rm"), /locale looks like/);
  });

  it("deletes a key the simulator did not have", () => {
    const [languages, locale] = languageCommands("U", { languages: ["fr-FR", "en-US"], appleLocale: null });
    assert.deepEqual(languages, ["spawn", "U", "defaults", "write", "-g", "AppleLanguages", "-array", "fr-FR", "en-US"]);
    assert.deepEqual(locale, ["spawn", "U", "defaults", "delete", "-g", "AppleLocale"]);
  });
});

describe("fitVideoIntoScene", () => {
  let dir;
  const make = (file, size, seconds) =>
    runFfmpeg(["-y", "-f", "lavfi", "-i", `testsrc=size=${size}:rate=60`, "-t", String(seconds), "-pix_fmt", "yuv420p", file]);
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "takes-test-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("saves a variant at output without touching the composition", async () => {
    mkdirSync(join(dir, "assets/rec/fr"), { recursive: true });
    assert.equal((await make(join(dir, "assets/rec/fr/grid.mp4"), "100x200", 1)).code, 0);
    assert.equal((await make(join(dir, "raw.mov"), "220x440", 2)).code, 0);
    writeFileSync(join(dir, "index.html"), SCENE);

    const result = await fitVideoIntoScene({
      projectDir: dir,
      source: "raw.mov",
      video: "v-grid",
      output: "assets/rec/en/grid.mp4",
      rewire: false,
    });

    assert.equal(result.rewired, false);
    assert.deepEqual(result.renderVariables, { recGrid: "assets/rec/en/grid.mp4" });
    assert.equal(result.cutSeconds, 0.5);
    assert.equal(readFileSync(join(dir, "index.html"), "utf-8"), SCENE);
    const stream = (await probeMedia(join(dir, "assets/rec/en/grid.mp4"))).streams.find((candidate) => candidate.codec_type === "video");
    assert.deepEqual([stream.width, stream.height], [100, 200]);
  });

  it("refuses an output outside the project or not in .mp4", async () => {
    assert.equal((await make(join(dir, "raw.mov"), "100x200", 0.2)).code, 0);
    writeFileSync(join(dir, "index.html"), SCENE);
    const fit = (output) => fitVideoIntoScene({ projectDir: dir, source: "raw.mov", video: "v-grid", output });
    await assert.rejects(fit("../outside.mp4"), /inside the project/);
    await assert.rejects(fit("assets/rec/en/grid.mov"), /\.mp4/);
  });

  it("encodes a short take to the scene length and wires it in", async () => {
    mkdirSync(join(dir, "assets/rec/fr"), { recursive: true });
    assert.equal((await make(join(dir, "assets/rec/fr/grid.mp4"), "100x200", 1)).code, 0);
    assert.equal((await make(join(dir, "raw.mov"), "220x440", 0.6)).code, 0);
    writeFileSync(join(dir, "index.html"), SCENE);

    const result = await fitVideoIntoScene({ projectDir: dir, source: join(dir, "raw.mov"), video: "v-grid", name: "switch" });

    assert.equal(result.src, "assets/rec/fr/switch.mp4");
    assert.equal(result.heldLastFrameSeconds, 0.9);
    const probe = await probeMedia(join(dir, "assets/rec/fr/switch.mp4"));
    const stream = probe.streams.find((candidate) => candidate.codec_type === "video");
    assert.equal(stream.codec_name, "h264");
    assert.deepEqual([stream.width, stream.height], [100, 200]);
    assert.equal(stream.avg_frame_rate, "30/1");
    assert.ok(Math.abs(Number(probe.format.duration) - 1.5) < 0.05, `duration ${probe.format.duration}`);
    const keyframes = execFileSync("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "v",
      "-skip_frame",
      "nokey",
      "-show_entries",
      "frame=pts_time",
      "-of",
      "csv=p=0",
      join(dir, "assets/rec/fr/switch.mp4"),
    ], { encoding: "utf-8" });
    assert.deepEqual(keyframes.trim().split("\n").map(Number.parseFloat), [0, 1], "a keyframe every second");
    assert.equal(findVideo(readFileSync(join(dir, "index.html"), "utf-8"), "v-grid").src, "assets/rec/fr/switch.mp4");
  });
});
