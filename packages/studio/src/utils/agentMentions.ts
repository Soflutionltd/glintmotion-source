import { MEDIA_EXT } from "./mediaTypes";

export const MENTION_LIMIT = 8;

/** The `@word` being typed right before the caret: where its `@` sits and what follows it. */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const match = /(^|\s)@([^\s@]*)$/.exec(text.slice(0, caret));
  if (!match) return null;
  return { start: caret - match[2].length - 1, query: match[2] };
}

function isMentionable(path: string): boolean {
  return !path.split("/").some((part) => part.startsWith(".") || part === "node_modules");
}

/** Files to offer for `query`: media first, then compositions and the rest, shortest path first. */
export function matchMentionFiles(paths: readonly string[], query: string): string[] {
  const needle = query.toLowerCase();
  const rank = (path: string) => (MEDIA_EXT.test(path) ? 0 : path.endsWith(".html") ? 1 : 2);
  return paths
    .filter((path) => isMentionable(path) && path.toLowerCase().includes(needle))
    .sort((a, b) => rank(a) - rank(b) || a.length - b.length || a.localeCompare(b))
    .slice(0, MENTION_LIMIT);
}

/** `text` with the `@query` from `start` to `caret` replaced by `@path `, and the caret after it. */
export function insertMention(
  text: string,
  start: number,
  caret: number,
  path: string,
): { text: string; caret: number } {
  const mention = `@${path} `;
  const after = text.slice(caret).replace(/^\s+/, "");
  return { text: text.slice(0, start) + mention + after, caret: start + mention.length };
}

/** The project files the message names with `@`, once each, in order. */
export function mentionedFiles(text: string, paths: readonly string[]): string[] {
  const known = new Set(paths);
  const found: string[] = [];
  for (const match of text.matchAll(/(?:^|\s)@([^\s@]+)/g)) {
    const raw = match[1];
    const trimmed = raw.replace(/[.,;:!?)]+$/, "");
    const path = known.has(raw) ? raw : known.has(trimmed) ? trimmed : null;
    if (path && !found.includes(path)) found.push(path);
  }
  return found;
}

/** The prompt with the named files spelled out, so the agent opens them before acting. */
export function withMentionedFiles(prompt: string, files: readonly string[]): string {
  if (files.length === 0) return prompt;
  return [
    prompt,
    "",
    "Files the message names with @ (paths from the project folder). Open each one before you use it:",
    ...files.map((file) => `- ${file}`),
  ].join("\n");
}
