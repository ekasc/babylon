import * as Effect from "effect/Effect";
import { pinOrderKeyBetween, planPinnedMove, planPinnedReorder } from "./pinOrder";

export const pinOrderKeyBetweenEffect = (
  before: string | null,
  after: string | null,
): Effect.Effect<string | null> => Effect.sync(() => pinOrderKeyBetween(before, after));

export const planPinnedReorderEffect = (input: {
  readonly orderedIds: readonly string[];
  readonly keysById: ReadonlyMap<string, string | null | undefined>;
  readonly movedId: string;
}): Effect.Effect<ReadonlyArray<{ readonly id: string; readonly orderKey: string }>> =>
  Effect.sync(() => planPinnedReorder(input));

export const planPinnedMoveEffect = (input: {
  readonly orderedIds: readonly string[];
  readonly keysById: ReadonlyMap<string, string | null | undefined>;
  readonly movedId: string;
  readonly direction: "up" | "down";
}): Effect.Effect<ReadonlyArray<{ readonly id: string; readonly orderKey: string }> | null> =>
  Effect.sync(() => planPinnedMove(input));
