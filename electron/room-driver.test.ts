import { describe, expect, it } from "vitest";
import { driveRoomTurns, type RoomTurnIO } from "./room-driver";
import type { Bot } from "../src/bots";

function bot(id: string, name: string): Bot {
  return { id, name, createdAt: 0, updatedAt: 0 };
}

/** Scripted IO: per-handle reply queues; prompt throws when flagged. */
function scripted(replies: Record<string, string[]>, opts?: { throwOn?: string[] }) {
  const calls: string[] = [];
  const events: string[] = [];
  const remaining: Record<string, string[]> = Object.fromEntries(
    Object.entries(replies).map(([k, v]) => [k, [...v]])
  );
  const io: RoomTurnIO = {
    prompt: async (text) => {
      const m = /@([a-z0-9-]+)/i.exec(text);
      const handle = m?.[1] ?? "?";
      calls.push(handle);
      if (opts?.throwOn?.includes(handle)) throw new Error("aborted");
    },
    readReply: async () => {
      const last = calls[calls.length - 1]!;
      return remaining[last]?.shift() ?? "PASS";
    },
    emit: (ev) => {
      events.push(`${(ev.handle as string) ?? "-"}:${ev.phase}`);
    },
  };
  return { calls, events, io };
}

const members = [bot("a", "Alpha"), bot("b", "Beta"), bot("c", "Gamma")];

describe("babylon room driver", () => {
  it("pulls a named outsider into an addressed room", async () => {
    // Addressed room (order=[alpha]); alpha names Gamma, who is not queued.
    const { calls, io } = scripted({ alpha: ["@gamma take it"], gamma: ["on it"] });
    const res = await driveRoomTurns({ groupId: "g", members, order: [members[0]], io, maxTurns: 6 });
    expect(calls.slice(0, 2)).toEqual(["alpha", "gamma"]);
    expect(res.spoke).toBe(2);
  });

  it("does not duplicate a named member who is already queued", async () => {
    const { calls, io } = scripted({ alpha: ["@gamma take it"], beta: ["PASS"], gamma: ["on it"] });
    const res = await driveRoomTurns({ groupId: "g", members, order: members, io, maxTurns: 6 });
    // Gamma was already next-next; naming changes nothing, no duplicate turn.
    expect(calls.slice(0, 3)).toEqual(["alpha", "beta", "gamma"]);
    expect(res.spoke).toBe(2);
  });

  it("skips members who passed with nothing new since", async () => {
    const { calls, io } = scripted({ alpha: ["hello"], beta: ["PASS"], gamma: ["PASS"] });
    const res = await driveRoomTurns({ groupId: "g", members, order: members, io });
    // Round 1 asks all three; round 2 re-asks only Alpha (others stayed quiet).
    expect(calls).toEqual(["alpha", "beta", "gamma", "alpha"]);
    expect(res).toMatchObject({ turns: 4, spoke: 1 });
  });

  it("settles an all-quiet room without a second round", async () => {
    const { calls, io } = scripted({});
    const res = await driveRoomTurns({ groupId: "g", members, order: members, io });
    expect(calls).toEqual(["alpha", "beta", "gamma"]);
    expect(res).toMatchObject({ rounds: 1, turns: 3, spoke: 0, stopped: false });
  });

  it("bounds ping-pong loops by the turn cap", async () => {
    const repeat = (s: string) => [s, s, s, s, s, s];
    const { calls, io } = scripted({ alpha: repeat("@beta go"), beta: repeat("@alpha go"), gamma: ["PASS"] });
    const res = await driveRoomTurns({ groupId: "g", members, order: members, io, maxTurns: 6 });
    expect(calls).toEqual(["alpha", "beta", "alpha", "beta", "alpha", "beta"]);
    expect(res.turns).toBe(6);
    expect(res.stopped).toBe(false);
  });

  it("stops cleanly when a turn fails", async () => {
    const { calls, io } = scripted({ alpha: ["hi"] }, { throwOn: ["beta"] });
    const res = await driveRoomTurns({ groupId: "g", members, order: members, io });
    expect(calls).toEqual(["alpha", "beta"]);
    expect(res).toMatchObject({ turns: 1, stopped: true });
  });

  it("an explicit mention overrides a quiet streak", async () => {
    // Beta passes in round 1; Alpha later names Beta → Beta speaks again.
    const { calls, io } = scripted({
      alpha: ["noted", "@beta your call"],
      beta: ["PASS", "fine, I'll take it"],
      gamma: ["PASS"],
    });
    const res = await driveRoomTurns({ groupId: "g", members, order: members, io, maxTurns: 5 });
    expect(calls).toEqual(["alpha", "beta", "gamma", "alpha", "beta"]);
    expect(res.spoke).toBe(3);
  });
});
