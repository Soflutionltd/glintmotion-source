import { describe, expect, it } from "vitest";
import { lintHyperframeHtml } from "../hyperframeLinter.js";
import { easeFunction, frozenFrames } from "./motionQuality.js";

function composition(body: string, script: string, style = ""): string {
  return `
<html><head><style>${style}</style></head><body>
  <div data-composition-id="c1" data-width="1080" data-height="540" data-fps="30">
    ${body}
  </div>
  <script>
    const tl = gsap.timeline({ paused: true });
    ${script}
    window.__timelines = { c1: tl };
  </script>
</body></html>`;
}

async function codes(html: string): Promise<string[]> {
  const result = await lintHyperframeHtml(html);
  return result.findings.map((finding) => finding.code);
}

const TITLE = `<div id="title">Glissez un post</div>`;

describe("gsap_text_scale_center_origin", () => {
  it("warns when text scales around its centre", async () => {
    const html = composition(
      TITLE,
      `tl.fromTo("#title", { scale: 1.6 }, { scale: 1, duration: 1.33, ease: "none" }, 0);`,
    );
    expect(await codes(html)).toContain("gsap_text_scale_center_origin");
  });

  it("accepts a baseline pivot set by gsap.set, in the tween, in CSS or computed from a probe", async () => {
    const tween = `tl.fromTo("#title", { scale: 1.6 }, { scale: 1, duration: 1 }, 0);`;
    const variants = [
      composition(TITLE, `gsap.set("#title", { transformOrigin: "50% 80%" }); ${tween}`),
      composition(
        TITLE,
        `tl.fromTo("#title", { scale: 1.6 }, { scale: 1, transformOrigin: "0% 78px" }, 0);`,
      ),
      composition(TITLE, tween, "#title { transform-origin: 50% 80%; }"),
      composition(
        TITLE,
        `const b = 80; gsap.set("#title", { transformOrigin: "50% " + b + "px" }); ${tween}`,
      ),
      composition(
        TITLE,
        `const b = 80; gsap.set("#title", { transformOrigin: \`50% \${b}px\` }); ${tween}`,
      ),
    ];
    for (const html of variants)
      expect(await codes(html)).not.toContain("gsap_text_scale_center_origin");
  });

  it("ignores scaled elements that are not a line of text", async () => {
    const card = `<div id="card"><div class="row">Title</div><img src="a.png"></div>`;
    const html = composition(
      card,
      `tl.fromTo("#card", { scale: 0.8 }, { scale: 1, duration: 0.6 }, 0);`,
    );
    expect(await codes(html)).not.toContain("gsap_text_scale_center_origin");
  });
});

describe("will_change_scaled_text", () => {
  it("warns when scaled text carries will-change: transform", async () => {
    const tween = `gsap.set("#title", { transformOrigin: "50% 80%" }); tl.fromTo("#title", { scale: 1.6 }, { scale: 1 }, 0);`;
    expect(await codes(composition(TITLE, tween, "#title { will-change: transform; }"))).toContain(
      "will_change_scaled_text",
    );
    expect(await codes(composition(TITLE, tween))).not.toContain("will_change_scaled_text");
  });
});

describe("gsap_ease_freezes_on_frame_clock", () => {
  it("matches the frames measured on a 50px rise over 14 frames", () => {
    const frozen = (ease: string) => frozenFrames(50, 14, easeFunction(ease) ?? ((p) => p), 1);
    expect(frozen("expo.out")).toBe(5);
    expect(frozen("power4.out")).toBe(5);
    expect(frozen("power2.out")).toBe(3);
  });

  it("warns on a short text rise with a strong ease-out and suggests a milder curve", async () => {
    const html = composition(
      TITLE,
      `tl.from("#title", { y: 50, duration: 0.47, ease: "expo.out" }, 0);`,
    );
    const result = await lintHyperframeHtml(html);
    const finding = result.findings.find((f) => f.code === "gsap_ease_freezes_on_frame_clock");
    expect(finding?.fixHint).toContain("power2.out");
  });

  it("uses timeline defaults and stays quiet on a moderate ease", async () => {
    const strong = composition(TITLE, `tl.from("#title", { y: 50 }, 0);`).replace(
      "gsap.timeline({ paused: true })",
      'gsap.timeline({ paused: true, defaults: { ease: "expo.out", duration: 0.47 } })',
    );
    expect(await codes(strong)).toContain("gsap_ease_freezes_on_frame_clock");
    const moderate = composition(
      TITLE,
      `tl.from("#title", { y: 50, duration: 0.47, ease: "power2.out" }, 0);`,
    );
    expect(await codes(moderate)).not.toContain("gsap_ease_freezes_on_frame_clock");
  });

  it("knows GSAP's built-in names and skips custom eases", () => {
    expect(easeFunction("expo")?.(0.5)).toBeCloseTo(1 - 2 ** -5);
    expect(easeFunction("power3.inOut")?.(0.5)).toBeCloseTo(0.5);
    expect(easeFunction("back.out(1.7)")).toBeNull();
    expect(easeFunction("custom")).toBeNull();
  });
});
