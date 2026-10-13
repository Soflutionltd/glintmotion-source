// Mechanical rewrites for the motion-quality findings. A fix is offered only when the code it
// touches is written literally (string selector, string ease, object vars) and matches exactly one
// call, so a computed value or an ambiguous match keeps the hint and never gets rewritten.
import { parse, type CallExpression, type Node, type ObjectExpression, type Property } from "acorn";
import { ancestor } from "acorn-walk";
import type { LintContext } from "../context";
import type { LintEdit, LintFix } from "../types";
import type { ExtractedBlock, OpenTag } from "../utils";
import { tagSimpleSelectors } from "./gsap";

/** Measured clean on a 1.6x -> 1x scale of a single line; a probe on the baseline is exact. */
const BASELINE_ORIGIN = "50% 80%";

const TWEEN_METHODS = new Set(["to", "from", "fromTo"]);
const SCALE_KEYS = new Set(["scale", "scaleX", "scaleY"]);
const STATEMENT_PARENTS = new Set(["Program", "BlockStatement", "StaticBlock", "SwitchCase"]);
const GUARD_LENGTH = 24;

type TweenCall = {
  method: string;
  selector: string;
  selectorRaw: string;
  objects: ObjectExpression[];
  vars: ObjectExpression | undefined;
  statement: Node | undefined;
};

type Animation = { targetSelector: string; method: string; ease?: string; duration?: number };

const tweenIndexes = new WeakMap<ExtractedBlock, TweenCall[]>();

function insertableStatement(ancestors: Node[]): Node | undefined {
  for (let index = ancestors.length - 2; index >= 0; index -= 1) {
    const node = ancestors[index];
    if (node?.type !== "ExpressionStatement") continue;
    const parent = ancestors[index - 1];
    return parent && STATEMENT_PARENTS.has(parent.type) ? node : undefined;
  }
  return undefined;
}

function tweenCall(node: CallExpression, script: string, ancestors: Node[]): TweenCall | null {
  const { callee } = node;
  if (callee.type !== "MemberExpression" || callee.computed) return null;
  if (callee.property.type !== "Identifier" || !TWEEN_METHODS.has(callee.property.name)) {
    return null;
  }
  const [target] = node.arguments;
  if (target?.type !== "Literal" || typeof target.value !== "string") return null;
  const method = callee.property.name;
  const objects = node.arguments
    .slice(1, method === "fromTo" ? 3 : 2)
    .filter((arg): arg is ObjectExpression => arg.type === "ObjectExpression");
  return {
    method,
    selector: target.value,
    selectorRaw: script.slice(target.start, target.end),
    objects,
    vars: objects.at(-1),
    statement: insertableStatement(ancestors),
  };
}

function tweenCalls(script: ExtractedBlock): TweenCall[] {
  const cached = tweenIndexes.get(script);
  if (cached) return cached;
  const calls: TweenCall[] = [];
  try {
    const ast = parse(script.content, {
      ecmaVersion: "latest",
      sourceType: "script",
      allowReturnOutsideFunction: true,
    });
    ancestor(ast, {
      CallExpression: (node, _state, ancestors) => {
        const call = tweenCall(node, script.content, ancestors);
        if (call) calls.push(call);
      },
    });
  } catch {
    // A program that does not parse gets no rewrite.
  }
  tweenIndexes.set(script, calls);
  return calls;
}

function property(object: ObjectExpression | undefined, name: string): Property | undefined {
  return object?.properties.find(
    (entry): entry is Property =>
      entry.type === "Property" &&
      !entry.computed &&
      ((entry.key.type === "Identifier" && entry.key.name === name) ||
        (entry.key.type === "Literal" && entry.key.value === name)),
  );
}

function literalValue(entry: Property | undefined): unknown {
  return entry?.value.type === "Literal" ? entry.value.value : undefined;
}

/** A script-relative range as an edit on the original file, when comment stripping left it intact. */
function edit(
  ctx: LintContext,
  block: ExtractedBlock | null,
  start: number,
  end: number,
  replacement: string,
): LintEdit | null {
  const content = block ? block.content : ctx.source;
  const from = ctx.originalOffset(block, start);
  const to = ctx.originalOffset(block, end);
  if (from === undefined || to === undefined) return null;
  const expected = content.slice(start, end);
  return ctx.rawSource.slice(from, to) === expected
    ? { start: from, end: to, expected, replacement }
    : null;
}

function only<T>(items: T[]): T | undefined {
  return items.length === 1 ? items[0] : undefined;
}

export function easeFix(
  ctx: LintContext,
  script: ExtractedBlock,
  animation: Animation,
  ease: string,
): LintFix | undefined {
  const call = only(
    tweenCalls(script).filter((candidate) => {
      if (candidate.method !== animation.method) return false;
      if (candidate.selector !== animation.targetSelector) return false;
      if (literalValue(property(candidate.vars, "ease")) !== animation.ease) return false;
      const duration = property(candidate.vars, "duration");
      return duration === undefined || literalValue(duration) === animation.duration;
    }),
  );
  const value = property(call?.vars, "ease")?.value;
  if (!value) return undefined;
  const quote = script.content[value.start] ?? '"';
  const change = edit(ctx, script, value.start, value.end, `${quote}${ease}${quote}`);
  return change
    ? {
        description: `ease ${animation.ease} -> ${ease} on ${animation.targetSelector}`,
        edits: [change],
      }
    : undefined;
}

function scales(call: TweenCall): boolean {
  return call.objects.some((object) =>
    object.properties.some(
      (entry) =>
        entry.type === "Property" &&
        !entry.computed &&
        entry.key.type === "Identifier" &&
        SCALE_KEYS.has(entry.key.name),
    ),
  );
}

/** Sets the origin once, before the tween: an origin inside tween vars would itself animate. */
export function originFix(
  ctx: LintContext,
  script: ExtractedBlock,
  animation: Animation,
): LintFix | undefined {
  const call = only(
    tweenCalls(script).filter(
      (candidate) =>
        candidate.method === animation.method &&
        candidate.selector === animation.targetSelector &&
        scales(candidate),
    ),
  );
  const statement = call?.statement;
  if (!call || !statement) return undefined;
  const lineStart = script.content.lastIndexOf("\n", statement.start - 1) + 1;
  const indent = script.content.slice(lineStart, statement.start);
  const separator = /^[ \t]*$/.test(indent) ? `\n${indent}` : " ";
  const set = `gsap.set(${call.selectorRaw}, { transformOrigin: "${BASELINE_ORIGIN}" });`;
  const end = Math.min(statement.end, statement.start + GUARD_LENGTH);
  const head = script.content.slice(statement.start, end);
  const change = edit(ctx, script, statement.start, end, `${set}${separator}${head}`);
  return change
    ? {
        description: `transformOrigin "${BASELINE_ORIGIN}" on ${animation.targetSelector}`,
        edits: [change],
      }
    : undefined;
}

const WILL_CHANGE = /(\s*)will-change\s*:\s*([^;}"']*)(;|(?=["'}]|$))/gi;
const RASTERISING = /\b(transform|scale|all)\b/i;

function willChangeEdits(
  ctx: LintContext,
  block: ExtractedBlock | null,
  text: string,
  base: number,
): LintEdit[] {
  return [...text.matchAll(WILL_CHANGE)].flatMap((match) => {
    if (!RASTERISING.test(match[2] ?? "")) return [];
    const start = base + match.index;
    const change = edit(ctx, block, start, start + match[0].length, "");
    return change ? [change] : [];
  });
}

/** Rules in this file's <style> blocks whose whole selector is one of the tag's own selectors. */
function styleRuleEdits(ctx: LintContext, own: string[]): LintEdit[] {
  return ctx.styles.flatMap((block) => {
    if (block.index === -1) return [];
    return [...block.content.matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap((rule) => {
      const [, selector = "", body = ""] = rule;
      if (!own.includes(selector.trim())) return [];
      const bodyStart = rule.index + selector.length + 1;
      return willChangeEdits(ctx, block, body, bodyStart);
    });
  });
}

function inlineStyleEdits(ctx: LintContext, tag: OpenTag): LintEdit[] {
  const attr = /\sstyle\s*=\s*(["'])(.*?)\1/is.exec(tag.raw);
  if (!attr) return [];
  const valueStart = tag.index + attr.index + attr[0].indexOf(attr[1] ?? '"') + 1;
  return willChangeEdits(ctx, null, attr[2] ?? "", valueStart);
}

export function willChangeFix(ctx: LintContext, targets: OpenTag[]): LintFix | undefined {
  const seen = new Set<number>();
  const edits = targets
    .flatMap((tag) => [
      ...inlineStyleEdits(ctx, tag),
      ...styleRuleEdits(ctx, tagSimpleSelectors(tag)),
    ])
    .filter((change) => !seen.has(change.start) && seen.add(change.start));
  return edits.length > 0
    ? { description: "remove will-change from the scaled text", edits }
    : undefined;
}
