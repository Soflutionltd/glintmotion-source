import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { EFFECTS_REGISTRY, addEffectArgs, loadEffectsCatalog, searchEffects } from "./effects.mjs";

const ITEMS = [
  { name: "gl-cube", title: "Cube transition", description: "A rotating 3D cube.", tags: ["transition", "3d", "cube"] },
  { name: "gl-wind", title: "Wind transition", description: "Streaks blow the image away.", tags: ["transition", "wipe"] },
  { name: "gl-page-curl", title: "Page curl transition", description: "A page turns like paper.", tags: ["transition", "3d"] },
  { name: "hyper-shader", title: "HyperShader runtime", description: "The runtime.", tags: ["runtime"] },
];

const dir = mkdtempSync(join(tmpdir(), "effects-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const answer = (body, status = 200) => async () => new Response(JSON.stringify(body), { status });
const failing = async () => {
  throw new Error("offline");
};

describe("searchEffects", () => {
  it("needs every word and ranks name over title over the rest", () => {
    const found = searchEffects(ITEMS, { query: "3d" });
    assert.deepEqual(
      found.items.map((i) => i.name),
      ["gl-cube", "gl-page-curl"],
    );
    assert.deepEqual(
      searchEffects(ITEMS, { query: "page curl" }).items.map((i) => i.name),
      ["gl-page-curl"],
    );
    assert.equal(searchEffects(ITEMS, { query: "cube wipe" }).total, 0);
  });

  it("filters by tag and caps the list while counting everything", () => {
    const found = searchEffects(ITEMS, { tag: "transition", limit: 2 });
    assert.equal(found.total, 3);
    assert.equal(found.items.length, 2);
  });
});

describe("loadEffectsCatalog", () => {
  it("fetches once, then serves the cache while it is fresh", async () => {
    const cacheFile = join(dir, "fresh.json");
    let calls = 0;
    const fetchImpl = async (url) => {
      calls += 1;
      assert.equal(url, `${EFFECTS_REGISTRY}/catalog.json`);
      return new Response(JSON.stringify({ items: ITEMS }));
    };
    assert.equal((await loadEffectsCatalog({ cacheFile, fetchImpl })).source, "network");
    const again = await loadEffectsCatalog({ cacheFile, fetchImpl });
    assert.equal(again.source, "cache");
    assert.equal(again.items.length, ITEMS.length);
    assert.equal(calls, 1);
  });

  it("falls back to a stale cache when the network fails", async () => {
    const cacheFile = join(dir, "stale.json");
    writeFileSync(cacheFile, JSON.stringify({ items: ITEMS }));
    const old = new Date(Date.now() - 48 * 3_600_000);
    utimesSync(cacheFile, old, old);
    const catalog = await loadEffectsCatalog({ cacheFile, fetchImpl: failing });
    assert.equal(catalog.source, "offline cache");
    assert.match(catalog.warning, /offline/);
  });

  it("says so when there is neither network nor cache", async () => {
    await assert.rejects(
      loadEffectsCatalog({ cacheFile: join(dir, "none.json"), fetchImpl: failing }),
      /unreachable and not cached/,
    );
    await assert.rejects(loadEffectsCatalog({ cacheFile: join(dir, "bad.json"), fetchImpl: answer({}, 500) }), /500/);
  });
});

describe("addEffectArgs", () => {
  it("installs from the effects catalog without touching the project's own", () => {
    assert.deepEqual(addEffectArgs("gl-cube"), [
      "add",
      "gl-cube",
      "--registry",
      EFFECTS_REGISTRY,
      "--json",
      "--no-clipboard",
    ]);
  });

  it("refuses anything but an item name", () => {
    assert.throws(() => addEffectArgs("../x"), /effect name/);
    assert.throws(() => addEffectArgs("--force"), /effect name/);
  });
});
