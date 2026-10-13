import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  compareVersions,
  createPersistentMap,
  entriesSince,
  readSeenVersion,
  takeResume,
  writeResume,
  writeSeenVersion,
} from "./session-state.mjs";

let dir;
let project;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gm-session-"));
  project = join(dir, "logo-reel");
  mkdirSync(project);
  writeFileSync(join(project, "index.html"), "<div data-composition-id='main'></div>");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("resume point", () => {
  it("gives back the project and studio hash once, then nothing", () => {
    const file = join(dir, "resume.json");
    const hash = "#project/logo-reel?v=1&comp=intro.html&t=3.2&selId=title";
    writeResume(file, { dir: project, hash, now: 1_000 });
    assert.deepEqual(takeResume(file, 2_000), { dir: project, hash });
    assert.equal(existsSync(file), false);
    assert.equal(takeResume(file, 2_000), null);
  });

  it("ignores a resume point older than a quarter of an hour", () => {
    const file = join(dir, "resume.json");
    writeResume(file, { dir: project, hash: "#project/logo-reel", now: 0 });
    assert.equal(takeResume(file, 16 * 60 * 1000), null);
  });

  it("ignores a project that is gone, and Home (no project) as the place to go back to", () => {
    const file = join(dir, "resume.json");
    writeResume(file, { dir: join(dir, "deleted"), hash: "", now: 0 });
    assert.equal(takeResume(file, 1), null);
    writeResume(file, { dir: null, hash: "", now: 0 });
    assert.equal(takeResume(file, 1), null);
  });

  it("drops a hash that is not a studio project route", () => {
    const file = join(dir, "resume.json");
    writeResume(file, { dir: project, hash: "#new", now: 0 });
    assert.deepEqual(takeResume(file, 1), { dir: project, hash: "" });
  });
});

describe("persistent map", () => {
  it("keeps its values for the next launch, and forgets deleted and cleared ones", () => {
    const file = join(dir, "sessions.json");
    const first = createPersistentMap(file);
    first.set("/a", "session-a");
    first.set("/b", "session-b");
    first.delete("/b");
    const second = createPersistentMap(file);
    assert.equal(second.get("/a"), "session-a");
    assert.equal(second.get("/b"), undefined);
    second.clear();
    assert.equal(createPersistentMap(file).get("/a"), undefined);
  });

  it("starts empty from a missing or unreadable file", () => {
    const file = join(dir, "sessions.json");
    writeFileSync(file, "{not json");
    assert.equal(createPersistentMap(file).get("/a"), undefined);
  });
});

describe("versions and notes", () => {
  it("orders versions by number, not as text", () => {
    assert.ok(compareVersions("0.10.0", "0.9.9") > 0);
    assert.ok(compareVersions("1.2.3", "1.2.3") === 0);
    assert.ok(compareVersions("1.2", "1.2.1") < 0);
  });

  it("keeps the notes after the last seen version up to the running one, newest first", () => {
    const entries = [{ version: "0.2.0" }, { version: "0.4.0" }, { version: "0.3.1" }, { version: "0.1.0" }];
    assert.deepEqual(
      entriesSince(entries, "0.2.0", "0.3.1").map((entry) => entry.version),
      ["0.3.1"],
    );
    assert.deepEqual(
      entriesSince(entries, null, "0.4.0").map((entry) => entry.version),
      ["0.4.0", "0.3.1", "0.2.0", "0.1.0"],
    );
    assert.deepEqual(entriesSince("oops", null, "1.0.0"), []);
  });

  it("remembers the version whose notes were seen", () => {
    const file = join(dir, "seen.json");
    assert.equal(readSeenVersion(file), null);
    writeSeenVersion(file, "0.2.0");
    assert.equal(readSeenVersion(file), "0.2.0");
  });
});
