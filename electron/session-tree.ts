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

interface SourceNode {
  entry?: any;
  children?: SourceNode[];
  label?: string;
}

function messageSnippet(entry: any): string {
  const message = entry?.message;
  if (!message) return "";
  const content = message.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((block: any) =>
              typeof block === "string" ? block : block?.type === "thinking" ? "" : (block?.text ?? "")
            )
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
    const entry = node.entry;
    const children = Array.isArray(node.children) ? node.children : [];
    if (entry && typeof entry.id === "string") {
      rows.push({
        id: entry.id,
        parentId: typeof entry.parentId === "string" ? entry.parentId : null,
        type: typeof entry.type === "string" ? entry.type : "unknown",
        role: typeof entry.message?.role === "string" ? entry.message.role : undefined,
        snippet: messageSnippet(entry),
        label: typeof node.label === "string" ? node.label : undefined,
        depth,
        childCount: children.length,
      });
    }
    const childDepth = depth + (entry?.type === "message" ? 1 : 0);
    for (let index = children.length - 1; index >= 0; index--) {
      stack.push({ node: children[index], depth: childDepth });
    }
  }
  return rows;
}
