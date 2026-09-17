// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import StatsPopover from "./StatsPopover";
import PermissionModePicker from "./PermissionModePicker";
import SettingsThinkingPicker from "./settings/SettingsThinkingPicker";

afterEach(() => cleanup());

/**
 * Consumer contracts for the popovers converged onto ui/Popover (inline
 * mode): Babylon classes and content stay intact, trigger toggles, Escape
 * and outside-press dismiss, actions keep working. The primitive itself is
 * covered by ui/Popover.test.tsx — these pin each caller's wiring.
 */
describe("converged popovers", () => {
  it("StatsPopover opens, compacts, and dismisses", async () => {
    const onCompact = vi.fn();
    const user = userEvent.setup();
    const stats = {
      tokens: { total: 10, input: 6, output: 4 },
      cost: 0.01,
      totalMessages: 2,
      userMessages: 1,
      assistantMessages: 1,
      toolCalls: 0,
      toolResults: 0,
      contextUsage: { tokens: 10, contextWindow: 100, percent: 10 },
    };
    render(<StatsPopover stats={stats} hasSession onCompact={onCompact} />);
    await user.click(screen.getByTitle("Session usage"));
    expect(await screen.findByText("Compact conversation context")).toBeTruthy();
    await user.click(screen.getByText("Compact conversation context"));
    expect(onCompact).toHaveBeenCalledTimes(1);
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByText("Compact conversation context")).toBeNull()
    );
  });

  it("PermissionModePicker lists modes and dismisses on outside press", async () => {
    const user = userEvent.setup();
    render(
      <>
        <button>elsewhere</button>
        <PermissionModePicker />
      </>
    );
    await user.click(screen.getByTitle(/Execution mode/));
    expect(await screen.findByText("Execution mode")).toBeTruthy();
    await user.click(screen.getByText("elsewhere"));
    await waitFor(() => expect(screen.queryByText("Execution mode")).toBeNull());
  });

  it("SettingsThinkingPicker keeps Babylon classes and selects", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<SettingsThinkingPicker current="low" onSelect={onSelect} />);
    await user.click(screen.getByTitle("Reasoning level"));
    const panel = (await screen.findByText("Very deep reasoning")).closest("div");
    expect(panel?.className).toContain("operator-popover");
    await user.click(screen.getByText("X-High"));
    expect(onSelect).toHaveBeenCalledWith("xhigh");
  });
});
