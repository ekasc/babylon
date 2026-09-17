import type { ChatItem } from "../store";

export interface TurnFold {
  start: number;
  end: number;
  turnId: string;
  label: string;
  hiddenCount: number;
  /** Index of the terminal (visible) assistant reply in this turn. */
  terminalIdx: number;
}

/** One-line ledger of a turn's tool work ("3 reads · 2 edits · 1 command"). */
export function summarizeTurnTools(tools: Array<Extract<ChatItem, { kind: "tool" }>>): string {
  const readFiles = new Set<string>();
  const editedFiles = new Set<string>();
  let readOps = 0;
  let editOps = 0;
  let commands = 0;
  let other = 0;
  for (const t of tools) {
    const details: any = (t as any).details;
    const args: any = (t as any).args;
    const hasPatch = typeof details?.patch === "string" && details.patch.trim().length > 0;
    const name = (t.name ?? "").toLowerCase();
    const filePath: string | null =
      (typeof args?.file_path === "string" && args.file_path) ||
      (typeof args?.path === "string" && args.path) ||
      (typeof details?.file === "string" && details.file) ||
      null;
    if (hasPatch || name.includes("edit") || name.includes("write")) {
      editOps++;
      if (filePath) editedFiles.add(filePath);
    } else if (name === "bash" || name.includes("bash") || name.includes("shell") || name.includes("command")) {
      commands++;
    } else if (name.includes("read") || name.includes("grep") || name.includes("glob")) {
      readOps++;
      if (filePath) readFiles.add(filePath);
    } else {
      other++;
    }
  }
  const reads = readFiles.size || readOps;
  const edits = editedFiles.size || editOps;
  const parts: string[] = [];
  if (reads) parts.push(`${reads} read${reads === 1 ? "" : "s"}`);
  if (edits) parts.push(`${edits} edit${edits === 1 ? "" : "s"}`);
  if (commands) parts.push(`${commands} command${commands === 1 ? "" : "s"}`);
  if (other) parts.push(`${other} tool${other === 1 ? "" : "s"}`);
  if (parts.length === 0) return "Used tools";
  return parts.join(" \u00B7 ");
}

/**
 * Per-turn folding. A turn is the span from a user message to the next user
 * message. The terminal (last) assistant reply is the answer and stays
 * visible; every other item is "work" and folds, with NO minimum count, so a
 * single tool call or a lone reasoning step folds too. This applies to the
 * live turn as well: nothing is expanded by default while the agent runs.
 */
export function buildTurnFolds(
  shown: ChatItem[],
  userIndices: number[],
  hasCard: (index: number) => boolean
): Map<number, TurnFold> {
  const map = new Map<number, TurnFold>();
  for (let t = 0; t < userIndices.length; t++) {
    const start = userIndices[t];
    const end = t + 1 < userIndices.length ? userIndices[t + 1] : shown.length;

    const hasAssistant = shown.slice(start + 1, end).some((it) => it.kind === "assistant");
    if (!hasAssistant) continue;

    let terminalIdx = -1;
    for (let i = start + 1; i < end; i++) if (shown[i]?.kind === "assistant") terminalIdx = i;

    const hiddenItems = shown.slice(start + 1, end).filter((_, i) => {
      const idx = start + 1 + i;
      return idx !== terminalIdx && !hasCard(idx);
    });

    // The terminal reply is the answer and stays visible, but its reasoning
    // block is work: it is hidden while the turn is collapsed, so a
    // reasoning-only turn still needs a fold (to reveal the trace on expand).
    const terminal = terminalIdx >= 0 ? shown[terminalIdx] : undefined;
    const hasReasoning =
      terminal?.kind === "assistant" && terminal.blocks.some((b) => b.type === "thinking");
    if (hiddenItems.length < 1 && !hasReasoning) continue;

    const tools = hiddenItems.filter((it) => it.kind === "tool") as Array<Extract<ChatItem, { kind: "tool" }>>;
    const userItem = shown[start] as Extract<ChatItem, { kind: "user" }>;
    const turnId = userItem.entryId ?? userItem.key;
    if (!turnId) continue;

    const label = tools.length
      ? summarizeTurnTools(tools)
      : hiddenItems.some((it) => it.kind === "assistant") || hasReasoning
        ? "Reasoning"
        : `${hiddenItems.length} step${hiddenItems.length === 1 ? "" : "s"}`;

    map.set(start, { start, end, turnId, label, hiddenCount: hiddenItems.length, terminalIdx });
  }
  return map;
}
