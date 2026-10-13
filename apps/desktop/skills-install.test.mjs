import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { bundledSkills, installSkills, skillsStatus } from "./skills-install.mjs";

const root = mkdtempSync(join(tmpdir(), "glintmotion-skills-"));
after(() => rmSync(root, { recursive: true, force: true }));

function skill(dir, name, body) {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "SKILL.md"), body);
}

const bundle = join(root, "bundle");
skill(bundle, "hyperframes", "new hyperframes");
skill(bundle, "motion-quality", "new motion-quality");
mkdirSync(join(bundle, "not-a-skill"));
writeFileSync(join(bundle, "README.md"), "");

test("bundledSkills lists folders that hold a SKILL.md", () => {
  assert.deepEqual(bundledSkills(bundle), ["hyperframes", "motion-quality"]);
});

test("installSkills links every skill and sets aside what was there", () => {
  const claude = join(root, "home", ".claude", "skills");
  const cursor = join(root, "home", ".cursor", "skills");
  skill(claude, "hyperframes", "old hyperframes");
  skill(claude, "find-skills", "unrelated");
  mkdirSync(cursor, { recursive: true });
  symlinkSync("../../.claude/skills/hyperframes", join(cursor, "hyperframes"));

  assert.equal(skillsStatus(bundle, [claude, cursor]).installed, false);
  const result = installSkills(bundle, [claude, cursor], "stamp");

  assert.equal(result.installed, true);
  assert.equal(result.missing, 0);
  for (const target of [claude, cursor]) {
    for (const name of ["hyperframes", "motion-quality"]) {
      assert.equal(readlinkSync(join(target, name)), join(bundle, name));
    }
  }
  const claudeBackup = join(root, "home", ".claude", "skills-backup", "glintmotion-stamp");
  assert.equal(
    readFileSync(join(claudeBackup, "hyperframes", "SKILL.md"), "utf8"),
    "old hyperframes",
  );
  const cursorBackup = join(
    root,
    "home",
    ".cursor",
    "skills-backup",
    "glintmotion-stamp",
    "hyperframes",
  );
  assert.ok(lstatSync(cursorBackup).isSymbolicLink());
  assert.equal(readlinkSync(cursorBackup), join(claude, "hyperframes"));
  assert.equal(readFileSync(join(claude, "find-skills", "SKILL.md"), "utf8"), "unrelated");
  assert.deepEqual(
    result.backups.sort(),
    [claudeBackup, join(root, "home", ".cursor", "skills-backup", "glintmotion-stamp")].sort(),
  );
});

test("a second install changes nothing and backs nothing up", () => {
  const target = join(root, "again");
  installSkills(bundle, [target], "first");
  const result = installSkills(bundle, [target], "second");
  assert.deepEqual(result.backups, []);
  assert.ok(!existsSync(join(root, "again-backup", "glintmotion-second")));
});
