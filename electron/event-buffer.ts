export type EventBatchSink = (events: any[]) => void;

/**
 * Coalesces high-frequency streaming events into one renderer IPC per frame.
 * Lifecycle and UI events remain immediate and flush any preceding deltas first.
 */
export class AgentEventBuffer {
  private pending: any[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly sink: EventBatchSink,
    private readonly intervalMs = 24
  ) {}

  push(event: any): void {
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

  private coalesce(event: any): boolean {
    if (event?.type === "message_update") {
      const delta = event.assistantMessageEvent;
      if (delta?.type !== "text_delta" && delta?.type !== "thinking_delta") return false;
      const last = this.pending[this.pending.length - 1];
      const lastDelta = last?.assistantMessageEvent;
      if (
        last?.type === "message_update" &&
        last.sessionId === event.sessionId &&
        lastDelta?.type === delta.type &&
        lastDelta?.contentIndex === delta.contentIndex
      ) {
        last.assistantMessageEvent = {
          ...lastDelta,
          delta: `${lastDelta.delta ?? ""}${delta.delta ?? ""}`,
        };
      } else {
        this.pending.push({ ...event, assistantMessageEvent: { ...delta } });
      }
      return true;
    }

    if (event?.type === "tool_execution_update") {
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
