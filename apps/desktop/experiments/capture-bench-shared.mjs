import { spawn } from "node:child_process";

/** Seeks the studio preview runtime and waits two animation frames, as the studio's frame capture does. */
export const SEEK_AND_SETTLE = (time) =>
  `window.__player.renderSeek(${time}, { exact: true }); window.gsap?.ticker?.tick(); ` +
  `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`;

export const RUNTIME_READY = `!!(window.__player && typeof window.__player.renderSeek === "function")`;

export function parseArgs(argv) {
  const [url, width, height, frames = "120", fps = "30"] = argv;
  if (!url || !width || !height) {
    throw new Error("usage: <preview url> <width> <height> [frames] [fps]");
  }
  return { url, width: Number(width), height: Number(height), frames: Number(frames), fps: Number(fps) };
}

/** An ffmpeg that encodes what is written to its stdin with VideoToolbox HEVC, like the engine's GPU path. */
export function startEncoder(inputArgs, output) {
  const child = spawn(
    "/opt/homebrew/bin/ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-y", ...inputArgs, "-c:v", "hevc_videotoolbox", "-q:v", "65", "-tag:v", "hvc1", "-pix_fmt", "yuv420p", output],
    { stdio: ["pipe", "inherit", "inherit"] },
  );
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
  });
  const write = (buffer) =>
    new Promise((resolve) => (child.stdin.write(buffer) ? resolve() : child.stdin.once("drain", resolve)));
  return { write, end: () => (child.stdin.end(), done) };
}

export function report(label, frames, captureMs, totalMs) {
  const line = {
    label,
    frames,
    captureFps: Math.round((frames / captureMs) * 10000) / 10,
    endToEndFps: Math.round((frames / totalMs) * 10000) / 10,
    msPerFrame: Math.round((captureMs / frames) * 10) / 10,
  };
  console.log(JSON.stringify(line));
}
