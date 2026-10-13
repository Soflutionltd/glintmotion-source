import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { createUpdater, FEED_URL, IDLE_BEFORE_RESTART_S } from "./updater.mjs";

class FakeUpdater extends EventEmitter {
  feed = null;
  checks = 0;
  installs = 0;
  setFeedURL(options) {
    this.feed = options;
  }
  checkForUpdates() {
    this.checks++;
  }
  quitAndInstall() {
    this.installs++;
  }
}

let fake;
let world;
let states;
const make = (enabled = true) =>
  createUpdater({
    updater: fake,
    enabled,
    isBusy: () => world.busy,
    idleSeconds: () => world.idle,
    prepareRestart: async (version) => world.prepared.push(version),
    onState: (state) => states.push(state.status),
  });

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  fake = new FakeUpdater();
  world = { busy: false, idle: 0, prepared: [] };
  states = [];
});
afterEach(() => mock.timers.reset());

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("updater", () => {
  it("does nothing outside the packaged app", () => {
    const updater = make(false);
    updater.start();
    mock.timers.tick(24 * 60 * 60 * 1000);
    assert.equal(fake.feed, null);
    assert.equal(fake.checks, 0);
    assert.equal(updater.state().status, "off");
  });

  it("reads the JSON feed, checks soon after launch and then every four hours", () => {
    make().start();
    assert.deepEqual(fake.feed, { url: FEED_URL, serverType: "json" });
    mock.timers.tick(15_000);
    assert.equal(fake.checks, 1);
    fake.emit("update-not-available");
    mock.timers.tick(4 * 60 * 60 * 1000);
    assert.equal(fake.checks, 2);
  });

  it("waits while the app is busy or the person is active, then saves the place and restarts", async () => {
    const updater = make();
    updater.start();
    fake.emit("update-available");
    fake.emit("update-downloaded", {}, "", "0.3.0");
    assert.deepEqual(updater.state(), { status: "ready", version: "0.3.0", error: null });

    world.busy = true;
    world.idle = IDLE_BEFORE_RESTART_S + 1;
    mock.timers.tick(60_000);
    await flush();
    assert.equal(fake.installs, 0);

    world.busy = false;
    world.idle = IDLE_BEFORE_RESTART_S - 1;
    mock.timers.tick(60_000);
    await flush();
    assert.equal(fake.installs, 0);

    world.idle = IDLE_BEFORE_RESTART_S;
    mock.timers.tick(10_000);
    await flush();
    assert.deepEqual(world.prepared, ["0.3.0"]);
    assert.equal(fake.installs, 1);
  });

  it("restarts at once on request, but never without an update or in the middle of work", async () => {
    const updater = make();
    updater.start();
    await updater.requestRestart();
    assert.equal(fake.installs, 0);
    fake.emit("update-downloaded", {}, "", "0.3.0");
    world.busy = true;
    await updater.requestRestart();
    assert.equal(fake.installs, 0);
    assert.match(updater.state().error, /travail est en cours/);
    world.busy = false;
    await updater.requestRestart();
    assert.equal(fake.installs, 1);
  });

  it("says a download failed, but stays quiet about a check that could not reach the server", () => {
    const updater = make();
    updater.start();
    fake.emit("checking-for-update");
    fake.emit("error", new Error("offline"));
    assert.equal(updater.state().status, "idle");
    fake.emit("update-available");
    fake.emit("error", new Error("connection reset"));
    assert.deepEqual(updater.state(), { status: "failed", version: null, error: "connection reset" });
    assert.deepEqual(states, ["checking", "idle", "downloading", "failed"]);
  });

  it("keeps a downloaded update when a later check fails", () => {
    const updater = make();
    updater.start();
    fake.emit("update-downloaded", {}, "", "0.3.0");
    fake.emit("error", new Error("offline"));
    assert.equal(updater.state().status, "ready");
  });
});
