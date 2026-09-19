// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ModelPicker from "./ModelPicker";

afterEach(() => cleanup());

const MODELS = [
  { id: "b-model", name: "B Model", provider: "acme", contextWindow: 200_000 },
  { id: "a-model", name: "A Model", provider: "acme", contextWindow: 100_000 },
  { id: "c-model", name: "C Model", provider: "acme", contextWindow: 50_000 },
];

function openPicker(onSelect: (provider: string, id: string) => void) {
  render(<ModelPicker models={MODELS} current={null} onSelect={onSelect} />);
  return userEvent.click(screen.getByRole("button", { name: "select model" }));
}

describe("ModelPicker quick-select", () => {
  it("sorts rows by name and hints the first rows with mod+digit", async () => {
    await openPicker(vi.fn());
    const options = screen.getAllByRole("option");
    expect(options.map((o) => o.textContent)).toMatchObject([
      expect.stringContaining("A Model"),
      expect.stringContaining("B Model"),
      expect.stringContaining("C Model"),
    ]);
    // Rows past the highlight carry a quick-select hint (⌘N on Mac, Ctrl+N elsewhere).
    expect(screen.getByTitle(/2 to select/)).toBeTruthy();
  });

  it("picks the visible row on mod+digit", async () => {
    const onSelect = vi.fn();
    await openPicker(onSelect);
    fireEvent.keyDown(window, { key: "2", metaKey: true });
    expect(onSelect).toHaveBeenCalledWith("acme", "b-model");
  });

  it("ignores out-of-range digits", async () => {
    const onSelect = vi.fn();
    await openPicker(onSelect);
    fireEvent.keyDown(window, { key: "9", metaKey: true });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("explains an empty catalog on the disabled trigger", () => {
    render(<ModelPicker models={[]} current={null} onSelect={vi.fn()} />);
    expect(screen.getByRole("button", { name: "select model" }).getAttribute("title")).toMatch(
      /No models available/
    );
  });
});
