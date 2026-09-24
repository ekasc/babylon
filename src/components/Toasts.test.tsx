// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import Toasts from "./Toasts";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Toasts auto-dismiss", () => {
  it("dismisses info toasts after 5s but keeps errors", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(
      <Toasts
        toasts={[
          { id: 1, type: "info", text: "hello" },
          { id: 2, type: "error", text: "boom" },
        ]}
        onDismiss={onDismiss}
      />
    );
    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(onDismiss).toHaveBeenCalledWith(1);
    expect(onDismiss).not.toHaveBeenCalledWith(2);
    expect(screen.getByText("boom")).toBeTruthy();
  });
});
