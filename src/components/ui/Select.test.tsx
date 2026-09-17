// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Select, SelectOption } from "./Select";

afterEach(() => cleanup());

/**
 * Babylon's contract with the Base UI select primitive: label display,
 * value reporting, keyboard choice, dismissal. These tests do not test
 * Base UI itself.
 */
function Harness({ onChange }: { onChange?(value: string): void }) {
  const [value, setValue] = useState("all");
  return (
    <Select
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
      triggerClassName="test-trigger"
      ariaLabel="Provider"
    >
      <SelectOption value="all" label="All providers" />
      <SelectOption value="openai">OpenAI</SelectOption>
    </Select>
  );
}

describe("Select", () => {
  it("shows the selected option label in the trigger", () => {
    render(<Harness />);
    expect(screen.getByRole("combobox").textContent).toContain("All providers");
  });

  it("chooses an option by click and reports its value", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} />);
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "OpenAI" }));
    expect(onChange).toHaveBeenCalledWith("openai");
    await waitFor(() =>
      expect(screen.getByRole("combobox").textContent).toContain("OpenAI")
    );
  });

  it("chooses an option by keyboard", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} />);
    await user.click(screen.getByRole("combobox"));
    expect(await screen.findByRole("option", { name: "OpenAI" })).toBeTruthy();
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("openai"));
  });

  it("Escape closes without choosing", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} />);
    await user.click(screen.getByRole("combobox"));
    expect(await screen.findByRole("option", { name: "OpenAI" })).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("option")).toBeNull());
    expect(onChange).not.toHaveBeenCalled();
  });
});
