// Serial room-turn driver, extracted for testability. The single runtime
// means member turns run one at a time in the shared room session; this
// module owns the order, quiet-skipping, mention routing, and caps while
// main.ts supplies the real prompt/read/emit IO.
import { botHandle, isPassReply, mentionedMembers, roomTurnPrompt, type Bot } from "../src/bots";

export interface RoomTurnIO {
  prompt(text: string): Promise<void>;
  readReply(): Promise<string>;
  emit(ev: Record<string, unknown>): void;
}

export interface RoomDriveResult {
  rounds: number;
  turns: number;
  spoke: number;
  stopped: boolean;
}

/**
 * Drive serial member turns. Opening order is `order`; a spoke turn naming
 * @someone jumps them to the front (explicit mention overrides quiet);
 * members who passed with no intervening speech are skipped without a call.
 * A drained queue refills for the next round; an all-quiet drain settles.
 */
export async function driveRoomTurns(opts: {
  groupId: string;
  members: Bot[];
  order: Bot[];
  io: RoomTurnIO;
  maxRounds?: number;
  maxTurns?: number;
}): Promise<RoomDriveResult> {
  const { groupId, members, order, io } = opts;
  const MAX_ROUNDS = opts.maxRounds ?? 3;
  const MAX_TURNS = opts.maxTurns ?? 10;
  let rounds = 0;
  let turns = 0;
  let spoke = 0;
  let stopped = false;
  const quietSince = new Set<string>();
  let pending = [...order];
  while (pending.length > 0 && turns < MAX_TURNS && rounds < MAX_ROUNDS && !stopped) {
    const member = pending.shift()!;
    if (quietSince.has(member.id)) continue; // already passed, nothing new since
    const handle = botHandle(member);
    io.emit({ type: "babylon_room_turn", groupId, handle, phase: "started" });
    let reply = "";
    try {
      await io.prompt(roomTurnPrompt(handle));
    } catch {
      stopped = true;
      io.emit({ type: "babylon_room_turn", groupId, handle, phase: "stopped" });
      break;
    }
    turns++;
    try {
      reply = await io.readReply();
    } catch {
      reply = "";
    }
    if (!isPassReply(reply)) {
      spoke++;
      quietSince.clear();
      io.emit({ type: "babylon_room_turn", groupId, handle, phase: "replied" });
      // Named members speak next (roster order, no duplicates, never self).
      const routed = mentionedMembers(members, member.id, reply).filter(
        (m) => !pending.some((p) => p.id === m.id)
      );
      for (const m of routed) quietSince.delete(m.id);
      pending = [...routed, ...pending];
    } else {
      quietSince.add(member.id);
      io.emit({ type: "babylon_room_turn", groupId, handle, phase: "passed" });
    }
    if (pending.length === 0) {
      rounds++;
      if (rounds >= MAX_ROUNDS) break;
      pending = order.filter((m) => !quietSince.has(m.id));
    }
  }
  io.emit({ type: "babylon_room_turn", groupId, phase: "settled" });
  return { rounds, turns, spoke, stopped };
}
