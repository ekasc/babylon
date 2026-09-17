import { useCallback, useEffect, useRef, useState } from "react";
import { appendEvent, createEventLog, type BabylonEvent, type EventLog } from "../../events";

const MAX_EVENTS = 500;

/**
 * Bounded diagnostics event log. Events are always folded into a ref so the
 * log stays complete, but component state is only published while `enabled`
 * (the Diagnostics panel) is open — otherwise every agent/attention event
 * would re-render the whole app for a panel the user is not looking at.
 */
export function useEventLog(enabled: boolean) {
  const logRef = useRef<EventLog>(createEventLog());
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const [eventLog, setEventLog] = useState<EventLog>(logRef.current);

  const appendEvents = useCallback((incoming: BabylonEvent[]) => {
    if (incoming.length === 0) return;
    let next = logRef.current;
    for (const e of incoming) {
      const out = appendEvent(next, e);
      if (typeof out !== "string") next = out;
    }
    if (next.events.length > MAX_EVENTS) next = { events: next.events.slice(-MAX_EVENTS) };
    logRef.current = next;
    if (enabledRef.current) setEventLog(next);
  }, []);

  // Publish the log accumulated while the panel was closed.
  useEffect(() => {
    if (enabled) setEventLog(logRef.current);
  }, [enabled]);

  return { eventLog, appendEvents };
}
