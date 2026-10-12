import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

const [appPath] = await packager({
  dir: appDir,
  out: join(appDir, "out"),
  overwrite: true,
  platform: "darwin",
  arch: "arm64",
  icon: join(appDir, "build/icon.icns"),
  appBundleId: "com.soflution.glintmotion",
  appCategoryType: "public.app-category.video",
  extraResource: [engineDir],
  ignore: [/^\/stage($|\/)/, /^\/out($|\/)/, /^\/scripts($|\/)/, /^\/build($|\/)/, /^\/package-lock\.json$/],
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
