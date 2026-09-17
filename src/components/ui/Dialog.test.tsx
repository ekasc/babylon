// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ModalDialog } from "./Dialog";

afterEach(() => cleanup());

/**
 * Babylon's contract with the Base UI dialog primitive (used by
 * DiagnosticsPanel, RollbackConfirm, PromptHost, GitCommitPopover,
 * CommandPalette, NewSessionModal, ProjectPanel).
 *
 * These tests do not test Base UI itself — they pin the dismissal and
 * focus semantics Babylon relies on after deleting useModalDialog.
 */
function Harness({
  dismissible = true,
  onClose,
}: {
  dismissible?: boolean;
  onClose?(): void;
}) {
  const [open, setOpen] = useState(true);
  const close = () => {
    onClose?.();
    setOpen(false);
  };
  if (!open) return null;
  return (
    <ModalDialog
      open={open}
      onClose={close}
      dismissible={dismissible}
      backdropClassName="test-backdrop"
      viewportClassName="test-viewport"
      popupClassName="test-popup"
      ariaLabel="Test dialog"
    >
      <button>inner action</button>
    </ModalDialog>
  );
}

describe("ModalDialog", () => {
  it("keeps Babylon styling classes on the Base UI parts", () => {
    const { container } = render(<Harness />);
    expect(container.ownerDocument.querySelector(".test-backdrop")).toBeTruthy();
    expect(container.ownerDocument.querySelector(".test-viewport")).toBeTruthy();
    expect(screen.getByRole("dialog").className).toContain("test-popup");
  });

  it("Escape closes a dismissible dialog", async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    expect(screen.getByRole("dialog")).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("Escape does not close a non-dismissible (busy/approval) surface", async () => {
    const onClose = vi.fn();
    render(<Harness dismissible={false} onClose={onClose} />);
    expect(screen.getByRole("dialog")).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    // Give Base UI a chance to (incorrectly) close.
    await new Promise((r) => setTimeout(r, 50));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("backdrop press closes when allowed, content click does not", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { container } = render(<Harness onClose={onClose} />);
    const backdrop = container.ownerDocument.querySelector(".test-backdrop") as HTMLElement;
    await user.click(screen.getByText("inner action"));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.mouseDown(backdrop);
    fireEvent.mouseUp(backdrop);
    fireEvent.click(backdrop);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("backdrop press does not close a non-dismissible surface", async () => {
    const onClose = vi.fn();
    const { container } = render(<Harness dismissible={false} onClose={onClose} />);
    const backdrop = container.ownerDocument.querySelector(".test-backdrop") as HTMLElement;
    fireEvent.mouseDown(backdrop);
    fireEvent.mouseUp(backdrop);
    fireEvent.click(backdrop);
    await new Promise((r) => setTimeout(r, 50));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("moves focus into the dialog on open and restores it on close", async () => {
    const onClose = vi.fn();
    function Opener() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>outside trigger</button>
          {open && (
            <Harness
              onClose={() => {
                onClose();
                setOpen(false);
              }}
            />
          )}
        </>
      );
    }
    render(<Opener />);
    const trigger = screen.getByText("outside trigger");
    trigger.focus();
    expect(document.activeElement).toBe(trigger);
    await userEvent.click(trigger);
    // Focus enters the dialog (Base UI initial focus: first tabbable).
    await waitFor(() =>
      expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true)
    );
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});
