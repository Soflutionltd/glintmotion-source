import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  copyTemplate,
  loadSeries,
  MAX_SERIES,
  readTemplates,
  readVariables,
  seriesCount,
  seriesOutputKey,
  seriesPrompt,
  setTemplate,
  splitBriefs,
  templatePrompt,
} from "./templates.mjs";
import { renderArgs } from "./render-jobs.mjs";

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

describe("series by variables", () => {
  const declared =
    '<html data-composition-variables="[{&quot;id&quot;:&quot;hook&quot;,&quot;type&quot;:&quot;enum&quot;,&quot;label&quot;:&quot;Accroche&quot;,&quot;default&quot;:&quot;grid&quot;,&quot;options&quot;:[{&quot;value&quot;:&quot;grid&quot;},{&quot;value&quot;:&quot;apps&quot;}]},{&quot;id&quot;:&quot;title&quot;,&quot;type&quot;:&quot;string&quot;,&quot;label&quot;:&quot;Titre&quot;,&quot;default&quot;:&quot;&quot;}]"><div data-composition-id="root"></div></html>';

  it("reads the variables a template declares, entities decoded", () => {
    writeFileSync(join(project, "index.html"), declared);
    assert.deepEqual(
      readVariables(project).map((variable) => variable.id),
      ["hook", "title"],
    );
    writeFileSync(join(project, "index.html"), "<div data-composition-id=\"root\"></div>");
    assert.deepEqual(readVariables(project), []);
  });

  it("tells the agent which variables each row fills, and every brief in order", () => {
    writeFileSync(join(project, "index.html"), declared);
    const prompt = seriesPrompt("Reel", ["Six applis", "Dimanche soir"], readVariables(project));
    assert.match(prompt, /série de 2 versions/);
    assert.match(prompt, /- hook \(choix : grid, apps\) — Accroche\. Défaut : grid\./);
    assert.match(prompt, /- title \(string\) — Titre\. Vide : texte du modèle\./);
    assert.ok(prompt.indexOf("Six applis") < prompt.indexOf("Dimanche soir"));
    assert.match(prompt, /compare \. --batch series\.json/);
  });

  it("loads series.json rows and refuses a malformed one", () => {
    assert.equal(seriesCount(project), 0);
    writeFileSync(join(project, "series.json"), JSON.stringify({ rows: [{ name: "A" }, { name: "B" }] }));
    assert.equal(seriesCount(project), 2);
    assert.deepEqual(loadSeries(project), [{ name: "A" }, { name: "B" }]);
    writeFileSync(join(project, "series.json"), JSON.stringify([{ name: "A" }, "B"]));
    assert.throws(() => loadSeries(project), /version 2 n'est pas un objet/);
    assert.equal(seriesCount(project), 0);
  });

  it("names exported files after the versions only when the names are distinct file names", () => {
    assert.equal(seriesOutputKey([{ name: "Six applis" }, { name: "Dimanche soir" }]), "name");
    assert.equal(seriesOutputKey([{ name: "A" }, { name: "A" }]), "index");
    assert.equal(seriesOutputKey([{ name: "A" }, {}]), "index");
    assert.equal(seriesOutputKey([{ name: "../A" }, { name: "B" }]), "index");
    const { args } = renderArgs(project, {}, "/tmp/rows.json", "name");
    assert.match(args.at(-1), /\{name\}\.mp4$/);
  });
});
