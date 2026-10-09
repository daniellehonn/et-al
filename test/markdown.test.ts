import { describe, expect, it } from "vitest";
import { markdownToBlocks } from "../src/store/body";

const shape = (md: string) => markdownToBlocks(md).map((b) => [b.type, b.depth, b.content]);

describe("markdownToBlocks", () => {
  it("parses headings with their level", () => {
    expect(shape("# One\n### Three")).toEqual([
      ["heading", 0, { text: "One", level: 1 }],
      ["heading", 0, { text: "Three", level: 3 }],
    ]);
  });

  it("nests list items by indentation — two spaces or a tab per level", () => {
    expect(shape("- a\n  - b\n\t\t- c\n1. d")).toEqual([
      ["bullet", 0, { text: "a" }],
      ["bullet", 1, { text: "b" }],
      ["bullet", 2, { text: "c" }],
      ["numbered", 0, { text: "d" }],
    ]);
  });

  it("parses todos with their checked state before treating them as bullets", () => {
    expect(shape("- [ ] open\n- [x] done")).toEqual([
      ["todo", 0, { text: "open", checked: false }],
      ["todo", 0, { text: "done", checked: true }],
    ]);
  });

  it("keeps fenced code verbatim, including lines that look like markdown", () => {
    expect(shape("```\n# not a heading\n- not a bullet\n```")).toEqual([
      ["code", 0, { text: "# not a heading\n- not a bullet" }],
    ]);
  });

  it("keeps an unclosed code fence rather than dropping it", () => {
    expect(shape("```\nlet x = 1")).toEqual([["code", 0, { text: "let x = 1" }]]);
  });

  it("parses a pipe table into columns and rows", () => {
    expect(shape("| a | b |\n|---|:-:|\n| 1 | 2 |\n| 3 | 4 |\nafter")).toEqual([
      ["table", 0, { columns: ["a", "b"], rows: [["1", "2"], ["3", "4"]] }],
      ["paragraph", 0, { text: "after" }],
    ]);
  });

  it("parses quotes, dividers, standalone images and paragraphs", () => {
    expect(shape("> said\n---\n![cap](https://x/y.png)\nplain, with ![inline](z.png)")).toEqual([
      ["quote", 0, { text: "said" }],
      ["divider", 0, {}],
      ["image", 0, { url: "https://x/y.png", caption: "cap" }],
      ["paragraph", 0, { text: "plain, with ![inline](z.png)" }],
    ]);
  });

  it("ignores blank lines and normalises Windows line endings", () => {
    expect(shape("a\r\n\r\n\r\nb")).toEqual([
      ["paragraph", 0, { text: "a" }],
      ["paragraph", 0, { text: "b" }],
    ]);
  });
});
