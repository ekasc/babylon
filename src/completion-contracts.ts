// Completion Contracts for Phase 5.
//
// A contract defines what must be true before Babylon considers a task
// complete: command exits, tests pass, typecheck, lint, no new diagnostics,
// no new TODOs, working-tree policy, browser smoke test, review approval. The
// model is pure and testable; the agent proposes a contract and the evaluator
// distinguishes "agent finished" from "contract satisfied".

export type CheckKind =
  | "command"
  | "tests"
  | "typecheck"
  | "lint"
  | "no_new_diagnostics"
  | "no_todo"
  | "working_tree"
  | "browser_smoke"
  | "review";

export interface ContractCheck {
  kind: CheckKind;
  label: string;
  required: boolean;
}

export interface CompletionContract {
  id: string;
  title: string;
  checks: ContractCheck[];
}

export interface CheckResult {
  kind: CheckKind;
  passed: boolean;
  detail?: string;
}

export interface EvaluatedCheck {
  check: ContractCheck;
  result?: CheckResult;
  /**
   * True when the check is satisfied. A required check needs a passing result
   * (a missing or failing result is not satisfied). An optional check is
   * satisfied only when it has a passing result; a failed optional check is NOT
   * satisfied, but optional failures do not block overall completion (see
   * evaluateContract's `passed`).
   */
  satisfied: boolean;
}

export interface ContractEvaluation {
  passed: boolean;
  checks: EvaluatedCheck[];
}

export function createContract(params: {
  id: string;
  title: string;
  checks?: ContractCheck[];
}): CompletionContract {
  return { id: params.id, title: params.title, checks: params.checks ?? [] };
}

export function addCheck(contract: CompletionContract, check: ContractCheck): CompletionContract {
  if (contract.checks.some((c) => c.kind === check.kind)) return contract;
  return { ...contract, checks: [...contract.checks, check] };
}

export function removeCheck(contract: CompletionContract, kind: CheckKind): CompletionContract {
  if (!contract.checks.some((c) => c.kind === kind)) return contract;
  return { ...contract, checks: contract.checks.filter((c) => c.kind !== kind) };
}

/**
 * Evaluate a contract against observed results. All results for a given kind are
 * considered: a required check is satisfied only when every matching result
 * passed (a missing or failing result is not satisfied, so a duplicate failing
 * result can never be masked by a later passing one). An optional check is
 * satisfied only when it has a passing result, but optional failures do not
 * block overall completion (the contract passes only when every REQUIRED check
 * is satisfied).
 */
export function evaluateContract(
  contract: CompletionContract,
  results: CheckResult[]
): ContractEvaluation {
  const byKind = new Map<CheckKind, CheckResult[]>();
  for (const r of results) {
    const arr = byKind.get(r.kind);
    if (arr) arr.push(r);
    else byKind.set(r.kind, [r]);
  }
  const checks: EvaluatedCheck[] = contract.checks.map((check) => {
    const resultsForKind = byKind.get(check.kind) ?? [];
    const satisfied = check.required
      ? resultsForKind.length > 0 && resultsForKind.every((r) => r.passed)
      : resultsForKind.length > 0
        ? resultsForKind.every((r) => r.passed)
        : true;
    return {
      check,
      result: resultsForKind[resultsForKind.length - 1],
      satisfied,
    };
  });
  const passed = checks.filter((c) => c.check.required).every((c) => c.satisfied);
  return { passed, checks };
}
