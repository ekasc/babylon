// @vitest-environment jsdom
// The room-open path: a created room was previously unreachable because
// BotsManager had no open handler wired. This pins that clicking a room's
// "Open room" calls onOpenGroup with that room.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import BotsManager from "./BotsManager";
import type { Bot, BotGroup } from "../bots";

afterEach(cleanup);

const bots: Bot[] = [
  { id: "a", name: "Brain", title: "Planner", createdAt: 1, updatedAt: 1 },
  { id: "b", name: "Hands", title: "Builder", createdAt: 1, updatedAt: 1 },
];

const group: BotGroup = {
  id: "g1",
  name: "Release crew",
  memberIds: ["a", "b"],
  createdAt: 1,
  updatedAt: 1,
};

function renderManager(onOpenGroup: (g: BotGroup) => void) {
  return render(
    <BotsManager
      bots={bots}
      activeBotId={null}
      groups={[group]}
      activeGroupId={null}
      onCreate={async () => undefined}
      onUpdate={async () => undefined}
      onDelete={async () => undefined}
      onOpenGroup={onOpenGroup}
    />
  );
}

describe("BotsManager room open", () => {
  it("opens the room from the selected room editor", () => {
    const onOpenGroup = vi.fn();
    renderManager(onOpenGroup);
    // Select the room in the roster, then open it from its editor.
    fireEvent.click(screen.getByText("Release crew"));
    fireEvent.click(screen.getByText("Open room"));
    expect(onOpenGroup).toHaveBeenCalledTimes(1);
    expect(onOpenGroup.mock.calls[0]?.[0]).toEqual(group);
  });

  it("hides the open affordance for a brand-new room", () => {
    renderManager(vi.fn());
    fireEvent.click(screen.getByRole("button", { name: "New room" }));
    expect(screen.queryByRole("button", { name: "Open room" })).toBeNull();
  });
});
