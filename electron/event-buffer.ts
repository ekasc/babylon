import type { AgentEvent } from "../src/bridge";
import { wireOf } from "../src/store";

export type EventBatchSink = (events: AgentEvent[]) => void;

/**
 * Coalesces high-frequency streaming events into one renderer IPC per frame.
 * Lifecycle and UI events remain immediate and flush any preceding deltas first.
 */
export class AgentEventBuffer {
  private pending: AgentEvent[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly sink: EventBatchSink,
    private readonly intervalMs = 24
  ) {}

  push(event: AgentEvent): void {
    if (this.coalesce(event)) {
      this.schedule();
      return;
    }
    this.pending.push(event);
    this.flush();
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending.length === 0) return;
    const events = this.pending;
    this.pending = [];
    this.sink(events);
  }

  dispose(): void {
    this.flush();
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.intervalMs);
  }

  private coalesce(event: AgentEvent): boolean {
    if (event.type === "message_update") {
      const delta = wireOf(event.assistantMessageEvent);
      const deltaType = delta?.type;
      if (deltaType !== "text_delta" && deltaType !== "thinking_delta") return false;
      const last = this.pending[this.pending.length - 1];
      const lastDelta = wireOf(last?.assistantMessageEvent);
      if (
        last?.type === "message_update" &&
        last.sessionId === event.sessionId &&
        lastDelta?.type === deltaType &&
        lastDelta?.contentIndex === delta?.contentIndex
      ) {
        last.assistantMessageEvent = {
          ...delta,
          delta: `${String(lastDelta?.delta ?? "")}${String(delta?.delta ?? "")}`,
        };
      } else {
        this.pending.push({ ...event, assistantMessageEvent: { ...delta } });
      }
      return true;
    }

    if (event.type === "tool_execution_update") {
      const last = this.pending[this.pending.length - 1];
      if (
        last?.type === "tool_execution_update" &&
        last.sessionId === event.sessionId &&
        last.toolCallId === event.toolCallId
      ) {
        // partialResult is cumulative, so only the newest snapshot matters.
        this.pending[this.pending.length - 1] = event;
      } else {
        this.pending.push(event);
      }
      return true;
    }

    return false;
  }
}
