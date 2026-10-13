// Candidate: Electron's own Chromium. An offscreen BrowserWindow, capturePage() per
// frame, raw BGRA piped to ffmpeg (no JPEG round trip, no separate Chrome download).
// npx electron experiments/capture-bench-electron.mjs <preview url> <width> <height> [frames] [fps]
import { app, BrowserWindow } from "electron";
import { parseArgs, report, RUNTIME_READY, SEEK_AND_SETTLE, startEncoder } from "./capture-bench-shared.mjs";

app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.dock?.hide();

const args = process.argv.slice(process.argv.findIndex((arg) => arg.endsWith("capture-bench-electron.mjs")) + 1);
const { url, width, height, frames, fps } = parseArgs(args);

async function waitFor(contents, expression, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await contents.executeJavaScript(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${expression}`);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width,
    height,
    show: false,
    useContentSize: true,
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });
  const contents = win.webContents;
  contents.setFrameRate(240);
  try {
    await win.loadURL(url);
    await waitFor(contents, RUNTIME_READY, 20_000);

    contents.debugger.attach("1.3");
    const cdpScreenshot = () =>
      contents.debugger.sendCommand("Page.captureScreenshot", { format: "jpeg", quality: 90, optimizeForSpeed: true });

    let cdpMs = 0;
    for (let frame = 0; frame < frames; frame += 1) {
      const t0 = performance.now();
      await contents.executeJavaScript(SEEK_AND_SETTLE(frame / fps));
      await cdpScreenshot();
      cdpMs += performance.now() - t0;
    }
    report("electron offscreen cdp-jpeg", frames, cdpMs, cdpMs);

    for (const mode of ["capture", "encode"]) {
      const encoder =
        mode === "encode"
          ? startEncoder(
              ["-f", "rawvideo", "-pix_fmt", "bgra", "-s", `${width}x${height}`, "-framerate", String(fps), "-i", "-"],
              "/tmp/gm-bench-electron.mp4",
            )
          : null;
      let captureMs = 0;
      const started = performance.now();
      for (let frame = 0; frame < frames; frame += 1) {
        const t0 = performance.now();
        await contents.executeJavaScript(SEEK_AND_SETTLE(frame / fps));
        const image = await contents.capturePage();
        captureMs += performance.now() - t0;
        const size = image.getSize();
        if (size.width !== width || size.height !== height) {
          throw new Error(`captured ${size.width}x${size.height}, expected ${width}x${height}`);
        }
        if (encoder) await encoder.write(image.toBitmap());
      }
      if (encoder) await encoder.end();
      report(`electron offscreen ${mode}`, frames, captureMs, performance.now() - started);
    }
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
