---
name: motion-quality
description: "Make HyperFrames motion read cleanly frame by frame: text that lands without a tick, scales without shaking, and stays sharp. Use when animating text (titles, wordmarks, counters, captions), choosing an ease or a transformOrigin, or reviewing why a render looks jittery, soft or late. Covers the pixel rules measured on the HyperFrames engine, the lint codes that catch them statically, and glintmotion_motion_check, which measures the rendered frames."
---

# Motion quality

A still frame cannot show a sub-pixel bug. A word that freezes for five frames or shakes by half a pixel looks fine in every screenshot and wrong in the video. So: write the motion, then **measure the frames**, then fix what the numbers show.

The rules below were measured on the HyperFrames engine (Chromium, device scale 1, 30 fps). They are about what the rasteriser does with GSAP transforms, not about taste.

## The three instruments

| Tool                                         | When                      | What it sees                                                   |
| -------------------------------------------- | ------------------------- | -------------------------------------------------------------- |
| `glintmotion_check` (or `hyperframes lint`)  | after every edit          | the code: eases, origins, `will-change` on text                |
| `glintmotion_motion_check`                   | when text moves or scales | the frames: each moving element alone, captured frame by frame |
| `glintmotion_contact_sheet` / `studio_frame` | layout and pacing         | single frames, not motion                                      |

`glintmotion_motion_check` isolates each tween's targets (everything else hidden, so grain, video and neighbours cannot mask a defect) and returns, per finding, the target, its tween's times, a per-frame `pattern` (`m` moved, `=` same pixels as the frame before) and a fix. Pass `from`/`to` to check one scene. Expect about 0.3 s per tween.

| Finding        | Pattern        | Meaning                                                                             |
| -------------- | -------------- | ----------------------------------------------------------------------------------- |
| `tail_tick`    | `mmmmm=m=====` | settles, jumps one more pixel, stops: reads as a tick, not a landing                |
| `early_finish` | `mmmmmm======` | a third or more of the tween shows no movement; the visible end is `visibleUntil`   |
| `late_start`   | `=====mmmmmm`  | an ease-in spends its first frames under a pixel; it really starts at `visibleFrom` |
| `stall`        | `mmm====mmm`   | stops, then moves again: a visible hitch                                            |
| `judder`       | —              | text whose ink goes up and down while it should move one way                        |

## Rule 1 — Text snaps to whole pixels vertically

Glyphs are placed on whole device pixels vertically. Any part of a tween that moves text less than one pixel per frame vertically produces identical frames.

Measured (96 px serif, `from({ y: 50 })`, 0.47 s = 14 frames): `expo.out` gives the pattern `mmmmmmm=m=====`, **6 identical frames** and a one-pixel tick before the end (`tail_tick`). The same move with `power2.out` lands without a finding.

- For text moving on `y` / `yPercent`, prefer `power2.out` or `power1.out`. Keep `expo.out` and `power4.out` for large travel, short durations, or non-text elements.
- Shorten rather than soften: a 0.4 s `power3.out` reads better than a 0.8 s `expo.out` that is idle for its last 0.25 s.
- Lint: `gsap_ease_freezes_on_frame_clock` estimates the frozen frames from distance, duration, ease and fps.

## Rule 2 — Scale text from its baseline, not its centre

Scaling around the centre moves the baseline every frame; snapped to whole pixels, the text shakes up and down.

Measured (96 px serif, `line-height: 1.1`, `scale: 1.6 → 1`, linear, 40 frames): with the default centre origin the ink's vertical centre **reverses direction 37 times in 39 frame steps**. With `transformOrigin` at `50% 75%`, `50% 80%`, `50% 85%` or on a measured baseline: **no judder**.

```js
tl.fromTo(
  "#title",
  { scale: 1.6, transformOrigin: "50% 80%" },
  { scale: 1, duration: 1.2, ease: "power2.out" },
  0,
);
```

- `50% 80%` is the simple choice for one line at a normal `line-height`. Unusual line-heights or fonts move the baseline: check with `glintmotion_motion_check`.
- Exact baseline: a zero-size probe at the end of the line sits on it.

```html
<div id="title">
  Glissez un post<span id="probe" style="display:inline-block;width:0;height:0"></span>
</div>
<script>
  gsap.set("#title", { transformOrigin: `50% ${document.getElementById("probe").offsetTop}px` });
</script>
```

- Multi-line blocks: split into one element per line and scale each from its own baseline.
- Lint: `gsap_text_scale_center_origin` (it accepts 70–88 %, pixel and em origins, and computed templates).

## Rule 3 — No `will-change: transform` on scaled text

`will-change: transform` (or `willChange` in tween vars) puts the text on its own layer, rasterised once and scaled as a bitmap. Measured on the same 96 px line scaled 1.6 → 1: sharpness (Laplacian energy) **189 with it, 202 without**, softer type at rest. The runtime already sets `force3D: false`; do not undo it.

- Lint: `will_change_scaled_text`.

## Rule 4 — Transforms and opacity only

Animate `x`, `y`, `xPercent`, `yPercent`, `scale`, `rotation`, `opacity`. Avoid animating `top`, `left`, `width`, `height`, `font-size`, `letter-spacing` or `line-height` on text: each frame re-runs layout and re-places every glyph, and the motion check cannot see those tweens (it only follows transforms).

- Letter-spacing reveals: animate each letter's `x` instead.
- Counters: the digits change every frame, so `glintmotion_motion_check` skips judder on them; use `font-variant-numeric: tabular-nums` so the width does not jump.

## Rule 5 — Measure layout with boxes, not offsets

- `offsetTop` / `offsetLeft` are rounded to whole pixels and measured from the nearest positioned ancestor: fine for a baseline origin (give the line `position: relative`), not for a position that feeds a transform. Use `getBoundingClientRect()` there.
- Measure before the timeline sets any transform on the element, or the box includes it.

## Rule 6 — Time the next beat on the visible end

When `early_finish` reports `visibleUntil`, that is when the viewer sees the move end. Start the next beat from there, or shorten the tween so the two agree. The same goes for `late_start` and `visibleFrom`.

## Exceptions

- `back`, `elastic`, `bounce`, `rough` and `wiggle` eases reverse on purpose: judder is not reported for them.
- Repeating or yoyo tweens are not checked for judder.
- A sweep that is clipped out of view (a shine crossing a pill) is not idle while it is invisible.

## Workflow

1. Write the motion with the rules above.
2. `glintmotion_check` with `fix: true` (or `hyperframes lint --fix`) inside a session: it rewrites the literal cases of the three lint warnings. Fix the rest (eases held in variables, an origin someone chose) by hand.
3. `glintmotion_motion_check` on the scenes with text in motion.
4. Fix, then run it again on the same `from`/`to` until it returns no findings, or only ones you chose (a deliberate hold, a late start on purpose).

## Credits

The idea of measuring motion on rendered frames, and several of these rules, come from the `motion-quality` skill and measurement library of [snapcn](https://github.com/shadcn-labs/snapcn) (MIT, shadcn-labs), written for Remotion. Here they are adapted to HTML and GSAP and re-measured on the HyperFrames engine.
