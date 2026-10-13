// Motion-quality rules for text, each measured on frames rendered by this engine:
//
// - A text rise of 50px over 14 frames with expo.out rendered 6 identical frames:
//   glyph origins snap to whole pixels vertically (quarter pixels horizontally), so
//   the slow tail of a strong ease-out rounds to the same pixel and the line stops.
// - A linear 1.6x -> 1x scale around the centre reversed its vertical ink centroid
//   38 times in 40 frames (judder); pivoting on the baseline gave 0 reversals.
// - The same scale with will-change: transform ended 6% softer (Laplacian edge
//   energy): the layer is a resampled bitmap, not re-rasterised type.
import type { LintContext } from "../context";
import type { HyperframeLintFinding, LintRule } from "../types";
import type { OpenTag } from "../utils";
import { readAttr, truncateSnippet } from "../utils";
import { collectSimpleStyleRules, combinedTagStyle, tagSimpleSelectors } from "./gsap";

type Values = Record<string, number | string>;

type Animation = {
  targetSelector: string;
  method: string;
  properties: Values;
  fromProperties?: Values;
  duration?: number;
  ease?: string;
};

const GSAP_DEFAULT_DURATION = 0.5;
const GSAP_DEFAULT_EASE = "power1.out";
const DEFAULT_FPS = 30;
const SCALE_PROPS = ["scale", "scaleX", "scaleY"];
const MEDIA_CHILD = /<(img|video|svg|canvas|picture|iframe|audio)\b/i;
const BLOCK_CHILD = /<(div|section|article|ul|ol|li|figure|header|footer|main|nav|table|aside)\b/i;
/** Identical frames in one tween before the stop reads as a freeze rather than a settle. */
const FREEZE_FRAMES = 4;
/** Glyph origins snap to whole pixels vertically and to quarter pixels horizontally. */
const AXIS_QUANTUM: Record<string, number> = { y: 1, x: 0.25 };

async function parseAnimations(script: string): Promise<Animation[]> {
  if (!/gsap\.timeline/.test(script)) return [];
  const mod = await import("@hyperframes/parsers/gsap-parser-acorn");
  const parsed = mod.parseGsapScriptAcorn(script) as unknown as { animations: Animation[] };
  return parsed.animations;
}

function innerHtml(tag: OpenTag, source: string): string | null {
  if (tag.closeIndex === undefined) return null;
  return source.slice(tag.index + tag.raw.length, tag.closeIndex);
}

/** An element that is one run of text: letters, no media, no block children. */
function isTextLine(tag: OpenTag, source: string): boolean {
  const inner = innerHtml(tag, source);
  if (inner === null || MEDIA_CHILD.test(inner) || BLOCK_CHILD.test(inner)) return false;
  return /\p{L}/u.test(inner.replace(/<[^>]*>/g, ""));
}

/** Tags matched by the last compound of each comma part (`#a .b` -> `.b`). Unresolvable parts match nothing. */
function resolveTargets(selector: string, tags: OpenTag[]): OpenTag[] {
  return selector.split(",").flatMap((part) => {
    const last =
      part
        .trim()
        .split(/[\s>+~]+/)
        .filter(Boolean)
        .at(-1) ?? "";
    const wanted = last.match(/[#.][\w-]+/g) ?? [];
    if (wanted.length === 0) return [];
    return tags.filter((tag) => {
      const own = tagSimpleSelectors(tag);
      return wanted.every((token) => own.includes(token));
    });
  });
}

function cssValue(style: string, property: string): string | null {
  const matches = [...style.matchAll(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, "gi"))];
  return matches.at(-1)?.[1]?.trim() ?? null;
}

function stringOf(value: number | string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return String(value).replace(/^__raw:/, "");
}

const VERTICAL_KEYWORDS: Record<string, string> = { top: "top", bottom: "bottom" };

/** The vertical part of a transform-origin, or "center" when it has none. */
function verticalOrigin(origin: string): string {
  const parts = origin.trim().split(/\s+/);
  if (parts.length === 1) return VERTICAL_KEYWORDS[parts[0] ?? ""] ?? "center";
  const [first = "", second = ""] = parts;
  return first in VERTICAL_KEYWORDS ? first : second;
}

/**
 * Lengths and computed values (`50% ${probe.offsetTop}px`, which the parser keeps raw or
 * reduces to a bare unit) are taken as a measured baseline; percentages only near one (70-88%).
 */
function pivotsOnBaseline(origin: string | undefined): boolean {
  if (!origin) return false;
  if (origin.includes("${")) return true;
  const vertical = verticalOrigin(origin);
  if (/^-?[\d.]*(px|em|rem)$/.test(vertical)) return true;
  const percent = /^([\d.]+)%$/.exec(vertical);
  return percent !== null && Number(percent[1]) >= 70 && Number(percent[1]) <= 88;
}

function animatesScale(animation: Animation): boolean {
  const keys = [
    ...Object.keys(animation.properties),
    ...Object.keys(animation.fromProperties ?? {}),
  ];
  return animation.method !== "set" && keys.some((key) => SCALE_PROPS.includes(key));
}

/** transform-origin per selector from gsap.set / tween vars, last writer wins. */
function originsBySelector(animations: Animation[]): Map<string, string> {
  const origins = new Map<string, string>();
  for (const animation of animations) {
    const origin = stringOf(
      animation.properties.transformOrigin ?? animation.fromProperties?.transformOrigin,
    );
    if (origin) origins.set(animation.targetSelector, origin);
  }
  return origins;
}

function willChangeTransform(style: string): boolean {
  return /\b(transform|scale|all)\b/i.test(cssValue(style, "will-change") ?? "");
}

function originFinding(animation: Animation, origin: string | undefined): HyperframeLintFinding {
  return {
    code: "gsap_text_scale_center_origin",
    severity: "warning",
    selector: animation.targetSelector,
    message:
      `Text "${animation.targetSelector}" scales around ${origin ? `"${origin}"` : "its centre"}. Glyph origins snap ` +
      "to whole pixels vertically, so a scale that moves the baseline makes the line climb in one-pixel jumps " +
      "(measured: 38 direction reversals in 40 frames around the centre, 0 on the baseline).",
    fixHint:
      'Pivot on the baseline: put a zero-size inline-block probe at the end of the line (<span class="baseline" ' +
      'style="display:inline-block;width:0;height:0"></span>) and set transformOrigin: `50% ${probe.offsetTop}px` ' +
      'before the timeline, or approximate with "50% 80%".',
    snippet: truncateSnippet(
      JSON.stringify({ ...animation.fromProperties, ...animation.properties }),
    ),
  };
}

function willChangeFinding(animation: Animation): HyperframeLintFinding {
  return {
    code: "will_change_scaled_text",
    severity: "warning",
    selector: animation.targetSelector,
    message:
      `Text "${animation.targetSelector}" scales with will-change: transform. The layer is rasterised once and ` +
      "resampled as a bitmap, so the type renders soft (measured 6% less edge energy than real type at the same frame).",
    fixHint:
      "Remove will-change from the scaled text (and its scaled ancestors) so every frame re-rasterises real type.",
  };
}

type TextScaleContext = {
  source: string;
  tags: OpenTag[];
  styleRules: Map<string, string>;
  origins: Map<string, string>;
};

/** The tween's own origin, else the last gsap.set on the selector, else the CSS one. */
function resolvedOrigin(
  animation: Animation,
  origins: Map<string, string>,
  styles: string[],
): string | undefined {
  const own = stringOf(
    animation.properties.transformOrigin ?? animation.fromProperties?.transformOrigin,
  );
  const css = styles.map((style) => cssValue(style, "transform-origin")).find(Boolean);
  return own ?? origins.get(animation.targetSelector) ?? css ?? undefined;
}

function textScaleFindings(animation: Animation, ctx: TextScaleContext): HyperframeLintFinding[] {
  const targets = resolveTargets(animation.targetSelector, ctx.tags).filter((tag) =>
    isTextLine(tag, ctx.source),
  );
  if (targets.length === 0) return [];
  const styles = targets.map((tag) => combinedTagStyle(tag, ctx.styleRules));
  const origin = resolvedOrigin(animation, ctx.origins, styles);
  const findings = pivotsOnBaseline(origin) ? [] : [originFinding(animation, origin)];
  const tweenHint = `will-change:${stringOf(animation.properties.willChange) ?? ""}`;
  if ([tweenHint, ...styles].some(willChangeTransform)) findings.push(willChangeFinding(animation));
  return findings;
}

// ── Ease freeze ─────────────────────────────────────────────────────────────

const POWER_ALIASES: Record<string, number> = { quad: 1, cubic: 2, quart: 3, quint: 4, strong: 4 };

function powerEase(power: number, kind: string): (p: number) => number {
  const n = power + 1;
  if (kind === "in") return (p) => p ** n;
  if (kind === "inOut") return (p) => (p < 0.5 ? (2 * p) ** n / 2 : 1 - (2 * (1 - p)) ** n / 2);
  return (p) => 1 - (1 - p) ** n;
}

const NAMED_EASES: Record<string, (p: number) => number> = {
  "expo.out": (p) => (p >= 1 ? 1 : 1 - 2 ** (-10 * p)),
  "expo.in": (p) => (p <= 0 ? 0 : 2 ** (10 * (p - 1))),
  "circ.out": (p) => Math.sqrt(1 - (p - 1) ** 2),
  "circ.in": (p) => 1 - Math.sqrt(1 - p * p),
  "sine.out": (p) => Math.sin((p * Math.PI) / 2),
  "sine.in": (p) => 1 - Math.cos((p * Math.PI) / 2),
  "sine.inOut": (p) => -(Math.cos(Math.PI * p) - 1) / 2,
  none: (p) => p,
  linear: (p) => p,
  "power0.out": (p) => p,
};

/** GSAP's built-in curve for a name such as "power3.out" or "expo"; null for custom eases. */
export function easeFunction(name: string): ((p: number) => number) | null {
  const [family = "", kind = "out"] = name.trim().split(".");
  const normalised = `${family}.${kind}`;
  if (NAMED_EASES[normalised]) return NAMED_EASES[normalised];
  if (NAMED_EASES[family] && !name.includes(".")) return NAMED_EASES[family];
  const power = /^power([0-4])$/.exec(family)?.[1] ?? POWER_ALIASES[family];
  if (power === undefined || !["in", "out", "inOut"].includes(kind)) return null;
  return powerEase(Number(power), kind);
}

/** Frames whose snapped position equals the previous frame's, across one tween. */
export function frozenFrames(
  distance: number,
  frames: number,
  ease: (p: number) => number,
  quantum: number,
): number {
  const snapped = (i: number) => Math.round((distance * ease(i / frames)) / quantum);
  let frozen = 0;
  for (let i = 1; i <= frames; i += 1) if (snapped(i) === snapped(i - 1)) frozen += 1;
  return frozen;
}

function pixels(value: number | string | undefined): number | null {
  if (typeof value === "number") return value;
  const match = typeof value === "string" ? /^(-?[\d.]+)(px)?$/.exec(value.trim()) : null;
  return match ? Number(match[1]) : null;
}

/** Travel on one axis; from() and to() tweens are taken as moving from or to 0. */
function travel(animation: Animation, axis: string): number | null {
  const to = pixels(animation.properties[axis]);
  if (animation.method === "fromTo") {
    const from = pixels(animation.fromProperties?.[axis]);
    return from === null || to === null ? null : Math.abs(to - from);
  }
  return to === null ? null : Math.abs(to);
}

const MILDER_EASES = ["power2.out", "power1.out", "sine.out", "none"];

type Freeze = { axis: string; distance: number; frames: number; frozen: number };

function worstFreeze(animation: Animation, fps: number): Freeze | null {
  const ease = easeFunction(animation.ease ?? GSAP_DEFAULT_EASE);
  const frames = Math.round((animation.duration ?? GSAP_DEFAULT_DURATION) * fps);
  if (!ease || frames < FREEZE_FRAMES) return null;
  const freezes = Object.entries(AXIS_QUANTUM).flatMap(([axis, quantum]) => {
    const distance = travel(animation, axis) ?? 0;
    if (distance < 1) return [];
    return [{ axis, distance, frames, frozen: frozenFrames(distance, frames, ease, quantum) }];
  });
  const worst = freezes.sort((a, b) => b.frozen - a.frozen)[0];
  return worst && worst.frozen >= FREEZE_FRAMES ? worst : null;
}

function freezeFinding(animation: Animation, freeze: Freeze, fps: number): HyperframeLintFinding {
  const quantum = AXIS_QUANTUM[freeze.axis] ?? 1;
  const milder = MILDER_EASES.find(
    (name) =>
      frozenFrames(freeze.distance, freeze.frames, easeFunction(name) ?? ((p) => p), quantum) <
      FREEZE_FRAMES,
  );
  const ease = animation.ease ?? GSAP_DEFAULT_EASE;
  return {
    code: "gsap_ease_freezes_on_frame_clock",
    severity: "warning",
    selector: animation.targetSelector,
    message:
      `Text "${animation.targetSelector}" moves ${freeze.distance}px on ${freeze.axis} over ${freeze.frames} frames ` +
      `with ${ease}: ${freeze.frozen} of those frames land on the same pixel as the one before, so the line visibly ` +
      `stops ${(freeze.frozen / fps).toFixed(2)}s before the tween ends.`,
    fixHint: milder
      ? `Use a moderate decelerate such as ease: "${milder}" (fewer than ${FREEZE_FRAMES} frozen frames here), or shorten the tween.`
      : "Shorten the tween or move further: the travel is too small for this many frames.",
  };
}

function compositionFps(ctx: LintContext): number {
  const fps = Number(ctx.rootTag ? readAttr(ctx.rootTag.raw, "data-fps") : NaN);
  return Number.isFinite(fps) && fps > 0 ? fps : DEFAULT_FPS;
}

function freezeFindings(
  animation: Animation,
  ctx: LintContext,
  fps: number,
): HyperframeLintFinding[] {
  if (animation.method === "set") return [];
  const isText = resolveTargets(animation.targetSelector, ctx.tags).some((tag) =>
    isTextLine(tag, ctx.source),
  );
  const freeze = isText ? worstFreeze(animation, fps) : null;
  return freeze ? [freezeFinding(animation, freeze, fps)] : [];
}

export const motionQualityRules: LintRule<LintContext>[] = [
  // gsap_text_scale_center_origin + will_change_scaled_text
  async (ctx) => {
    const findings: HyperframeLintFinding[] = [];
    const styleRules = collectSimpleStyleRules(ctx.styles);
    for (const script of ctx.scripts) {
      const animations = await parseAnimations(script.content);
      const scaleContext = {
        source: ctx.source,
        tags: ctx.tags,
        styleRules,
        origins: originsBySelector(animations),
      };
      for (const animation of animations.filter(animatesScale)) {
        findings.push(...textScaleFindings(animation, scaleContext));
      }
    }
    return findings;
  },

  // gsap_ease_freezes_on_frame_clock
  async (ctx) => {
    const findings: HyperframeLintFinding[] = [];
    const fps = compositionFps(ctx);
    for (const script of ctx.scripts) {
      for (const animation of await parseAnimations(script.content)) {
        findings.push(...freezeFindings(animation, ctx, fps));
      }
    }
    return findings;
  },
];
