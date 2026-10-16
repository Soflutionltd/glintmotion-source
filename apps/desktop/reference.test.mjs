import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { probeMedia, runFfmpeg } from "./media.mjs";
import {
  analyzeReference,
  compositionHtml,
  cutsOnBeat,
  detectCuts,
  parseSceneScores,
  readShots,
  referencePrompt,
  resolutionFor,
  retimeShots,
  scaleShots,
  shotsFromCuts,
  snapCuts,
  writeReferenceProject,
} from "./reference.mjs";

/** 30 fps of near-still frames with hard cuts at the given frame indexes. */
function frames(count, cuts, { still = 0.003, cut = 0.4 } = {}) {
  return Array.from({ length: count }, (_, i) => ({
    time: i / 30,
    score: cuts.includes(i) ? cut : still,
  }));
}

describe("parseSceneScores", () => {
  it("pairs each frame's time with its score", () => {
    const stderr = [
      "[Parsed_metadata_2 @ 0x1] frame:0    pts:0       pts_time:0",
      "[Parsed_metadata_2 @ 0x1] lavfi.scene_score=0.000000",
      "[Parsed_metadata_2 @ 0x1] frame:1    pts:512     pts_time:0.0333",
      "[Parsed_metadata_2 @ 0x1] lavfi.scene_score=0.412000",
    ].join("\n");
    assert.deepEqual(parseSceneScores(stderr), [
      { time: 0, score: 0 },
      { time: 0.0333, score: 0.412 },
    ]);
  });
});

describe("detectCuts", () => {
  it("finds hard cuts that stand out from a still screen recording", () => {
    assert.deepEqual(detectCuts(frames(150, [30, 75, 120], { cut: 0.15 })), [30, 75, 120]);
  });

  it("ignores steady motion with no cut", () => {
    assert.deepEqual(detectCuts(frames(90, [], { still: 0.06 })), []);
  });

  it("keeps one cut for a flash shorter than the shortest shot", () => {
    const cuts = detectCuts(
      frames(90, [30, 32]).map((frame, i) => (i === 32 ? { ...frame, score: 0.6 } : frame)),
    );
    assert.deepEqual(cuts, [32]);
  });

  it("rejects an unknown sensitivity", () => {
    assert.throws(() => detectCuts(frames(10, []), { sensitivity: "max" }), /sensitivity/);
  });
});

describe("shots", () => {
  const all = frames(90, [30, 60]);
  const shots = shotsFromCuts(all, [30, 60], 3);

  it("cuts the timeline at each detected frame", () => {
    assert.deepEqual(
      shots.map(({ id, start, duration, motion }) => ({ id, start, duration, motion })),
      [
        { id: "shot-01", start: 0, duration: 1, motion: "still" },
        { id: "shot-02", start: 1, duration: 1, motion: "still" },
        { id: "shot-03", start: 2, duration: 1, motion: "still" },
      ],
    );
  });

  it("scales every cut in proportion to a new length", () => {
    assert.deepEqual(
      scaleShots(shots, 3, 6).map(({ start, duration }) => [start, duration]),
      [
        [0, 2],
        [2, 2],
        [4, 2],
      ],
    );
  });

  it("measures how many cuts land on a beat", () => {
    assert.equal(cutsOnBeat(shots, [1.02, 2.5]), 0.5);
    assert.equal(cutsOnBeat(shots, []), null);
  });
});

describe("snapCuts", () => {
  const shots = [
    { id: "shot-01", start: 0, duration: 1 },
    { id: "shot-02", start: 1, duration: 1 },
    { id: "shot-03", start: 2, duration: 1 },
  ];

  it("moves cuts onto nearby beats and keeps both ends", () => {
    const { shots: snapped, moved } = snapCuts(shots, [0.5, 1.1, 2.4], 0.15);
    assert.deepEqual(moved, [{ cut: 1, from: 1, to: 1.1 }]);
    assert.deepEqual(
      snapped.map(({ start, duration }) => [start, duration]),
      [
        [0, 1.1],
        [1.1, 0.9],
        [2, 1],
      ],
    );
  });

  it("leaves a cut alone when the beat would make a shot too short", () => {
    const tight = [
      { id: "shot-01", start: 0, duration: 1 },
      { id: "shot-02", start: 1, duration: 0.25 },
      { id: "shot-03", start: 1.25, duration: 1 },
    ];
    assert.deepEqual(snapCuts(tight, [1.12], 0.15).moved, []);
  });
});

describe("composition", () => {
  const shots = [
    { id: "shot-01", start: 0, duration: 1.5 },
    { id: "shot-02", start: 1.5, duration: 2 },
  ];
  const html = compositionHtml({
    resolution: "post",
    shots,
    duration: 3.5,
    title: "Remake <test>",
  });

  it("lays one video per shot on one track, at the format's size", () => {
    assert.match(html, /data-width="1080"\s+data-height="1350"/);
    assert.doesNotMatch(html, /data-resolution=/);
    assert.match(html, /<title>Remake test<\/title>/);
    assert.deepEqual(readShots(html), shots);
  });

  it("retimes the shots without touching other attributes", () => {
    const next = retimeShots(
      html.replace('id="shot-02" class="shot"', 'id="shot-02" class="shot" data-media-start="0.4"'),
      [
        { id: "shot-01", start: 0, duration: 1.4 },
        { id: "shot-02", start: 1.4, duration: 2.1 },
      ],
    );
    assert.match(
      next,
      /id="shot-02" class="shot" data-media-start="0.4" src="assets\/shots\/shot-02.mp4"/,
    );
    assert.deepEqual(readShots(next), [
      { id: "shot-01", start: 0, duration: 1.4 },
      { id: "shot-02", start: 1.4, duration: 2.1 },
    ]);
  });

  it("tells the agent the shots to fill and the tempo to match", () => {
    const prompt = referencePrompt({
      source: "ad.mp4",
      analysis: { bpm: 120 },
      built: { shots, durationSeconds: 3.5 },
    });
    assert.match(prompt, /« ad\.mp4 » : 2 plans sur 3\.5 s, musique à 120 bpm/);
    assert.match(prompt, /shot-01 à shot-02/);
    assert.match(prompt, /glintmotion_generate_music pour 3\.5 s à environ 120 bpm/);
    assert.doesNotMatch(
      referencePrompt({
        source: "a.mp4",
        analysis: { bpm: null },
        built: { shots, durationSeconds: 3.5 },
      }),
      /bpm/,
    );
  });

  it("picks the format closest to the reference", () => {
    assert.equal(resolutionFor(1080, 1920), "portrait");
    assert.equal(resolutionFor(1080, 1350), "post");
    assert.equal(resolutionFor(1080, 1080), "square");
    assert.equal(resolutionFor(1920, 1080), "landscape");
  });
});

describe("analyzeReference and writeReferenceProject", () => {
  let work;
  let reference;

  before(async () => {
    work = mkdtempSync(join(tmpdir(), "glintmotion-reference-test-"));
    reference = join(work, "reference.mp4");
    const segment = (color) => `color=c=${color}:s=320x568:r=30:d=1`;
    const { code, stderr } = await runFfmpeg([
      "-y",
      "-f",
      "lavfi",
      "-i",
      segment("red"),
      "-f",
      "lavfi",
      "-i",
      segment("blue"),
      "-f",
      "lavfi",
      "-i",
      segment("green"),
      "-filter_complex",
      "[0:v][1:v][2:v]concat=n=3:v=1:a=0",
      "-c:v",
      "h264_videotoolbox",
      "-q:v",
      "60",
      "-pix_fmt",
      "yuv420p",
      reference,
    ]);
    assert.equal(code, 0, stderr.slice(-400));
  });

  after(() => rmSync(work, { recursive: true, force: true }));

  it("finds the three shots, their colours, and lays them out in a project", async () => {
    const sheet = join(work, "shots.jpg");
    const analysis = await analyzeReference({
      file: reference,
      sheet,
      runBeats: async () => assert.fail("a reference without sound has no beats to look for"),
    });
    assert.equal(analysis.resolution, "portrait");
    assert.equal(analysis.shotCount, 3);
    assert.deepEqual(
      analysis.shots.map((shot) => Math.round(shot.start)),
      [0, 1, 2],
    );
    const [red, blue, green] = analysis.shots.map((shot) => shot.color);
    assert.ok(parseInt(red.slice(1, 3), 16) > 200, red);
    assert.ok(parseInt(blue.slice(5, 7), 16) > 200, blue);
    assert.ok(parseInt(green.slice(3, 5), 16) > 100, green);
    assert.equal(analysis.bpm, null);
    assert.ok(existsSync(sheet));

    const dir = join(work, "project");
    const built = await writeReferenceProject({
      dir,
      analysis,
      resolution: "portrait",
      duration: 6,
      title: "Test",
    });
    assert.equal(built.durationSeconds, 6);
    const html = readFileSync(join(dir, "index.html"), "utf-8");
    assert.equal(readShots(html).length, 3);
    const placeholder = await probeMedia(join(dir, "assets", "shots", "shot-02.mp4"));
    assert.equal(placeholder.streams[0].width, 1080);
    assert.equal(placeholder.streams[0].height, 1920);
    assert.ok(Math.abs(Number(placeholder.format.duration) - 2) < 0.1);
    const saved = JSON.parse(readFileSync(join(dir, "reference", "analysis.json"), "utf-8"));
    assert.equal(saved.builtDurationSeconds, 6);
  });
});
