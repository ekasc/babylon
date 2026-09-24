import { useCallback, useState, type Dispatch, type SetStateAction } from "react";
import { bridge, type HistoryProjection, type RollbackPlan } from "../../bridge";
import { errorMessage } from "../../lib/errors";

type Toast = (type: "info" | "warning" | "error", text: string) => void;

export function useRollback(deps: {
  setHistory: Dispatch<SetStateAction<HistoryProjection>>;
  setHistoryRevision: Dispatch<SetStateAction<number>>;
  setDraftRequest: Dispatch<SetStateAction<{ id: number; text: string } | null>>;
  hydrate: (expectedEpoch?: number) => Promise<void>;
  toast: Toast;
}) {
  const { setHistory, setHistoryRevision, setDraftRequest, hydrate, toast } = deps;
  const [rollbackPlan, setRollbackPlan] = useState<RollbackPlan | null>(null);
  const [rollbackBusy, setRollbackBusy] = useState(false);

  const prepareRollback = useCallback(async (sessionFile: string, entryId: string) => {
    try {
      setRollbackPlan(await bridge.prepareRollback(sessionFile, entryId));
    } catch (error) {
      toast("error", errorMessage(error, "rollback is unavailable"));
    }
  }, [toast]);

  const commitRollback = useCallback(async () => {
    if (!rollbackPlan || rollbackBusy) return;
    setRollbackBusy(true);
    try {
      const result = await bridge.commitRollback(rollbackPlan.planId);
      setRollbackPlan(null);
      setHistory(result.history);
      setHistoryRevision((revision) => revision + 1);
      setDraftRequest({ id: Date.now(), text: result.editorText });
      await hydrate();
      toast("info", "Conversation and files rolled back");
    } catch (error) {
      toast("error", errorMessage(error, "rollback failed"));
    } finally {
      setRollbackBusy(false);
    }
  }, [rollbackBusy, rollbackPlan, hydrate, toast]);

  const undoRollback = useCallback(async (sessionFile: string) => {
    if (rollbackBusy) return;
    setRollbackBusy(true);
    try {
      const result = await bridge.undoRollback(sessionFile);
      setHistory(result.history);
      setHistoryRevision((revision) => revision + 1);
      setDraftRequest({ id: Date.now(), text: "" });
      await hydrate();
      toast("info", "Rollback undone");
    } catch (error) {
      toast("error", errorMessage(error, "could not undo rollback"));
      void hydrate();
    } finally {
      setRollbackBusy(false);
    }
  }, [rollbackBusy, hydrate, toast]);

  return { rollbackPlan, rollbackBusy, setRollbackPlan, prepareRollback, commitRollback, undoRollback };
}
