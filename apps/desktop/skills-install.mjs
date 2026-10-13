// Links Glintmotion's bundled skills into the agents' skill folders (~/.claude/skills,
// ~/.cursor/skills). Whatever already sits under a skill's name is moved to a sibling
// "<folder>-backup/glintmotion-<stamp>/" first, outside the folder agents load.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export function bundledSkills(skillsDir) {
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(skillsDir, entry.name, "SKILL.md")))
    .map((entry) => entry.name)
    .sort();
}

function entryAt(path) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

const linkTarget = (path) => resolve(dirname(path), readlinkSync(path));

function linksTo(path, source) {
  return entryAt(path)?.isSymbolicLink() === true && linkTarget(path) === source;
}

/** Relative links would dangle once moved, so a moved link is recreated absolute. */
function moveAside(path, backup) {
  if (entryAt(path).isSymbolicLink()) {
    symlinkSync(linkTarget(path), backup);
    unlinkSync(path);
  } else {
    renameSync(path, backup);
  }
}

export function skillsStatus(skillsDir, targets) {
  const names = bundledSkills(skillsDir);
  const missing = targets.flatMap((target) =>
    names.filter((name) => !linksTo(join(target, name), join(skillsDir, name))),
  );
  return {
    installed: missing.length === 0,
    skills: names.length,
    missing: missing.length,
    targets,
  };
}

/** `stamp` names the backup folder; one per install run. */
export function installSkills(skillsDir, targets, stamp) {
  const names = bundledSkills(skillsDir);
  const backups = [];
  for (const target of targets) {
    mkdirSync(target, { recursive: true });
    const backupDir = join(dirname(target), `${basename(target)}-backup`, `glintmotion-${stamp}`);
    for (const name of names) {
      const destination = join(target, name);
      const source = join(skillsDir, name);
      if (linksTo(destination, source)) continue;
      if (entryAt(destination)) {
        mkdirSync(backupDir, { recursive: true });
        moveAside(destination, join(backupDir, name));
        if (!backups.includes(backupDir)) backups.push(backupDir);
      }
      symlinkSync(source, destination);
    }
  }
  return { ...skillsStatus(skillsDir, targets), backups };
}
