import type { ActiveRollback, TurnCheckpoint } from "./rollback-store";
import type { SessionTreeRow } from "./session-tree";

export interface HistoryTurn {
  entryId: string;
  parentUserEntryId: string | null;
  index: number;
  depth: number;
  text: string;
  response: string;
  onActivePath: boolean;
  current: boolean;
  branchCount: number;
  changedCount: number;
  checkpointAvailable: boolean;
  rollbackAvailable: boolean;
  rollbackReason?: string;
}

export interface HistoryProjection {
  turns: HistoryTurn[];
  leafId: string | null;
  hasBranches: boolean;
  activeRollback?: {
    targetUserEntryId: string;
    abandonedCount: number;
    fileCount: number;
    editorText: string;
    createdAt: string;
    undoAvailable: boolean;
    undoReason?: string;
  };
}

export function activePath(rows: SessionTreeRow[], leafId: string | null): Set<string> {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const path = new Set<string>();
  let current = leafId ? byId.get(leafId) : undefined;
  while (current && !path.has(current.id)) {
    path.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path;
}

export function projectHistory(input: {
  rows: SessionTreeRow[];
  leafId: string | null;
  checkpoints: TurnCheckpoint[];
  gitAvailable: boolean;
  streaming: boolean;
  activeRollback?: ActiveRollback;
  undoAvailable?: boolean;
  undoReason?: string;
}): HistoryProjection {
  const { rows, leafId } = input;
  const byId = new Map(rows.map((row) => [row.id, row]));
  const path = activePath(rows, leafId);
  const checkpointByUser = new Map(input.checkpoints.map((checkpoint) => [checkpoint.userEntryId, checkpoint]));
  const raw = rows
    .filter((row) => row.type === "message" && row.role === "user")
    .map((row) => {
      let parent = row.parentId ? byId.get(row.parentId) : undefined;
      while (parent && parent.role !== "user") parent = parent.parentId ? byId.get(parent.parentId) : undefined;
      let depth = 0;
      let ancestor = parent;
      while (ancestor) {
        depth++;
        let next = ancestor.parentId ? byId.get(ancestor.parentId) : undefined;
        while (next && next.role !== "user") next = next.parentId ? byId.get(next.parentId) : undefined;
        ancestor = next;
      }
      const response = rows.find((candidate) => candidate.parentId === row.id && candidate.role === "assistant")?.snippet ?? "";
      return { row, parentUserEntryId: parent?.id ?? null, depth, response };
    });
  const children = new Map<string, number>();
  for (const turn of raw) {
    if (turn.parentUserEntryId) children.set(turn.parentUserEntryId, (children.get(turn.parentUserEntryId) ?? 0) + 1);
  }
  let current = leafId ? byId.get(leafId) : undefined;
  while (current && current.role !== "user") current = current.parentId ? byId.get(current.parentId) : undefined;

  const turns = raw.map(({ row, parentUserEntryId, depth, response }, index): HistoryTurn => {
    const checkpoint = checkpointByUser.get(row.id);
    const onActivePath = path.has(row.id);
    let rollbackReason: string | undefined;
    if (input.activeRollback) rollbackReason = "Undo or continue from the active rollback first";
    else if (input.streaming) rollbackReason = "Finish or stop the active response before rolling back";
    else if (!onActivePath) rollbackReason = "This turn is not on the active path";
    else if (!input.gitAvailable) rollbackReason = "Rollback requires a Git project";
    else if (!checkpoint) rollbackReason = "No filesystem checkpoint was recorded for this turn";
    else if (!checkpoint.complete) rollbackReason = "This filesystem checkpoint is incomplete";
    return {
      entryId: row.id,
      parentUserEntryId,
      index: index + 1,
      depth,
      text: row.snippet,
      response,
      onActivePath,
      current: current?.id === row.id,
      branchCount: children.get(row.id) ?? 0,
      changedCount: checkpoint?.complete ? checkpoint.changedPaths.length : 0,
      checkpointAvailable: !!checkpoint?.complete,
      rollbackAvailable: !rollbackReason,
      rollbackReason,
    };
  });

  return {
    turns,
    leafId,
    hasBranches: [...children.values()].some((count) => count > 1),
    activeRollback: input.activeRollback
      ? {
          targetUserEntryId: input.activeRollback.targetUserEntryId,
          abandonedCount: input.activeRollback.abandonedUserEntryIds.length,
          fileCount: input.activeRollback.restoredPaths.length,
          editorText: input.activeRollback.editorText,
          createdAt: input.activeRollback.createdAt,
          undoAvailable: input.undoAvailable ?? false,
          undoReason: input.undoReason,
        }
      : undefined,
  };
}
