import { useCallback, useRef, useState } from "react";
import { bridge } from "../../bridge";
import { errorMessage } from "../../lib/errors";
import type { DurableGoalState } from "../../lib/durable-goal";

/**
 * The session's durable goal (hardbaked goal-mode extension state) as App
 * state: refresh reads the state file for a session, control runs a `/goal …`
 * invocation on the foreground session and adopts the fresh state it
 * returns. Refreshes are guarded by target so a session switch mid-flight
 * can never file another session's goal here.
 */
export function useDurableGoal(toast: (type: "info" | "warning" | "error", text: string) => void) {
  const [durableGoal, setDurableGoal] = useState<DurableGoalState | null>(null);
  const goalTargetRef = useRef<{ sessionId: string; cwd: string } | null>(null);

  const refreshDurableGoal = useCallback(async (sessionId: string, cwd: string) => {
    goalTargetRef.current = { sessionId, cwd };
    try {
      const { goal } = await bridge.goalGet(sessionId, cwd);
      const current = goalTargetRef.current;
      if (current && current.sessionId === sessionId && current.cwd === cwd) setDurableGoal(goal);
    } catch {
      /* transient read failure: keep the last known goal */
    }
  }, []);

  // GUI goal controls are path-addressed (the CLI /goal command stays
  // foreground-oriented): a cancel issued for session A executes on A even
  // if the UI moved to B mid-flight.
  const goalControl = useCallback(
    async (sessionFile: string, args: string) => {
      try {
        const { goal } = await bridge.goalControl(sessionFile, args);
        setDurableGoal(goal);
      } catch (e) {
        toast("error", errorMessage(e, "goal control failed"));
      }
    },
    [toast]
  );

  return { durableGoal, setDurableGoal, goalTargetRef, refreshDurableGoal, goalControl };
}
