import { describe, expect, it } from "vitest";
import { applyLintFixes } from "../fixes.js";
import { lintHyperframeHtml } from "../hyperframeLinter.js";

function composition(body: string, script: string, style = ""): string {
  return `
<html><head><style>${style}</style></head><body>
  <!-- a comment before the script shifts every offset in the stripped source -->
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

const TITLE = `<div id="title">Glissez un post</div>`;
const MOTION_CODES = [
  "gsap_ease_freezes_on_frame_clock",
  "gsap_text_scale_center_origin",
  "will_change_scaled_text",
];

async function findingOf(code: string, html: string) {
  const { findings } = await lintHyperframeHtml(html);
  return findings.find((finding) => finding.code === code);
}

async function fixOnce(html: string) {
  const { findings } = await lintHyperframeHtml(html);
  const { source, outcomes } = applyLintFixes(html, findings);
  const after = await lintHyperframeHtml(source);
  return {
    source,
    outcomes,
    before: findings.filter((f) => MOTION_CODES.includes(f.code)),
    remaining: after.findings.map((f) => f.code).filter((code) => MOTION_CODES.includes(code)),
  };
}

describe("motion-quality fixes", () => {
  it("swaps a freezing ease for the milder one named in the hint", async () => {
    const html = composition(
      TITLE,
      `tl.fromTo("#title", { y: 40 }, { y: 0, duration: 0.5, ease: "expo.out" }, 0);`,
    );
    const { source, before, remaining } = await fixOnce(html);
    expect(before[0]?.fixHint).toContain('"power1.out"');
    expect(source).toContain(`{ y: 0, duration: 0.5, ease: "power1.out" }`);
    expect(remaining).toEqual([]);
  });

  it("keeps single quotes and leaves every other tween alone", async () => {
    const html = composition(
      `${TITLE}<div id="sub">Sous-titre</div>`,
      [
        `tl.from('#title', { y: 40, duration: 0.5, ease: 'expo.out' }, 0);`,
        `tl.from('#sub', { opacity: 0, duration: 0.5, ease: 'expo.out' }, 0);`,
      ].join("\n    "),
    );
    const { source, remaining } = await fixOnce(html);
    expect(source).toContain(`tl.from('#title', { y: 40, duration: 0.5, ease: 'power1.out' }, 0);`);
    expect(source).toContain(
      `tl.from('#sub', { opacity: 0, duration: 0.5, ease: 'expo.out' }, 0);`,
    );
    expect(remaining).toEqual([]);
  });

  it("never rewrites an ease held in a variable", async () => {
    const html = composition(
      TITLE,
      `const curve = "expo.out"; tl.fromTo("#title", { y: 40 }, { y: 0, duration: 0.5, ease: curve }, 0);`,
    );
    const freeze = await findingOf("gsap_ease_freezes_on_frame_clock", html);
    if (freeze) expect(freeze.fix).toBeUndefined();
  });

  it("sets a baseline origin before a text scale that has none", async () => {
    const tween = `tl.fromTo("#title", { scale: 1.6 }, { scale: 1, duration: 1.33, ease: "none" }, 0);`;
    const { source, remaining } = await fixOnce(composition(TITLE, tween));
    expect(source).toContain(`gsap.set("#title", { transformOrigin: "50% 80%" });\n    ${tween}`);
    expect(remaining).toEqual([]);
  });

  it("leaves an origin someone chose", async () => {
    const html = composition(
      TITLE,
      `gsap.set("#title", { transformOrigin: "center" }); tl.fromTo("#title", { scale: 1.6 }, { scale: 1, duration: 1 }, 0);`,
    );
    const origin = await findingOf("gsap_text_scale_center_origin", html);
    expect(origin).toBeDefined();
    expect(origin?.fix).toBeUndefined();
  });

  it("does not insert a statement where it would change control flow", async () => {
    const html = composition(
      TITLE,
      `if (window.ok) tl.fromTo("#title", { scale: 1.6 }, { scale: 1, duration: 1 }, 0);`,
    );
    const origin = await findingOf("gsap_text_scale_center_origin", html);
    expect(origin).toBeDefined();
    expect(origin?.fix).toBeUndefined();
  });

  it("removes will-change from the scaled text's own rule and inline style only", async () => {
    const body = `<div id="title" class="t" style="opacity: 0; will-change: transform">Glissez un post</div>`;
    const style = `
      #title { color: red; will-change: transform; }
      .card, .t { will-change: transform; }`;
    const html = composition(
      body,
      `gsap.set("#title", { transformOrigin: "50% 80%" }); tl.fromTo("#title", { scale: 1.6 }, { scale: 1, duration: 1 }, 0);`,
      style,
    );
    const { source, outcomes } = await fixOnce(html);
    expect(outcomes.filter((o) => o.applied)).toHaveLength(1);
    expect(source).toContain(`style="opacity: 0;"`);
    expect(source).toContain(`#title { color: red; }`);
    expect(source).toContain(`.card, .t { will-change: transform; }`);
  });

  it("skips a fix whose source changed after lint", async () => {
    const html = composition(
      TITLE,
      `tl.fromTo("#title", { y: 40 }, { y: 0, duration: 0.5, ease: "expo.out" }, 0);`,
    );
    const { findings } = await lintHyperframeHtml(html);
    const edited = html.replace("<html>", "<html >");
    const { source, outcomes } = applyLintFixes(edited, findings);
    expect(source).toBe(edited);
    expect(outcomes.map((o) => o.reason)).toContain("source_changed");
  });
});
