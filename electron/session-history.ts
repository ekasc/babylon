import type { ActiveRollback, TurnCheckpoint, TurnReceipt } from "./rollback-store";
import { missingCheckpointReason } from "./rollback-store";
import { isBookkeepingPath } from "./snapshot-store";
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

export function activePathFromIndex(byId: Map<string, SessionTreeRow>, leafId: string | null): Set<string> {
  const path = new Set<string>();
  let current = leafId ? byId.get(leafId) : undefined;
  while (current && !path.has(current.id)) {
    path.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path;
}

export function activePath(rows: SessionTreeRow[], leafId: string | null): Set<string> {
  return activePathFromIndex(new Map(rows.map((row) => [row.id, row])), leafId);
}

export function projectHistory(input: {
  rows: SessionTreeRow[];
  leafId: string | null;
  checkpoints: TurnCheckpoint[];
  receipts?: TurnReceipt[];
  gitAvailable: boolean;
  streaming: boolean;
  activeRollback?: ActiveRollback;
  undoAvailable?: boolean;
  undoReason?: string;
}): HistoryProjection {
  const { rows, leafId } = input;
  const byId = new Map(rows.map((row) => [row.id, row]));
  const path = activePathFromIndex(byId, leafId);
  const checkpointByUser = new Map(input.checkpoints.map((checkpoint) => [checkpoint.userEntryId, checkpoint]));
  // Single preorder pass (flattenSessionTree emits parents before children),
  // so one iterative sweep resolves nearest-user ancestry, per-user depth,
  // and first-assistant responses with only map lookups — no nested scans.
  // Semantics preserved exactly:
  // - any row with role "user" is an ancestry boundary (even non-messages),
  //   but only type "message" users become turns;
  // - depth counts user-role nodes from the nearest user ancestor up;
  // - the FIRST assistant child in row order wins the response snippet.
  const nearestUser = new Map<string, { id: string; depth: number }>();
  const responseByUser = new Map<string, string>();
  const users: { row: SessionTreeRow; parentUserEntryId: string | null; depth: number }[] = [];
  for (const row of rows) {
    const parentUser = row.parentId ? nearestUser.get(row.parentId) : undefined;
    if (row.role === "assistant" && row.parentId && !responseByUser.has(row.parentId)) {
      responseByUser.set(row.parentId, row.snippet);
    }
    if (row.role === "user") {
      const depth = parentUser ? parentUser.depth + 1 : 0;
      nearestUser.set(row.id, { id: row.id, depth });
      if (row.type === "message") {
        users.push({ row, parentUserEntryId: parentUser?.id ?? null, depth });
      }
    } else if (parentUser) {
      nearestUser.set(row.id, parentUser);
    }
  }
  const raw = users.map((turn) => ({ ...turn, response: responseByUser.get(turn.row.id) ?? "" }));
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
    else if (!checkpoint) rollbackReason = missingCheckpointReason(input.receipts, row.id);
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
      // Bookkeeping-only turns read as zero: the engine's own `.pi/state`
      // logs are hidden from turn diffs, so a read-only turn with tool calls
      // shows no card (legacy checkpoints included).
      changedCount: checkpoint?.complete
        ? checkpoint.changedPaths.filter((path) => !isBookkeepingPath(path)).length
        : 0,
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
