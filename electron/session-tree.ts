import { wireOf, wireStr } from "../src/store";

export interface SessionTreeRow {
  id: string;
  parentId: string | null;
  type: string;
  role?: string;
  snippet: string;
  label?: string;
  depth: number;
  childCount: number;
}

export interface SourceNode {
  entry?: unknown;
  children?: SourceNode[];
  label?: string;
}

function messageSnippet(entry: unknown): string {
  const message = wireOf(wireOf(entry)?.message);
  if (!message) return "";
  const content = message.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((block) => {
              if (typeof block === "string") return block;
              const b = wireOf(block);
              return b?.type === "thinking" ? "" : (wireStr(b, "text") ?? "");
            })
            .join(" ")
        : "";
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 100 ? `${oneLine.slice(0, 99)}…` : oneLine;
}

/**
 * Convert the SDK's recursively nested tree into a small, flat IPC payload.
 * Long linear sessions can exceed Electron contextBridge's recursion limit,
 * and the tree UI never needs tool details or full message bodies.
 */
export function flattenSessionTree(roots: SourceNode[]): SessionTreeRow[] {
  const rows: SessionTreeRow[] = [];
  const stack = roots
    .slice()
    .reverse()
    .map((node) => ({ node, depth: 0 }));

  while (stack.length) {
    const { node, depth } = stack.pop()!;
    const entry = wireOf(node.entry);
    const children = Array.isArray(node.children) ? node.children : [];
    if (entry && typeof entry.id === "string") {
      rows.push({
        id: entry.id,
        parentId: typeof entry.parentId === "string" ? entry.parentId : null,
        type: typeof entry.type === "string" ? entry.type : "unknown",
        role: wireStr(wireOf(entry.message), "role"),
        snippet: messageSnippet(entry),
        label: typeof node.label === "string" ? node.label : undefined,
        depth,
        childCount: children.length,
      });
    }
    const childDepth = depth + (entry?.type === "message" ? 1 : 0);
    for (let index = children.length - 1; index >= 0; index--) {
      const child = children[index];
      if (child === undefined) continue;
      stack.push({ node: child, depth: childDepth });
    }
  }
  return rows;
}
