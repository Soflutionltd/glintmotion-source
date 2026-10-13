// Drives a composition in an offscreen BrowserWindow (Electron's Chromium, device scale 1
// like the render engine), reads the real tweens from the runtime, and captures only each
// animated element's box, frame by frame, for motion-check.mjs.
import { BrowserWindow } from "electron";
import { analyzeTween, inkCentroid, toGray } from "./motion-check.mjs";

const READY_TIMEOUT_MS = 20_000;
const BOX_PADDING = 6;
const BOX_SAMPLES = [0, 0.25, 0.5, 0.75, 1];

// Runs in the page. Lists the root timeline's motion tweens with their start/end in
// composition seconds and keeps them on window.__gmMotion for the box and seek helpers.
const COLLECT_TWEENS = `(() => {
  const MOTION = ["x", "y", "xPercent", "yPercent", "scale", "scaleX", "scaleY", "rotation", "rotate", "skewX", "skewY"];
  const root = document.querySelector("[data-composition-id]");
  const timeline = root && window.__timelines && window.__timelines[root.getAttribute("data-composition-id")];
  if (!timeline) return { error: "The composition registers no timeline for its root (window.__timelines)." };
  const startOf = (child) => {
    let time = child.startTime();
    for (let parent = child.parent; parent && parent !== timeline; parent = parent.parent) time += parent.startTime();
    return time;
  };
  const isText = (el) => /[\\p{L}\\p{N}]/u.test(el.textContent || "") && !el.querySelector("img, video, canvas, picture, svg");
  const label = (el) => (el.id ? "#" + el.id : el.classList.length ? "." + [...el.classList].join(".") : el.tagName.toLowerCase());
  const tweens = timeline.getChildren(true, true, false).filter((tween) => tween.duration() > 0 && Object.keys(tween.vars).some((key) => MOTION.includes(key)));
  window.__gmMotion = tweens.map((tween) => tween.targets().filter((target) => target instanceof Element));
  return {
    fps: Number(root.getAttribute("data-fps")) || 30,
    tweens: tweens.map((tween, index) => {
      const start = startOf(tween);
      const targets = window.__gmMotion[index];
      return {
        index,
        start,
        end: start + tween.totalDuration(),
        props: Object.keys(tween.vars).filter((key) => MOTION.includes(key)),
        ease: typeof tween.vars.ease === "string" ? tween.vars.ease : null,
        repeats: tween.repeat() !== 0 || !!tween.vars.yoyo,
        text: targets.length > 0 && targets.every(isText),
        label: targets.length ? label(targets[0]) + (targets.length > 1 ? " (+" + (targets.length - 1) + ")" : "") : "(no element)",
      };
    }),
  };
})()`;

const BOX_OF = (index) => `(() => {
  const targets = window.__gmMotion[${index}] || [];
  const rects = targets.map((el) => el.getBoundingClientRect()).filter((r) => r.width && r.height);
  if (!rects.length) return null;
  const box = {
    left: Math.min(...rects.map((r) => r.left)), top: Math.min(...rects.map((r) => r.top)),
    right: Math.max(...rects.map((r) => r.right)), bottom: Math.max(...rects.map((r) => r.bottom)),
  };
  return { ...box, text: targets.map((el) => el.textContent).join("|") };
})()`;

// Hides everything but the tween's targets, so grain, video and neighbouring motion
// cannot mask a frozen frame. Ancestors keep their opacity, clipping and masks.
const SOLO = (index) => `(() => {
  if (!document.getElementById("gm-solo-style")) {
    const style = document.createElement("style");
    style.id = "gm-solo-style";
    style.textContent = "body.gm-solo *:not([data-gm-solo], [data-gm-solo] *) { visibility: hidden !important; } body.gm-solo [data-gm-solo] { visibility: visible !important; }";
    document.head.appendChild(style);
  }
  document.querySelectorAll("[data-gm-solo]").forEach((el) => el.removeAttribute("data-gm-solo"));
  (window.__gmMotion[${index}] || []).forEach((el) => el.setAttribute("data-gm-solo", ""));
  document.body.classList.add("gm-solo");
})()`;

const SEEK = (time) =>
  `window.__player.renderSeek(${time}, { exact: true }); window.gsap && window.gsap.ticker.tick(); ` +
  `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`;

const RUNTIME_READY = `!!(window.__player && typeof window.__player.renderSeek === "function" && window.__timelines)`;

async function waitFor(contents, expression) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await contents.executeJavaScript(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The composition did not finish loading in the measuring window.");
}

/** Union of the tween targets' boxes across the tween, padded and clamped to the canvas. */
async function regionOf(contents, tween, canvas) {
  const boxes = [];
  for (const progress of BOX_SAMPLES) {
    await contents.executeJavaScript(SEEK(tween.start + (tween.end - tween.start) * progress));
    const box = await contents.executeJavaScript(BOX_OF(tween.index));
    if (box) boxes.push(box);
  }
  if (!boxes.length) return null;
  const left = Math.max(0, Math.floor(Math.min(...boxes.map((b) => b.left)) - BOX_PADDING));
  const top = Math.max(0, Math.floor(Math.min(...boxes.map((b) => b.top)) - BOX_PADDING));
  const right = Math.min(
    canvas.width,
    Math.ceil(Math.max(...boxes.map((b) => b.right)) + BOX_PADDING),
  );
  const bottom = Math.min(
    canvas.height,
    Math.ceil(Math.max(...boxes.map((b) => b.bottom)) + BOX_PADDING),
  );
  if (right - left < 2 || bottom - top < 2) return null;
  return {
    rect: { x: left, y: top, width: right - left, height: bottom - top },
    textChanges: new Set(boxes.map((b) => b.text)).size > 1,
  };
}

async function captureTween(contents, tween, rect, fps) {
  const samples = [];
  const first = Math.ceil(tween.start * fps);
  const last = Math.floor(tween.end * fps);
  for (let frame = first; frame <= last; frame += 1) {
    const time = frame / fps;
    await contents.executeJavaScript(SEEK(time));
    const image = await contents.capturePage(rect, { stayHidden: true });
    const size = image.getSize();
    const gray = toGray(image.toBitmap(), size.width, size.height);
    samples.push({ time, gray, centroid: inkCentroid(gray, size.width) });
  }
  return samples;
}

/**
 * @param {{ url: string, width: number, height: number, from?: number, to?: number, maxTweens: number }} request
 */
export async function probeMotion({ url, width, height, from = 0, to = Infinity, maxTweens }) {
  const started = Date.now();
  const win = new BrowserWindow({
    width,
    height,
    show: false,
    useContentSize: true,
    webPreferences: { offscreen: { deviceScaleFactor: 1 }, backgroundThrottling: false },
  });
  const contents = win.webContents;
  contents.setFrameRate(240);
  try {
    await win.loadURL(url);
    await waitFor(contents, RUNTIME_READY);
    await contents.executeJavaScript(
      "document.fonts ? document.fonts.ready.then(() => true) : true",
    );
    const collected = await contents.executeJavaScript(COLLECT_TWEENS);
    if (collected.error) throw new Error(collected.error);
    const inWindow = collected.tweens.filter((tween) => tween.end > from && tween.start < to);
    const checked = inWindow.slice(0, maxTweens);
    const findings = [];
    let frames = 0;
    for (const tween of checked) {
      const region = await regionOf(contents, tween, { width, height });
      if (!region) continue;
      await contents.executeJavaScript(SOLO(tween.index));
      const samples = await captureTween(contents, tween, region.rect, collected.fps);
      frames += samples.length;
      for (const finding of analyzeTween(
        { ...tween, textChanges: region.textChanges },
        samples,
        collected.fps,
      )) {
        const key = `${finding.issue}|${finding.target}|${finding.start}`;
        if (!findings.some((known) => `${known.issue}|${known.target}|${known.start}` === key))
          findings.push(finding);
      }
    }
    return {
      fps: collected.fps,
      tweensInWindow: inWindow.length,
      tweensChecked: checked.length,
      framesCaptured: frames,
      seconds: Math.round((Date.now() - started) / 100) / 10,
      findings,
      ...(inWindow.length > checked.length && {
        note: `Only the first ${checked.length} tweens were checked; narrow from/to for the rest.`,
      }),
    };
  } finally {
    win.destroy();
  }
}
