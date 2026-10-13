import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkResolution,
  FIRST_VIDEO_PARTS,
  firstVideoPrompt,
  projectNameFor,
  readSiteOrIdea,
  toFeedPost,
} from "./first-video.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const firstPicks = Object.fromEntries(FIRST_VIDEO_PARTS.map((part) => [part.id, part.clips[0].block]));

describe("first-video card", () => {
  it("ships a preview and a registry block for every clip it offers", () => {
    for (const part of FIRST_VIDEO_PARTS) {
      for (const { block } of part.clips) {
        assert.ok(existsSync(join(here, "ui", "first-video", `${block}.mp4`)), `preview for ${block}`);
        assert.ok(existsSync(join(here, "..", "..", "registry", "blocks", block)), `registry block ${block}`);
      }
    }
  });

  it("tells a website from an idea", () => {
    assert.deepEqual(readSiteOrIdea("tonsite.com"), { site: "https://tonsite.com/", idea: null });
    assert.deepEqual(readSiteOrIdea("https://www.sociomator.com/fr"), {
      site: "https://www.sociomator.com/fr",
      idea: null,
    });
    assert.deepEqual(readSiteOrIdea("Une app de recettes. Ton chaleureux"), {
      site: null,
      idea: "Une app de recettes. Ton chaleureux",
    });
    assert.deepEqual(readSiteOrIdea("   "), { site: null, idea: null });
  });

  it("names the project after the site or the idea's first words, without taking an existing folder", () => {
    const parent = mkdtempSync(join(tmpdir(), "gm-first-video-"));
    assert.equal(projectNameFor({ site: "https://www.sociomator.com/", idea: null, parent }), "sociomator");
    assert.equal(
      projectNameFor({ site: null, idea: "« Lancement » d'été : 3 nouveautés, vite !", parent }),
      "Lancement d été 3 nouveautés",
    );
    assert.equal(projectNameFor({ site: null, idea: "!!!", parent }), "Ma vidéo");
    mkdirSync(join(parent, "sociomator"));
    mkdirSync(join(parent, "sociomator 2"));
    assert.equal(projectNameFor({ site: "https://sociomator.com", idea: null, parent }), "sociomator 3");
  });

  it("asks the agent for the four picked parts in order, with the site's brand", () => {
    const prompt = firstVideoPrompt({ picks: firstPicks, site: "https://tonsite.com/", idea: null });
    const positions = FIRST_VIDEO_PARTS.map((part) => prompt.indexOf(`glintmotion add ${part.clips[0].block}`));
    assert.ok(positions.every((position) => position > 0));
    assert.deepEqual([...positions].sort((a, b) => a - b), positions);
    assert.match(prompt, /glintmotion capture https:\/\/tonsite\.com\/ --skip-vision --json/);
  });

  it("refuses an unknown clip or a request with neither site nor idea", () => {
    assert.throws(() => firstVideoPrompt({ picks: firstPicks, site: null, idea: null }), /site ou décris ton idée/);
    assert.throws(
      () => firstVideoPrompt({ picks: { ...firstPicks, hook: "rm -rf" }, site: null, idea: "x" }),
      /Choisis un extrait pour « Accroche »/,
    );
  });
});

describe("feed post format", () => {
  it("cuts the engine's portrait scaffold to 1080 × 1350 everywhere it names the height", () => {
    // What `init --example blank --resolution portrait` writes (engine 0.8.152).
    const portrait = `<html lang="en" data-resolution="portrait">
    <meta name="viewport" content="width=1080, height=1920" />
      html,
      body {
        margin: 0;
        width: 1080px;
        height: 1920px;
      }
    <div
      id="root"
      data-width="1080"
      data-height="1920"
    >`;
    const post = toFeedPost(portrait);
    assert.doesNotMatch(post, /1920/);
    assert.doesNotMatch(post, /data-resolution/);
    assert.match(post, /content="width=1080, height=1350"/);
    assert.match(post, /height: 1350px;/);
    assert.match(post, /data-height="1350"/);
  });

  it("is a format createProject accepts", () => {
    assert.equal(checkResolution("post"), "post");
    assert.throws(() => checkResolution("4:5"), /Format inconnu/);
  });
});
