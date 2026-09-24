import { useCallback, useRef, useState } from "react";
import { bridge } from "../../bridge";
import { errorMessage } from "../../lib/errors";
import type { DesignStatus } from "../../../electron/design-mode/store";

/**
 * The session's design mode (hardbaked design-mode extension state) as App
 * state: refresh reads the state file for a session, control runs a
 * `/design …` invocation on the addressed session and adopts the fresh
 * status it returns. Refreshes are guarded by target so a session switch
 * mid-flight can never file another session's design state here.
 */
export function useDesignMode(toast: (type: "info" | "warning" | "error", text: string) => void) {
  const [designStatus, setDesignStatus] = useState<DesignStatus | null>(null);
  const designTargetRef = useRef<{ sessionId: string; cwd: string } | null>(null);

  const refreshDesign = useCallback(async (sessionId: string, cwd: string) => {
    designTargetRef.current = { sessionId, cwd };
    try {
      const status = await bridge.designGet(sessionId, cwd);
      const current = designTargetRef.current;
      if (current && current.sessionId === sessionId && current.cwd === cwd) setDesignStatus(status);
    } catch {
      /* transient read failure: keep the last known design status */
    }
  }, []);

  // GUI design controls are path-addressed (the CLI /design command stays
  // foreground-oriented): a control issued for session A executes on A even
  // if the UI moved to B mid-flight.
  const designControl = useCallback(
    async (sessionFile: string, args: string) => {
      try {
        const status = await bridge.designControl(sessionFile, args);
        setDesignStatus(status);
      } catch (e) {
        toast("error", errorMessage(e, "design control failed"));
      }
    },
    [toast]
  );

  return { designStatus, setDesignStatus, designTargetRef, refreshDesign, designControl };
}
