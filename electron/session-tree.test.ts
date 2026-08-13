import { describe, expect, it } from "vitest";
import { flattenSessionTree } from "./session-tree";

describe("flattenSessionTree", () => {
  it("flattens sessions deeper than the contextBridge recursion limit", () => {
    const root: any = {
      entry: { id: "0", parentId: null, type: "message", message: { role: "user", content: "start" } },
      children: [],
    };
    let node = root;
    for (let index = 1; index < 1500; index++) {
      const child = {
        entry: { id: String(index), parentId: String(index - 1), type: "message", message: { role: "assistant", content: `reply ${index}` } },
        children: [],
      };
      node.children.push(child);
      node = child;
    }
    const rows = flattenSessionTree([root]);
    expect(rows).toHaveLength(1500);
    expect(rows[1499]).toMatchObject({ id: "1499", parentId: "1498", depth: 1499, snippet: "reply 1499" });
  });

  it("preserves branch counts and traversal order", () => {
    const rows = flattenSessionTree([{
      entry: { id: "root", parentId: null, type: "message", message: { role: "user", content: "root" } },
      children: [
        { entry: { id: "a", parentId: "root", type: "message", message: { role: "assistant", content: "a" } }, children: [] },
        { entry: { id: "b", parentId: "root", type: "message", message: { role: "assistant", content: "b" } }, children: [] },
      ],
    }]);
    expect(rows.map((row) => row.id)).toEqual(["root", "a", "b"]);
    expect(rows[0].childCount).toBe(2);
  });
});
