// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Switch } from "./Switch";
import { Checkbox } from "./Checkbox";

afterEach(() => cleanup());

/**
 * Babylon's contract with the Base UI toggle primitives: role, state
 * reporting via click and keyboard. These tests do not test Base UI itself.
 */
describe("Switch", () => {
  it("toggles on click and reports state", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<Switch checked={false} onChange={onChange} ariaLabel="Daemon" />);
    const el = screen.getByRole("switch", { name: "Daemon" });
    expect(el.getAttribute("aria-checked")).toBe("false");
    await user.click(el);
    expect(onChange).toHaveBeenCalledWith(true);
    rerender(<Switch checked={true} onChange={onChange} ariaLabel="Daemon" />);
    expect(screen.getByRole("switch", { name: "Daemon" }).getAttribute("aria-checked")).toBe("true");
  });

  it("toggles on Space", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Switch checked={false} onChange={onChange} ariaLabel="Daemon" />);
    await user.click(screen.getByRole("switch", { name: "Daemon" }));
    await user.keyboard(" ");
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});

describe("Checkbox", () => {
  it("toggles on click and reports state", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<Checkbox checked={false} onChange={onChange} ariaLabel="Pick" />);
    const el = screen.getByRole("checkbox", { name: "Pick" });
    expect(el.getAttribute("aria-checked")).toBe("false");
    await user.click(el);
    expect(onChange).toHaveBeenCalledWith(true);
    rerender(<Checkbox checked={true} onChange={onChange} ariaLabel="Pick" />);
    expect(screen.getByRole("checkbox", { name: "Pick" }).getAttribute("aria-checked")).toBe("true");
  });

  it("does not toggle when disabled", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Checkbox checked={false} onChange={onChange} ariaLabel="Pick" disabled />);
    await user.click(screen.getByRole("checkbox", { name: "Pick" }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
