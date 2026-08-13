import { describe, expect, it, vi } from "vitest";
import { AgentEventBuffer } from "./event-buffer";

describe("AgentEventBuffer", () => {
  it("joins consecutive text deltas and flushes before lifecycle events", () => {
    const sink = vi.fn();
    const buffer = new AgentEventBuffer(sink, 1000);
    buffer.push({
      type: "message_update",
      sessionId: "s1",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hel" },
    });
    buffer.push({
      type: "message_update",
      sessionId: "s1",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "lo" },
    });
    buffer.push({ type: "message_end", sessionId: "s1", message: { role: "assistant" } });

    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0]?.[0]).toEqual([
      {
        type: "message_update",
        sessionId: "s1",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello" },
      },
      { type: "message_end", sessionId: "s1", message: { role: "assistant" } },
    ]);
  });

  it("keeps only the latest cumulative update for one tool", () => {
    const sink = vi.fn();
    const buffer = new AgentEventBuffer(sink, 1000);
    buffer.push({ type: "tool_execution_update", sessionId: "s1", toolCallId: "t1", partialResult: { content: "a" } });
    buffer.push({ type: "tool_execution_update", sessionId: "s1", toolCallId: "t1", partialResult: { content: "ab" } });
    buffer.flush();

    expect(sink.mock.calls[0]?.[0]).toHaveLength(1);
    expect(sink.mock.calls[0]?.[0][0].partialResult.content).toBe("ab");
  });
});
