import { useCallback, useState, type Dispatch, type SetStateAction } from "react";
import { bridge, type HistoryProjection, type RollbackPlan } from "../../bridge";

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

  const prepareRollback = useCallback(async (entryId: string) => {
    try {
      setRollbackPlan(await bridge.prepareRollback(entryId));
    } catch (error: any) {
      toast("error", error?.message ?? "rollback is unavailable");
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
    } catch (error: any) {
      toast("error", error?.message ?? "rollback failed");
    } finally {
      setRollbackBusy(false);
    }
  }, [rollbackBusy, rollbackPlan, hydrate, toast]);

  const undoRollback = useCallback(async () => {
    if (rollbackBusy) return;
    setRollbackBusy(true);
    try {
      const result = await bridge.undoRollback();
      setHistory(result.history);
      setHistoryRevision((revision) => revision + 1);
      setDraftRequest({ id: Date.now(), text: "" });
      await hydrate();
      toast("info", "Rollback undone");
    } catch (error: any) {
      toast("error", error?.message ?? "could not undo rollback");
      void hydrate();
    } finally {
      setRollbackBusy(false);
    }
  }, [rollbackBusy, hydrate, toast]);

  return { rollbackPlan, rollbackBusy, setRollbackPlan, prepareRollback, commitRollback, undoRollback };
}
