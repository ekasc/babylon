import { describe, expect, it } from "vitest";
import {
  addNode,
  createGraph,
  createNode,
  getAncestors,
  getDescendants,
  getNode,
  isLeaf,
  listByOwner,
  listByStatus,
  listChildren,
  listNodes,
  removeNode,
  updateNode,
} from "./subagent-graph";

describe("structured subagent graph", () => {
  it("adds a root node and a child", () => {
    let g = createGraph();
    g = addNode(g, createNode({ id: "a", goal: "research", model: "opus", owner: "main" }));
    g = addNode(g, createNode({ id: "b", goal: "db scout", model: "haiku", owner: "a", parentId: "a" }));
    expect(listNodes(g)).toHaveLength(2);
    expect(listChildren(g, "a").map((n) => n.id)).toEqual(["b"]);
    expect(getAncestors(g, "b").map((n) => n.id)).toEqual(["a"]);
  });

  it("refuses to overwrite an existing id", () => {
    let g = createGraph();
    g = addNode(g, createNode({ id: "a", goal: "one", model: "opus", owner: "main" }));
    const again = addNode(g, createNode({ id: "a", goal: "two", model: "opus", owner: "main" }));
    expect(again).toBe(g);
    expect(getNode(again, "a")!.goal).toBe("one");
  });

  it("refuses a child whose parent does not exist", () => {
    let g = createGraph();
    const next = addNode(g, createNode({ id: "b", goal: "orphan", model: "haiku", owner: "main", parentId: "missing" }));
    expect(next).toBe(g);
    expect(listNodes(next)).toHaveLength(0);
  });

  it("returns copies so caller mutation cannot corrupt the graph", () => {
    let g = createGraph();
    g = addNode(g, createNode({ id: "a", goal: "x", model: "opus", owner: "main" }));
    const fetched = getNode(g, "a")!;
    (fetched as any).goal = "tampered";
    expect(getNode(g, "a")!.goal).toBe("x");
    const listed = listNodes(g);
    listed[0].goal = "tampered";
    expect(getNode(g, "a")!.goal).toBe("x");
  });

  it("updates status and result and bumps updatedAt", () => {
    let g = createGraph();
    g = addNode(g, createNode({ id: "a", goal: "impl", model: "sonnet", owner: "main", createdAt: 1000 }));
    const before = getNode(g, "a")!.updatedAt;
    g = updateNode(g, "a", { status: "running" });
    expect(getNode(g, "a")!.status).toBe("running");
    expect(getNode(g, "a")!.updatedAt).toBeGreaterThanOrEqual(before);
    g = updateNode(g, "a", { result: "done", summary: "finished backend" });
    expect(getNode(g, "a")!.result).toBe("done");
    expect(getNode(g, "a")!.summary).toBe("finished backend");
  });

  it("does not allow changing parentId via update", () => {
    let g = createGraph();
    g = addNode(g, createNode({ id: "a", goal: "root", model: "opus", owner: "main" }));
    g = addNode(g, createNode({ id: "b", goal: "child", model: "haiku", owner: "main", parentId: "a" }));
    const next = updateNode(g, "b", { parentId: null } as any);
    expect(next).toBe(g);
    expect(getNode(g, "b")!.parentId).toBe("a");
  });

  it("refuses to remove a node that still has children", () => {
    let g = createGraph();
    g = addNode(g, createNode({ id: "a", goal: "root", model: "opus", owner: "main" }));
    g = addNode(g, createNode({ id: "b", goal: "child", model: "haiku", owner: "main", parentId: "a" }));
    expect(removeNode(g, "a")).toBe(g);
    let h = removeNode(g, "b");
    expect(getNode(h, "b")).toBeUndefined();
    h = removeNode(h, "a");
    expect(getNode(h, "a")).toBeUndefined();
  });

  it("is no-op for missing ids on update and remove", () => {
    const g = createGraph();
    expect(updateNode(g, "missing", { status: "completed" })).toBe(g);
    expect(removeNode(g, "missing")).toBe(g);
  });

  it("lists by status and by owner", () => {
    let g = createGraph();
    g = addNode(g, createNode({ id: "a", goal: "r", model: "opus", owner: "alice", status: "running" }));
    g = addNode(g, createNode({ id: "b", goal: "s", model: "haiku", owner: "bob", status: "pending" }));
    g = addNode(g, createNode({ id: "c", goal: "t", model: "haiku", owner: "alice", status: "running" }));
    expect(listByStatus(g, "running").map((n) => n.id).sort()).toEqual(["a", "c"]);
    expect(listByOwner(g, "alice").map((n) => n.id).sort()).toEqual(["a", "c"]);
  });

  it("tracks bounded vs persistent and worktree isolation", () => {
    let g = createGraph();
    g = addNode(g, createNode({ id: "a", goal: "bounded", model: "haiku", owner: "main", kind: "bounded", worktreeId: "wt-a" }));
    g = addNode(g, createNode({ id: "b", goal: "persistent", model: "opus", owner: "main", kind: "persistent" }));
    expect(getNode(g, "a")!.kind).toBe("bounded");
    expect(getNode(g, "a")!.worktreeId).toBe("wt-a");
    expect(getNode(g, "b")!.kind).toBe("persistent");
    expect(isLeaf(g, "a")).toBe(true);
  });

  it("returns descendants recursively and ancestors in order", () => {
    let g = createGraph();
    g = addNode(g, createNode({ id: "a", goal: "root", model: "opus", owner: "main" }));
    g = addNode(g, createNode({ id: "b", goal: "mid", model: "haiku", owner: "main", parentId: "a" }));
    g = addNode(g, createNode({ id: "c", goal: "leaf", model: "haiku", owner: "main", parentId: "b" }));
    expect(getDescendants(g, "a").map((n) => n.id).sort()).toEqual(["b", "c"]);
    expect(getAncestors(g, "c").map((n) => n.id)).toEqual(["b", "a"]);
    expect(isLeaf(g, "c")).toBe(true);
    expect(isLeaf(g, "b")).toBe(false);
  });

  it("summary stays separate from full result", () => {
    let g = createGraph();
    g = addNode(g, createNode({ id: "a", goal: "review", model: "sonnet", owner: "main" }));
    g = updateNode(g, "a", { result: "full transcript with 200 lines", summary: "review passed with 2 nits" });
    expect(getNode(g, "a")!.summary).toBe("review passed with 2 nits");
    expect(getNode(g, "a")!.result).toBe("full transcript with 200 lines");
  });
});
