import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packager } from "@electron/packager";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliDir = resolve(appDir, "../../packages/cli");
const stageDir = join(appDir, "stage");
const engineDir = join(stageDir, "engine");
const identity = process.env.GLINTMOTION_SIGN_IDENTITY ?? "Developer ID Application: Soflution ltd (TB8CC687M3)";

rmSync(stageDir, { recursive: true, force: true });
mkdirSync(engineDir, { recursive: true });

execFileSync("npm", ["pack", "--pack-destination", stageDir], { cwd: cliDir, stdio: "inherit" });
const tarball = readdirSync(stageDir).find((file) => file.endsWith(".tgz"));
if (!tarball) throw new Error("npm pack did not produce a tarball for packages/cli");

writeFileSync(
  join(engineDir, "package.json"),
  JSON.stringify({ private: true, dependencies: { "@hyperframes/cli": `file:../${tarball}` } }, null, 2),
);
execFileSync("npm", ["install", "--omit=dev", "--no-bin-links", "--no-audit", "--no-fund"], { cwd: engineDir, stdio: "inherit" });
rmSync(join(engineDir, "package-lock.json"), { force: true });

// Nothing below runs in the app: the WebAssembly fallback of sharp (the darwin-arm64
// build loads first), prettier (declared by the CLI, never imported), source maps
// and type declarations.
const modules = join(engineDir, "node_modules");
for (const dir of ["@img/sharp-wasm32", "prettier"]) rmSync(join(modules, dir), { recursive: true, force: true });
const pruned = /\.(map|d\.ts|d\.mts|d\.cts)$/;
for (const entry of readdirSync(modules, { recursive: true })) {
  if (pruned.test(entry)) rmSync(join(modules, entry), { force: true });
}

// The engine's pinned chrome-headless-shell ships inside the app, so the first export
// does not download 190 MB. Only the managed cache build is accepted: a system Chrome
// or another tool's puppeteer download would render with an untested version.
const engineCli = join(modules, "@hyperframes", "cli", "bin", "hyperframes.mjs");
const browserEnv = { ...process.env, HYPERFRAMES_NO_TELEMETRY: "1", NO_COLOR: "1", HYPERFRAMES_BROWSER_PATH: "", PRODUCER_HEADLESS_SHELL_PATH: "" };
const ensured = execFileSync(process.execPath, [engineCli, "browser", "ensure"], { env: browserEnv, encoding: "utf8" });
const chromeBinary = ensured.match(/Path:\s+(\S.*?)\s*$/m)?.[1];
if (!chromeBinary?.includes(join(".cache", "hyperframes", "chrome", "chrome-headless-shell"))) {
  throw new Error(`Expected the engine's managed chrome-headless-shell, got ${chromeBinary}`);
}
// Not "chrome-headless-shell": codesign reads a binary inside a folder of its own name as a
// bundle and refuses to sign it ("code object is not signed at all" on the .pak beside it).
const chromeDir = join(stageDir, "chrome");
cpSync(dirname(chromeBinary), chromeDir, { recursive: true, verbatimSymlinks: true });

const ffmpegDir = join(appDir, "vendor", "ffmpeg");
const bundledFfmpeg = ["ffmpeg", "ffprobe"].every((tool) => existsSync(join(ffmpegDir, tool)));
if (!bundledFfmpeg) console.warn("No vendor/ffmpeg build (scripts/build-ffmpeg.sh): the app will use Homebrew's ffmpeg.");

const [appPath] = await packager({
  dir: appDir,
  out: join(appDir, "out"),
  overwrite: true,
  platform: "darwin",
  arch: "arm64",
  // The .icon (Icon Composer, Liquid Glass) is compiled by actool into Assets.car; the .icns covers macOS before 26.
  icon: [join(appDir, "build/icon.icon"), join(appDir, "build/icon.icns")],
  appBundleId: "com.soflution.glintmotion",
  appCategoryType: "public.app-category.video",
  extraResource: [engineDir, join(appDir, "bin"), join(appDir, "..", "..", "skills"), chromeDir, ...(bundledFfmpeg ? [ffmpegDir] : [])],
  ignore: [
    /^\/stage($|\/)/,
    /^\/out($|\/)/,
    /^\/scripts($|\/)/,
    /^\/build($|\/)/,
    /^\/bin($|\/)/,
    /^\/vendor($|\/)/,
    /^\/updater-worker($|\/)/,
    /^\/release-notes($|\/)/,
    /^\/package-lock\.json$/,
    /\.test\.mjs$/,
  ],
  asar: true,
  osxSign: {
    identity,
    optionsForFile: () => ({
      hardenedRuntime: true,
      entitlements: join(appDir, "build/entitlements.plist"),
    }),
  },
});

// @electron/packager only warns when signing fails and still writes an unsigned app.
execFileSync("codesign", ["--verify", "--deep", "--strict", join(appPath, "Glintmotion.app")], { stdio: "inherit" });
console.log(`Glintmotion packaged at ${appPath}`);
