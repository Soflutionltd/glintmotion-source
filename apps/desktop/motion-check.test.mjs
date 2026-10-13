import assert from "node:assert/strict";
import { test } from "node:test";
import {
  analyzeTween,
  centroidReversals,
  holdPattern,
  inkCentroid,
  sameFrame,
  toGray,
} from "./motion-check.mjs";

const WIDTH = 20;
const HEIGHT = 20;

/** A 4x4 dark block on a light crop, top-left corner at (x, y). */
function block(x, y) {
  const gray = new Uint8Array(WIDTH * HEIGHT).fill(240);
  for (let row = y; row < y + 4; row += 1)
    for (let col = x; col < x + 4; col += 1) gray[row * WIDTH + col] = 20;
  return gray;
}

function samplesAt(positions, fps = 30) {
  return positions.map((y, index) => {
    const gray = block(8, y);
    return { time: index / fps, gray, centroid: inkCentroid(gray, WIDTH) };
  });
}

const tween = {
  label: "#t",
  start: 0,
  end: 1,
  ease: "expo.out",
  props: ["y"],
  text: true,
  repeats: false,
};

test("toGray weights BGRA channels as luma", () => {
  const white = toGray(Uint8Array.from([255, 255, 255, 255]), 1, 1);
  const blue = toGray(Uint8Array.from([255, 0, 0, 255]), 1, 1);
  assert.equal(white[0], 255);
  assert.ok(blue[0] < 40);
});

test("sameFrame ignores bitmap noise but not a moved glyph", () => {
  const a = block(8, 4);
  const noisy = a.map((level) => Math.min(255, level + 2));
  assert.ok(sameFrame(a, noisy));
  assert.ok(!sameFrame(a, block(8, 5)));
});

test("inkCentroid finds the block against its background", () => {
  const centroid = inkCentroid(block(8, 4), WIDTH);
  assert.equal(centroid.x, 9.5);
  assert.equal(centroid.y, 5.5);
  assert.equal(inkCentroid(new Uint8Array(WIDTH * HEIGHT).fill(240), WIDTH), null);
});

test("holdPattern marks moved and repeated frames", () => {
  assert.equal(holdPattern(samplesAt([0, 1, 1, 2])), "m=m");
});

test("a mid-motion stop is a stall", () => {
  const issues = analyzeTween(tween, samplesAt([0, 2, 4, 4, 4, 4, 6, 8, 10, 12, 14, 16]), 30).map(
    (f) => f.issue,
  );
  assert.deepEqual(issues, ["stall"]);
});

test("settle, one more pixel, settle is a tail tick", () => {
  const [finding] = analyzeTween(tween, samplesAt([0, 4, 7, 9, 10, 11, 11, 12, 12, 12, 12]), 30);
  assert.equal(finding.issue, "tail_tick");
  assert.equal(finding.pattern, "mmmmm=m===");
});

test("a moderate ease that lands cleanly reports nothing", () => {
  assert.deepEqual(analyzeTween(tween, samplesAt([0, 2, 4, 6, 8, 9, 10, 11, 12, 13, 14]), 30), []);
});

test("a third of the tween without movement is an early finish", () => {
  const [finding] = analyzeTween(tween, samplesAt([0, 3, 6, 8, 10, 12, 12, 12, 12, 12, 12]), 30);
  assert.equal(finding.issue, "early_finish");
  assert.equal(finding.idleFrames, 5);
});

test("an element that leaves the crop is not idle", () => {
  const samples = samplesAt([0, 3, 6, 8, 10, 12, 12, 12, 12, 12, 12]);
  for (const sample of samples.slice(6))
    Object.assign(sample, { gray: new Uint8Array(WIDTH * HEIGHT).fill(240), centroid: null });
  assert.deepEqual(analyzeTween(tween, samples, 30), []);
});

test("text whose ink goes up and down while it moves judders", () => {
  const zigzag = [4, 5, 4, 6, 5, 7, 6, 8, 7, 9, 8, 10];
  assert.ok(centroidReversals(samplesAt(zigzag)) >= 8);
  assert.deepEqual(
    analyzeTween(tween, samplesAt(zigzag), 30).map((f) => f.issue),
    ["judder"],
  );
  assert.deepEqual(analyzeTween({ ...tween, textChanges: true }, samplesAt(zigzag), 30), []);
  assert.deepEqual(analyzeTween({ ...tween, text: false }, samplesAt(zigzag), 30), []);
});
