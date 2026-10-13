// Baseline: the engine's way on macOS. chrome-headless-shell driven by Puppeteer,
// one CDP screenshot (JPEG) per frame, piped to ffmpeg.
// node experiments/capture-bench-chrome.mjs <preview url> <width> <height> [frames] [fps]
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, report, RUNTIME_READY, SEEK_AND_SETTLE, startEncoder } from "./capture-bench-shared.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const puppeteer = createRequire(join(repo, "packages", "engine", "package.json"))("puppeteer-core");

function headlessShell() {
  const root = join(homedir(), ".cache", "hyperframes", "chrome", "chrome-headless-shell");
  const version = readdirSync(root).sort().at(-1);
  return join(root, version, "chrome-headless-shell-mac-arm64", "chrome-headless-shell");
}

const { url, width, height, frames, fps } = parseArgs(process.argv.slice(2));
const browser = await puppeteer.launch({ executablePath: headlessShell(), headless: true });
try {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await page.goto(url, { waitUntil: "load" });
  await page.waitForFunction(RUNTIME_READY, { timeout: 20_000 });

  for (const mode of ["capture", "encode"]) {
    const encoder = mode === "encode" ? startEncoder(["-f", "image2pipe", "-framerate", String(fps), "-i", "-"], "/tmp/gm-bench-chrome.mp4") : null;
    let captureMs = 0;
    const started = performance.now();
    for (let frame = 0; frame < frames; frame += 1) {
      const t0 = performance.now();
      await page.evaluate(SEEK_AND_SETTLE(frame / fps));
      const jpeg = await page.screenshot({ type: "jpeg", quality: 90, optimizeForSpeed: true });
      captureMs += performance.now() - t0;
      if (encoder) await encoder.write(jpeg);
    }
    if (encoder) await encoder.end();
    report(`chrome-headless-shell ${mode}`, frames, captureMs, performance.now() - started);
  }
} finally {
  await browser.close();
}
