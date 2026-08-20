// Structured subagent graph for Phase 4, Feature 8.
//
// Parent/child relationships are explicit, each node tracks goal, state, model,
// owner, and result, and worktree isolation is represented. Summaries keep the
// parent transcript small while full transcripts stay inspectable via the stored
// result field.

export type SubagentStatus = "pending" | "running" | "completed" | "failed" | "blocked" | "cancelled";
export type SubagentKind = "bounded" | "persistent";

export interface SubagentNode {
  id: string;
  parentId: string | null;
  goal: string;
  status: SubagentStatus;
  model: string;
  owner: string;
  kind: SubagentKind;
  result: string | null;
  summary: string | null;
  worktreeId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface SubagentGraph {
  nodes: Record<string, SubagentNode>;
}

export function createGraph(): SubagentGraph {
  return { nodes: {} };
}

export function createNode(params: {
  id: string;
  goal: string;
  model: string;
  owner: string;
  parentId?: string | null;
  kind?: SubagentKind;
  worktreeId?: string | null;
  status?: SubagentStatus;
  createdAt?: number;
}): SubagentNode {
  return {
    id: params.id,
    parentId: params.parentId ?? null,
    goal: params.goal,
    status: params.status ?? "pending",
    model: params.model,
    owner: params.owner,
    kind: params.kind ?? "bounded",
    result: null,
    summary: null,
    worktreeId: params.worktreeId ?? null,
    createdAt: params.createdAt ?? Date.now(),
    updatedAt: params.createdAt ?? Date.now(),
  };
}

function cloneNode(n: SubagentNode): SubagentNode {
  return { ...n };
}

export function addNode(graph: SubagentGraph, node: SubagentNode): SubagentGraph {
  if (!node.id || graph.nodes[node.id]) return graph;
  if (node.parentId !== null && !graph.nodes[node.parentId]) return graph;
  return { nodes: { ...graph.nodes, [node.id]: cloneNode(node) } };
}

export function updateNode(
  graph: SubagentGraph,
  id: string,
  patch: Partial<Omit<SubagentNode, "id" | "createdAt">>
): SubagentGraph {
  const existing = graph.nodes[id];
  if (!existing) return graph;
  if ((patch as { parentId?: unknown }).parentId !== undefined) return graph;
  if (Object.keys(patch).length === 0) return graph;
  const next: SubagentNode = { ...existing, ...patch, id: existing.id, parentId: existing.parentId, createdAt: existing.createdAt };
  next.updatedAt = Date.now();
  return { nodes: { ...graph.nodes, [id]: next } };
}

export function removeNode(graph: SubagentGraph, id: string): SubagentGraph {
  if (!graph.nodes[id]) return graph;
  const hasChildren = Object.values(graph.nodes).some((n) => n.parentId === id);
  if (hasChildren) return graph;
  const next = { ...graph.nodes };
  delete next[id];
  return { nodes: next };
}

export function getNode(graph: SubagentGraph, id: string): SubagentNode | undefined {
  const n = graph.nodes[id];
  return n ? cloneNode(n) : undefined;
}

export function listNodes(graph: SubagentGraph): SubagentNode[] {
  return Object.values(graph.nodes).map(cloneNode);
}

export function listChildren(graph: SubagentGraph, parentId: string): SubagentNode[] {
  return Object.values(graph.nodes)
    .filter((n) => n.parentId === parentId)
    .map(cloneNode);
}

export function listByStatus(graph: SubagentGraph, status: SubagentStatus): SubagentNode[] {
  return Object.values(graph.nodes)
    .filter((n) => n.status === status)
    .map(cloneNode);
}

export function listByOwner(graph: SubagentGraph, owner: string): SubagentNode[] {
  return Object.values(graph.nodes)
    .filter((n) => n.owner === owner)
    .map(cloneNode);
}

export function isLeaf(graph: SubagentGraph, id: string): boolean {
  if (!graph.nodes[id]) return false;
  return !Object.values(graph.nodes).some((n) => n.parentId === id);
}

export function getAncestors(graph: SubagentGraph, id: string): SubagentNode[] {
  const out: SubagentNode[] = [];
  let cur = graph.nodes[id];
  while (cur?.parentId) {
    const parent = graph.nodes[cur.parentId];
    if (!parent) break;
    out.push(cloneNode(parent));
    cur = parent;
  }
  return out;
}

export function getDescendants(graph: SubagentGraph, id: string): SubagentNode[] {
  const out: SubagentNode[] = [];
  const visit = (pid: string) => {
    for (const n of Object.values(graph.nodes)) {
      if (n.parentId === pid) {
        out.push(cloneNode(n));
        visit(n.id);
      }
    }
  };
  if (!graph.nodes[id]) return out;
  visit(id);
  return out;
}
