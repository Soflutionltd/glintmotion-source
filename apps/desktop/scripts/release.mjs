// Publishes Glintmotion <version> to everyone: packages and signs the app, notarises and
// staples it, uploads the zip to R2, then the "Quoi de neuf" notes, then the update feed.
// The feed goes last, so no app sees the update before its files are all in place.
//
//   GLINTMOTION_NOTARY_PROFILE=<profile> node scripts/release.mjs 0.2.0
//
// Needs release-notes/<version>.json, a notarytool keychain profile
// (xcrun notarytool store-credentials) and a wrangler session on the Soflution account.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compareVersions } from "../session-state.mjs";
import { FEED_URL, UPDATE_BASE, WHATS_NEW_URL } from "../updater.mjs";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workerDir = join(appDir, "updater-worker");
const BUCKET = "glintmotion-releases";
// wrangler r2 object put refuses anything larger.
const MAX_UPLOAD_BYTES = 315 * 1000 * 1000;

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

function readNotes(version) {
  const file = join(appDir, "release-notes", `${version}.json`);
  if (!existsSync(file)) fail(`write ${file} first (title, summary, improved, fixed, optional video).`);
  const notes = JSON.parse(readFileSync(file, "utf-8"));
  if (typeof notes.title !== "string" || !notes.title) fail(`${file}: "title" is required.`);
  for (const field of ["improved", "fixed"]) {
    if (!Array.isArray(notes[field])) fail(`${file}: "${field}" must be a list (empty is fine).`);
  }
  if (notes.video && !existsSync(resolve(appDir, notes.video))) fail(`${file}: video ${notes.video} not found.`);
  return notes;
}

async function fetchJson(url, whenMissing) {
  const response = await fetch(url, { cache: "no-store" });
  if (response.status === 404) return whenMissing;
  if (!response.ok) fail(`${url} answered HTTP ${response.status}.`);
  return response.json();
}

function upload(key, file, contentType) {
  execFileSync(
    "npx",
    ["wrangler", "r2", "object", "put", `${BUCKET}/${key}`, "--file", file, "--content-type", contentType, "--remote"],
    { cwd: workerDir, stdio: "inherit" },
  );
}

function zipApp(appPath, zipPath) {
  rmSync(zipPath, { force: true });
  execFileSync("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appPath, zipPath], { stdio: "inherit" });
}

const version = process.argv[2] ?? "";
if (!/^\d+\.\d+\.\d+$/.test(version)) fail("usage: node scripts/release.mjs <x.y.z>");
const packageFile = join(appDir, "package.json");
const manifest = JSON.parse(readFileSync(packageFile, "utf-8"));
if (compareVersions(version, manifest.version) <= 0) fail(`${version} must be newer than ${manifest.version}.`);
const notes = readNotes(version);
const notaryProfile = process.env.GLINTMOTION_NOTARY_PROFILE;
if (!notaryProfile) fail("set GLINTMOTION_NOTARY_PROFILE to a notarytool keychain profile.");

const feed = await fetchJson(FEED_URL, { currentRelease: null, releases: [] });
const whatsNew = await fetchJson(WHATS_NEW_URL, []);
if (feed.releases.some((release) => release.version === version)) fail(`${version} is already published.`);

manifest.version = version;
writeFileSync(packageFile, `${JSON.stringify(manifest, null, 2)}\n`);
execFileSync(process.execPath, [join(appDir, "scripts", "package.mjs")], { stdio: "inherit" });

const appPath = join(appDir, "out", "Glintmotion-darwin-arm64", "Glintmotion.app");
const workDir = mkdtempSync(join(tmpdir(), "glintmotion-release-"));
const zipPath = join(workDir, `Glintmotion-${version}-darwin-arm64.zip`);
zipApp(appPath, zipPath);
execFileSync("xcrun", ["notarytool", "submit", zipPath, "--keychain-profile", notaryProfile, "--wait"], {
  stdio: "inherit",
});
execFileSync("xcrun", ["stapler", "staple", appPath], { stdio: "inherit" });
execFileSync("spctl", ["--assess", "--type", "execute", "--verbose", appPath], { stdio: "inherit" });
// Zipped again so the published app carries its notarisation ticket offline.
zipApp(appPath, zipPath);

const size = statSync(zipPath).size;
if (size > MAX_UPLOAD_BYTES) fail(`${basename(zipPath)} is ${size} bytes, over wrangler's upload limit.`);
const sha256 = createHash("sha256").update(readFileSync(zipPath)).digest("hex");
const zipKey = `stable/${version}/${basename(zipPath)}`;
upload(zipKey, zipPath, "application/zip");

let videoKey = null;
if (notes.video) {
  videoKey = `stable/${version}/whats-new.mp4`;
  upload(videoKey, resolve(appDir, notes.video), "video/mp4");
}

const entry = {
  version,
  date: new Date().toISOString().slice(0, 10),
  title: notes.title,
  summary: notes.summary ?? "",
  improved: notes.improved,
  fixed: notes.fixed,
  video: videoKey,
};
const notesFile = join(workDir, "whats-new.json");
writeFileSync(notesFile, JSON.stringify([entry, ...whatsNew.filter((item) => item.version !== version)], null, 2));
upload("stable/whats-new.json", notesFile, "application/json");

const pubDate = new Date().toISOString();
const nextFeed = {
  currentRelease: version,
  releases: [
    ...feed.releases,
    {
      version,
      updateTo: { version, name: version, pub_date: pubDate, notes: notes.title, url: `${UPDATE_BASE}/${zipKey}`, sha256, size },
    },
  ],
};
const feedFile = join(workDir, "releases.json");
writeFileSync(feedFile, JSON.stringify(nextFeed, null, 2));
upload("stable/releases.json", feedFile, "application/json");

rmSync(workDir, { recursive: true, force: true });
console.log(`Glintmotion ${version} published: ${UPDATE_BASE}/${zipKey}`);
