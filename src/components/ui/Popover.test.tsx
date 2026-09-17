// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PopoverPanel, PopoverRoot, PopoverTrigger } from "./Popover";

afterEach(() => cleanup());

/**
 * Babylon's contract with the Base UI popover primitive: trigger wiring,
 * inline (portal-less) absolute panel that keeps Babylon classes, and
 * dismissal semantics. These tests do not test Base UI itself.
 */
function Harness({ onOpenChange }: { onOpenChange?(open: boolean): void }) {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  return (
    <div ref={setContainer} data-testid="anchor-root" className="relative">
      <PopoverRoot open onOpenChange={onOpenChange ?? (() => {})}>
        <PopoverTrigger className="test-trigger">Pick</PopoverTrigger>
        <PopoverPanel
          container={container}
          side="bottom"
          align="start"
          sideOffset={8}
          className="test-panel"
        >
          <button>row one</button>
        </PopoverPanel>
      </PopoverRoot>
    </div>
  );
}

describe("Popover", () => {
  it("renders trigger and panel inline with Babylon classes", () => {
    const { container } = render(<Harness />);
    const trigger = screen.getByText("Pick");
    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const panel = screen.getByText("row one").closest("div");
    expect(panel?.className).toContain("test-panel");
    // Inline: no portal — the panel stays inside the anchor root.
    expect(container.querySelector('[data-testid="anchor-root"]')?.contains(panel)).toBe(true);
  });

  it("toggle via trigger reports through onOpenChange", async () => {
    const onOpenChange = vi.fn();
    render(<Harness onOpenChange={onOpenChange} />);
    await userEvent.click(screen.getByText("Pick"));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("outside press reports close, inside click does not", () => {
    const onOpenChange = vi.fn();
    render(<Harness onOpenChange={onOpenChange} />);
    fireEvent.mouseDown(screen.getByText("row one"));
    fireEvent.mouseUp(screen.getByText("row one"));
    expect(onOpenChange).not.toHaveBeenCalled();
    fireEvent.pointerDown(document.body);
    fireEvent.mouseDown(document.body);
    fireEvent.mouseUp(document.body);
    fireEvent.click(document.body);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("does not steal focus on open by default", async () => {
    function Closed() {
      const [open, setOpen] = useState(false);
      const [container, setContainer] = useState<HTMLElement | null>(null);
      return (
        <div ref={setContainer}>
          <PopoverRoot open={open} onOpenChange={setOpen}>
            <PopoverTrigger>Pick</PopoverTrigger>
            <PopoverPanel container={container} className="test-panel">
              <button>row one</button>
            </PopoverPanel>
          </PopoverRoot>
        </div>
      );
    }
    render(<Closed />);
    // Popup focus-steal scrolls the page to the freshly mounted panel.
    await userEvent.click(screen.getByText("Pick"));
    expect(await screen.findByText("row one")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByText("Pick"));
  });

  it("Escape reports close", async () => {
    const onOpenChange = vi.fn();
    render(<Harness onOpenChange={onOpenChange} />);
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
});
