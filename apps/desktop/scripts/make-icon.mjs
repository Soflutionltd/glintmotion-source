import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const svg = readFileSync(join(root, "build", "icon.svg"));
const iconset = join(root, "build", "icon.iconset");

rmSync(iconset, { recursive: true, force: true });
mkdirSync(iconset);

const sizes = [16, 32, 64, 128, 256, 512, 1024];
for (const size of sizes) {
  const png = sharp(svg, { density: Math.max(72, (72 * size) / 1024) * 4 }).resize(size, size);
  if (size <= 512) await png.clone().toFile(join(iconset, `icon_${size}x${size}.png`));
  if (size >= 32) await png.clone().toFile(join(iconset, `icon_${size / 2}x${size / 2}@2x.png`));
}
await sharp(svg, { density: 288 }).resize(512, 512).toFile(join(root, "build", "icon.png"));

execFileSync("iconutil", ["-c", "icns", iconset, "-o", join(root, "build", "icon.icns")]);
rmSync(iconset, { recursive: true, force: true });
console.log("build/icon.icns and build/icon.png written");
