import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  buildCube,
  matchTransform,
  oklabStats,
  oklabToRgb,
  predictStats,
  rgbToOklab,
  writeColorProbe,
} from "./color-match.mjs";

const work = mkdtempSync(join(tmpdir(), "gm-color-match-"));
after(() => rmSync(work, { recursive: true, force: true }));

/** rgb24 pixels from Oklab colors. */
function pixels(labs) {
  const buffer = Buffer.alloc(labs.length * 3);
  labs.forEach((lab, index) => {
    oklabToRgb(...lab).forEach(
      (value, channel) => (buffer[index * 3 + channel] = Math.round(value * 255)),
    );
  });
  return buffer;
}

const ramp = (cast) =>
  Array.from({ length: 4096 }, (_, index) => {
    const L = 0.2 + 0.7 * ((index % 64) / 63);
    const hue = (index >> 6) / 10;
    return [L, 0.03 * Math.cos(hue) + cast(L)[0], 0.03 * Math.sin(hue) + cast(L)[1]];
  });

const meanB = (stats, labs, low, high) => {
  const picked = labs.filter(([L]) => L >= low && L < high);
  return picked.reduce((sum, lab) => sum + lab[2], 0) / picked.length;
};

describe("color match", () => {
  it("round-trips sRGB through Oklab", () => {
    for (const rgb of [
      [0.2, 0.5, 0.8],
      [1, 1, 1],
      [0.9, 0.1, 0.3],
    ]) {
      const back = oklabToRgb(...rgbToOklab(...rgb));
      back.forEach((value, channel) => assert.ok(Math.abs(value - rgb[channel]) < 1e-6));
    }
  });

  it("brings a tinted source to the reference's means and spreads", () => {
    const reference = pixels(ramp(() => [0, 0]));
    const source = pixels(ramp(() => [0.02, -0.015]));
    const transform = matchTransform(oklabStats(source), oklabStats(reference));
    const predicted = predictStats(source, transform);
    const target = oklabStats(reference);
    predicted.mean.forEach((value, channel) =>
      assert.ok(Math.abs(value - target.mean[channel]) < 0.003),
    );
    predicted.std.forEach((value, channel) =>
      assert.ok(Math.abs(value - target.std[channel]) < 0.003),
    );
    assert.equal(transform.bounded, false);
  });

  it("moves a cast that changes with lightness", () => {
    const referenceLabs = ramp((L) => [0, 0.06 * (L - 0.55)]);
    const sourceLabs = ramp(() => [0, 0]);
    const transform = matchTransform(
      oklabStats(pixels(sourceLabs)),
      oklabStats(pixels(referenceLabs)),
    );
    const graded = sourceLabs.map(transform.apply);
    for (const [low, high] of [
      [0.2, 0.35],
      [0.75, 0.9],
    ]) {
      assert.ok(
        Math.abs(meanB(null, graded, low, high) - meanB(null, referenceLabs, low, high)) < 0.004,
      );
    }
  });

  it("bounds the gains and the shift of the mean color", () => {
    const flat = {
      mean: [0.5, 0, 0],
      std: [0.01, 0.001, 0.001],
      covariance: [
        [1e-4, 0, 0],
        [0, 1e-6, 0],
        [0, 0, 1e-6],
      ],
    };
    const wide = {
      mean: [0.5, 0.1, 0],
      std: [0.3, 0.1, 0.1],
      covariance: [
        [0.09, 0, 0],
        [0, 0.01, 0],
        [0, 0, 0.01],
      ],
    };
    const transform = matchTransform(flat, wide);
    assert.deepEqual(transform.gains, [1.6, 1.6, 1.6]);
    assert.equal(transform.bounded, true);
    assert.ok(Math.abs(transform.apply([0.5, 0, 0])[1] - 0.04) < 1e-9);

    const correction = matchTransform(flat, wide, { gainLimits: [0.85, 1.18], maxCastShift: 0.02 });
    assert.deepEqual(correction.gains, [1.18, 1.18, 1.18]);
    assert.ok(Math.abs(correction.apply([0.5, 0, 0])[1] - 0.02) < 1e-9);
  });

  it("writes a 33-point cube that leaves colors alone for an identity transform", () => {
    const cube = buildCube({ apply: (lab) => lab });
    const lines = cube.trim().split("\n");
    assert.equal(lines[1], "LUT_3D_SIZE 33");
    assert.equal(lines.length, 4 + 33 ** 3);
    assert.equal(lines[4], "0.000000 0.000000 0.000000");
    assert.equal(lines[5], "0.031250 0.000000 0.000000");
    assert.equal(lines.at(-1), "1.000000 1.000000 1.000000");
  });

  it("refuses a file with almost no lit pixels", () => {
    assert.throws(() => oklabStats(Buffer.alloc(300)), /Not enough lit pixels/);
  });

  it("writes a probe scene with the source to grade beside the reference", async () => {
    const dir = mkdtempSync(join(work, "probe-"));
    for (const name of ["a.png", "b.jpg"]) writeFileSync(join(work, name), "image");
    const probe = async (file) => ({
      streams: [{ width: 720, height: file.endsWith("a.png") ? 1280 : 720 }],
    });
    await writeColorProbe(dir, join(work, "a.png"), join(work, "b.jpg"), { probe });
    const html = readFileSync(join(dir, "index.html"), "utf8");
    assert.match(html, /data-no-timeline/);
    assert.match(html, /<img id="source" src="source\.png"[^>]*height:640px/);
    assert.match(html, /<img id="reference" src="reference\.jpg"[^>]*left:360px[^>]*height:360px/);
    assert.match(html, /data-width="720" data-height="640"/);
    assert.equal(readFileSync(join(dir, "reference.jpg"), "utf8"), "image");
  });
});
