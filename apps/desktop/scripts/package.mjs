import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

const ffmpegDir = join(appDir, "vendor", "ffmpeg");
const bundledFfmpeg = ["ffmpeg", "ffprobe"].every((tool) => existsSync(join(ffmpegDir, tool)));
if (!bundledFfmpeg) console.warn("No vendor/ffmpeg build (scripts/build-ffmpeg.sh): the app will use Homebrew's ffmpeg.");

const [appPath] = await packager({
  dir: appDir,
  out: join(appDir, "out"),
  overwrite: true,
  platform: "darwin",
  arch: "arm64",
  icon: join(appDir, "build/icon.icns"),
  appBundleId: "com.soflution.glintmotion",
  appCategoryType: "public.app-category.video",
  extraResource: [engineDir, join(appDir, "bin"), ...(bundledFfmpeg ? [ffmpegDir] : [])],
  ignore: [
    /^\/stage($|\/)/,
    /^\/out($|\/)/,
    /^\/scripts($|\/)/,
    /^\/build($|\/)/,
    /^\/bin($|\/)/,
    /^\/vendor($|\/)/,
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

console.log(`Glintmotion packaged at ${appPath}`);
