// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ThinkingPicker from "./ComposerThinkingPicker";

afterEach(() => cleanup());

/**
 * Babylon's contract with the popover primitive behind the composer
 * thinking picker: trigger toggles, Escape and outside-press dismiss,
 * selection callbacks keep working, and focus stays on the trigger.
 */
describe("ComposerThinkingPicker", () => {
  it("opens on trigger click and selects a level", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<ThinkingPicker current="medium" onSelect={onSelect} />);
    expect(screen.queryByText("Deep reasoning for hard problems")).toBeNull();
    await user.click(screen.getByTitle("Reasoning level"));
    expect(await screen.findByText("Deep reasoning for hard problems")).toBeTruthy();
    await user.click(screen.getByText("High"));
    expect(onSelect).toHaveBeenCalledWith("high");
    await waitFor(() =>
      expect(screen.queryByText("Deep reasoning for hard problems")).toBeNull()
    );
  });

  it("Escape closes without selecting", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<ThinkingPicker current="medium" onSelect={onSelect} />);
    await user.click(screen.getByTitle("Reasoning level"));
    expect(await screen.findByText("Deep reasoning for hard problems")).toBeTruthy();
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByText("Deep reasoning for hard problems")).toBeNull()
    );
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("outside press closes without selecting", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(
      <>
        <button>elsewhere</button>
        <ThinkingPicker current="medium" onSelect={onSelect} />
      </>
    );
    await user.click(screen.getByTitle("Reasoning level"));
    expect(await screen.findByText("Deep reasoning for hard problems")).toBeTruthy();
    await user.click(screen.getByText("elsewhere"));
    await waitFor(() =>
      expect(screen.queryByText("Deep reasoning for hard problems")).toBeNull()
    );
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("keeps focus on the trigger while open", async () => {
    const user = userEvent.setup();
    render(<ThinkingPicker current="medium" onSelect={() => undefined} />);
    const trigger = screen.getByTitle("Reasoning level");
    await user.click(trigger);
    expect(await screen.findByText("Deep reasoning for hard problems")).toBeTruthy();
    expect(document.activeElement).toBe(trigger);
  });
});
