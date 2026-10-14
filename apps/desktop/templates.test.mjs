import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  copyTemplate,
  MAX_SERIES,
  readTemplates,
  setTemplate,
  splitBriefs,
  templatePrompt,
} from "./templates.mjs";

let dir;
let project;
let file;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gm-templates-"));
  project = join(dir, "Carrousel");
  mkdirSync(join(project, "compositions"), { recursive: true });
  writeFileSync(join(project, "index.html"), "<div data-composition-id=\"root\"></div>");
  writeFileSync(join(project, "compositions", "slide-01.html"), "<template></template>");
  file = join(dir, "templates.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("template list", () => {
  it("puts the newest first and drops one that is unmarked", () => {
    const other = join(dir, "Reel");
    mkdirSync(other);
    writeFileSync(join(other, "index.html"), "");
    setTemplate(file, project, true);
    setTemplate(file, other, true);
    assert.deepEqual(readTemplates(file), [other, project]);
    setTemplate(file, other, false);
    assert.deepEqual(readTemplates(file), [project]);
  });

  it("forgets a template whose folder is gone", () => {
    setTemplate(file, project, true);
    rmSync(project, { recursive: true });
    assert.deepEqual(readTemplates(file), []);
  });

  it("refuses a folder that is not a project", () => {
    assert.throws(() => setTemplate(file, join(dir, "nothing"), true), /pas un projet/);
  });
});

describe("briefs", () => {
  it("keeps one brief whole, blank lines included", () => {
    assert.deepEqual(splitBriefs("Titre\n\nTexte", false), ["Titre\n\nTexte"]);
  });

  it("makes one version per paragraph in a series", () => {
    assert.deepEqual(splitBriefs("Lundi : pâtes\n\n  \nMardi : pizza\n", true), [
      "Lundi : pâtes",
      "Mardi : pizza",
    ]);
  });

  it("refuses an empty brief and a series that is too long", () => {
    assert.throws(() => splitBriefs("  ", false), /Écris/);
    const many = Array.from({ length: MAX_SERIES + 1 }, (_, i) => `Post ${i}`).join("\n\n");
    assert.throws(() => splitBriefs(many, true), /au plus par série/);
  });

  it("tells the agent to keep the design and swap the content", () => {
    const prompt = templatePrompt("Carrousel", "7 idées de posts");
    assert.match(prompt, /modèle « Carrousel »/);
    assert.match(prompt, /\n7 idées de posts\n/);
  });
});

describe("copy", () => {
  it("copies the sources and leaves renders and engine state behind", () => {
    for (const skipped of ["renders", ".hyperframes", "snapshots"]) {
      mkdirSync(join(project, skipped));
      writeFileSync(join(project, skipped, "x"), "");
    }
    const dest = join(dir, "Lundi");
    copyTemplate(project, dest);
    assert.equal(readFileSync(join(dest, "compositions", "slide-01.html"), "utf-8"), "<template></template>");
    assert.equal(existsSync(join(dest, "renders")), false);
    assert.equal(existsSync(join(dest, ".hyperframes")), false);
    assert.equal(existsSync(join(dest, "snapshots")), false);
  });

  it("never writes over an existing folder", () => {
    assert.throws(() => copyTemplate(project, project), /existe déjà/);
  });
});
