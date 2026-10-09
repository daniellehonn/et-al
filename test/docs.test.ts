// The docs are part of the interface agents are given, so they are tested like it.
import { describe, expect, it } from "vitest";
import mcpDoc from "../docs/MCP.md?raw";
import { rpc } from "./helpers";

describe("docs/MCP.md", () => {
  it("documents every tool the server offers, and no tool it doesn't", async () => {
    const { result } = await rpc("tools/list");
    const offered: string[] = result.tools.map((t: { name: string }) => t.name).sort();
    const documented = [...mcpDoc.matchAll(/^### `([a-z_]+)`$/gm)].map((m) => m[1]).sort();
    expect(documented).toEqual(offered);
  });
});
