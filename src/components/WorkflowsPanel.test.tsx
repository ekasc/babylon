// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { TranscriptContent } from "./WorkflowsPanel";

afterEach(() => cleanup());

const MSGS = [
  { at: "t0", role: "user", text: "task prompt" },
  { at: "t1", role: "activity", text: "read src/x.ts" },
  { at: "t2", role: "assistant", text: "first reply" },
  { at: "t3", role: "activity", text: "bash ls" },
  { at: "t4", role: "assistant", text: "final reply" },
] as const;

describe("TranscriptContent (agent detail transcript)", () => {
  it("while running shows only the agent's own messages", () => {
    const { queryByText } = render(<TranscriptContent recent={[...MSGS]} live />);
    expect(queryByText("first reply")).toBeTruthy();
    expect(queryByText("final reply")).toBeTruthy();
    expect(queryByText("task prompt")).toBeNull();
    expect(queryByText("read src/x.ts")).toBeNull();
    expect(queryByText("bash ls")).toBeNull();
  });

  it("after finishing hides everything but the final message", () => {
    const { queryByText } = render(<TranscriptContent recent={[...MSGS]} live={false} />);
    expect(queryByText("final reply")).toBeTruthy();
    expect(queryByText("first reply")).toBeNull();
    expect(queryByText("task prompt")).toBeNull();
    expect(queryByText("read src/x.ts")).toBeNull();
    expect(queryByText("bash ls")).toBeNull();
  });

  it("falls back to the run output when the agent never sent a message", () => {
    const { queryByText } = render(
      <TranscriptContent
        recent={[{ at: "t0", role: "user", text: "prompt" }]}
        run={{ runId: "r1", status: "completed", updatedAt: "t1", output: "processed the task" }}
        live
      />
    );
    expect(queryByText(/processed the task/)).toBeTruthy();
  });
});