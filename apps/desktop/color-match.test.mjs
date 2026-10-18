import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildCube,
  matchTransform,
  oklabStats,
  oklabToRgb,
  predictStats,
  rgbToOklab,
} from "./color-match.mjs";

function gradient(tint) {
  const pixels = Buffer.alloc(64 * 64 * 3);
  for (let index = 0; index < 64 * 64; index += 1) {
    const value = 40 + (index % 64) * 3;
    pixels[index * 3] = Math.min(255, value + tint[0]);
    pixels[index * 3 + 1] = Math.min(255, value + tint[1]);
    pixels[index * 3 + 2] = Math.min(255, value + tint[2]);
  }
  return pixels;
}

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
    const reference = gradient([0, 0, 0]);
    const source = gradient([30, 10, -20]);
    const transform = matchTransform(oklabStats(source), oklabStats(reference));
    const predicted = predictStats(source, transform);
    const target = oklabStats(reference);
    predicted.mean.forEach((value, channel) =>
      assert.ok(Math.abs(value - target.mean[channel]) < 0.01),
    );
  });

  it("bounds the spread ratios", () => {
    const flat = { mean: [0.5, 0, 0], std: [0.01, 0.001, 0.001] };
    const wide = { mean: [0.5, 0, 0], std: [0.3, 0.1, 0.1] };
    assert.deepEqual(matchTransform(flat, wide).ratios, [1.4, 2, 2]);
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
});
