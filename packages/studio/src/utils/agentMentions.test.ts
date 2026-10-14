import { describe, expect, it } from "vitest";
import {
  MENTION_LIMIT,
  insertMention,
  matchMentionFiles,
  mentionAt,
  mentionedFiles,
  withMentionedFiles,
} from "./agentMentions";

const FILES = [
  "index.html",
  "compositions/slide-01.html",
  "assets/logo.png",
  "assets/audio/theme.mp3",
  ".hyperframes/preview/x.html",
  "AGENTS.md",
];

describe("mentionAt", () => {
  it("finds the word typed after @ at the caret", () => {
    expect(mentionAt("Put @lo", 7)).toEqual({ start: 4, query: "lo" });
    expect(mentionAt("@", 1)).toEqual({ start: 0, query: "" });
  });

  it("ignores an e-mail address and a finished mention", () => {
    expect(mentionAt("mail me@site", 12)).toBeNull();
    expect(mentionAt("Put @logo here", 14)).toBeNull();
  });
});

describe("matchMentionFiles", () => {
  it("offers media first and hides engine folders", () => {
    expect(matchMentionFiles(FILES, "")).toEqual([
      "assets/logo.png",
      "assets/audio/theme.mp3",
      "index.html",
      "compositions/slide-01.html",
      "AGENTS.md",
    ]);
  });

  it("matches anywhere in the path, case aside", () => {
    expect(matchMentionFiles(FILES, "SLIDE")).toEqual(["compositions/slide-01.html"]);
  });

  it("keeps the list short", () => {
    const many = Array.from({ length: 20 }, (_, i) => `assets/img-${i}.png`);
    expect(matchMentionFiles(many, "img")).toHaveLength(MENTION_LIMIT);
  });
});

describe("insertMention", () => {
  it("replaces the typed word and leaves one space after", () => {
    expect(insertMention("Put @lo here", 4, 7, "assets/logo.png")).toEqual({
      text: "Put @assets/logo.png here",
      caret: 21,
    });
  });
});

describe("mentionedFiles", () => {
  it("lists the known files once, without trailing punctuation", () => {
    const text = "Use @assets/logo.png, then @assets/logo.png and @nothing.png.";
    expect(mentionedFiles(text, FILES)).toEqual(["assets/logo.png"]);
  });

  it("adds the files to the prompt only when there are some", () => {
    expect(withMentionedFiles("Hi", [])).toBe("Hi");
    expect(withMentionedFiles("Hi", ["assets/logo.png"])).toMatch(/\n- assets\/logo\.png$/);
  });
});
