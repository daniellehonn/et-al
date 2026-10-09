// The pure body engine: ops applied in memory, markdown out, and the line diff
// the reviewer reads.
import { describe, expect, it } from "vitest";
import { applyOpsToBody, bodyLines, diffLines, type BodyNode } from "../src/store/body";

let n = 0;
const newId = () => `b${++n}`;
const fromMarkdown = (md: string) => applyOpsToBody([], [{ op: "replace_content", content: md }], newId);

describe("bodyLines", () => {
  it("round-trips canonical markdown through a body", () => {
    const md = [
      "# Plan",
      "Some prose.",
      "- one",
      "  - nested",
      "    - deeper",
      "- [ ] open",
      "- [x] done",
      "1. first",
      "> quoted",
      "---",
      "```",
      "const x = 1;",
      "```",
      "| a | b |",
      "| --- | --- |",
      "| 1 | 2 |",
      "![shot](https://x/y.png)",
    ];
    expect(bodyLines(fromMarkdown(md.join("\n")))).toEqual(md);
  });
});

describe("applyOpsToBody", () => {
  const body = fromMarkdown("- a\n  - a1\n- b\n- c");
  const id = (text: string) => body.find((x) => x.content.text === text)!.id;

  it("never mutates the body it was given", () => {
    const copy = structuredClone(body);
    applyOpsToBody(body, [{ op: "update", id: id("a"), content: { text: "A" } }, { op: "delete", id: id("b") }], newId);
    expect(body).toEqual(copy);
  });

  it("inserts after an anchor, between it and its next sibling", () => {
    const out = applyOpsToBody(body, [{ op: "insert", after: id("a"), type: "bullet", content: { text: "a½" } }], newId);
    expect(bodyLines(out)).toEqual(["- a", "  - a1", "- a½", "- b", "- c"]);
  });

  it("deletes a block with everything nested under it", () => {
    expect(bodyLines(applyOpsToBody(body, [{ op: "delete", id: id("a") }], newId))).toEqual(["- b", "- c"]);
  });

  it("moves a block under another, and refuses to move one inside itself", () => {
    const moved = applyOpsToBody(body, [{ op: "move", id: id("c"), parent: id("a"), after: id("a1") }], newId);
    expect(bodyLines(moved)).toEqual(["- a", "  - a1", "  - c", "- b"]);
    expect(() => applyOpsToBody(body, [{ op: "move", id: id("a"), parent: id("a1") }], newId)).toThrow(/inside itself/);
  });

  it("applies every op or throws before any of them count", () => {
    const ops = [{ op: "update" as const, id: id("a"), content: { text: "A" } }, { op: "delete" as const, id: "missing" }];
    expect(() => applyOpsToBody(body, ops, newId)).toThrow(/not on this note/);
  });
});

describe("diffLines", () => {
  it("marks a changed line as a deletion then an addition, keeping the rest", () => {
    expect(diffLines(["a", "b", "c"], ["a", "B", "c"])).toEqual([
      { kind: "same", text: "a" }, { kind: "del", text: "b" }, { kind: "add", text: "B" }, { kind: "same", text: "c" },
    ]);
  });

  it("finds the longest run in common, not just the first match", () => {
    const d = diffLines(["x", "a", "b", "c"], ["a", "b", "c", "x"]);
    expect(d.filter((l) => l.kind === "same").map((l) => l.text)).toEqual(["a", "b", "c"]);
  });

  it("handles empty sides", () => {
    expect(diffLines([], ["a"])).toEqual([{ kind: "add", text: "a" }]);
    expect(diffLines(["a"], [])).toEqual([{ kind: "del", text: "a" }]);
    expect(diffLines([], [])).toEqual([]);
  });
});

describe("a body with a dangling parent", () => {
  it("still shows the orphan rather than dropping it", () => {
    const orphan: BodyNode[] = [{ id: "x", parent_block_id: "gone", type: "paragraph", content: { text: "orphan" }, position: 1 }];
    expect(bodyLines(orphan)).toEqual(["orphan"]);
  });
});
