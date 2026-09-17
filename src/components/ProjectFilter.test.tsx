// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ProjectFilter from "./ProjectFilter";

afterEach(() => cleanup());

/**
 * Babylon's contract with the Base UI popover primitive (shared pattern
 * behind ProjectFilter, StatsPopover, ThinkingPicker,
 * SettingsThinkingPicker, PermissionModePicker): trigger toggles, Escape
 * and outside-press dismiss, selection callbacks keep working, and focus
 * stays on the trigger (no focus yank out of the composer meta row).
 */
const PROJECTS = [
  { cwd: "/tmp/alpha", name: "alpha" },
  { cwd: "/tmp/beta", name: "beta" },
];

describe("ProjectFilter popover", () => {
  it("opens on trigger click and selects an option", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ProjectFilter projects={PROJECTS} value="all" onChange={onChange} />);
    expect(screen.queryByRole("option")).toBeNull();
    await user.click(screen.getByTitle("All projects"));
    expect(screen.getAllByRole("option")).toHaveLength(3);
    await user.click(screen.getByText("beta"));
    expect(onChange).toHaveBeenCalledWith("/tmp/beta");
    await waitFor(() => expect(screen.queryByRole("option")).toBeNull());
  });

  it("Escape closes without selecting", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ProjectFilter projects={PROJECTS} value="all" onChange={onChange} />);
    await user.click(screen.getByTitle("All projects"));
    expect(screen.getAllByRole("option")).toHaveLength(3);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("option")).toBeNull());
    expect(onChange).not.toHaveBeenCalled();
  });

  it("outside press closes without selecting", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <>
        <button>elsewhere</button>
        <ProjectFilter projects={PROJECTS} value="all" onChange={onChange} />
      </>
    );
    await user.click(screen.getByTitle("All projects"));
    expect(screen.getAllByRole("option")).toHaveLength(3);
    await user.click(screen.getByText("elsewhere"));
    await waitFor(() => expect(screen.queryByRole("option")).toBeNull());
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps focus on the trigger while open", async () => {
    const user = userEvent.setup();
    render(<ProjectFilter projects={PROJECTS} value="all" onChange={() => undefined} />);
    const trigger = screen.getByTitle("All projects");
    await user.click(trigger);
    expect(screen.getAllByRole("option")).toHaveLength(3);
    expect(document.activeElement).toBe(trigger);
  });
});
