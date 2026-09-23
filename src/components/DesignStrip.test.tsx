// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DesignStrip } from "./DesignStrip";
import { createDesignState } from "../../electron/design-mode/store";

afterEach(cleanup);

const noop = () => {};
const baseProps = {
  onApproveBrief: noop,
  onApproveBrand: noop,
  onFinish: noop,
  onClear: noop,
};

describe("DesignStrip", () => {
  it("renders nothing without a session", () => {
    const { container } = render(<DesignStrip status={null} {...baseProps} />);
    expect(container.innerHTML).toBe("");
  });

  it("shows the stage approval action for brief review", async () => {
    const user = userEvent.setup();
    const onApproveBrief = vi.fn();
    const onApproveBrand = vi.fn();
    const design = { ...createDesignState("Us screen", "us-screen"), briefApproved: false };
    render(
      <DesignStrip
        {...baseProps}
        status={{ design, stage: "brief-confirm" }}
        onApproveBrief={onApproveBrief}
        onApproveBrand={onApproveBrand}
      />
    );
    expect(screen.getByText("brief review")).toBeDefined();
    await user.click(screen.getByText("Approve brief"));
    expect(onApproveBrief).toHaveBeenCalled();
    expect(onApproveBrand).not.toHaveBeenCalled();
  });

  it("offers a fresh start once finished", async () => {
    const user = userEvent.setup();
    const onClear = vi.fn();
    const design = { ...createDesignState("Us screen", "us-screen"), done: true };
    render(
      <DesignStrip
        {...baseProps}
        status={{ design, stage: "done" }}
        onClear={onClear}
      />
    );
    await user.click(screen.getByText("New design"));
    expect(onClear).toHaveBeenCalled();
  });
});
