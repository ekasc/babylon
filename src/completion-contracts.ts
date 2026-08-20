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
  /** True when the check is satisfied (passed, or optional and not failed). */
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
  return { ...contract, checks: contract.checks.filter((c) => c.kind !== kind) };
}

/**
 * Evaluate a contract against observed results. A required check is satisfied
 * only when a matching result exists and passed; an optional check is satisfied
 * when it did not actively fail. The contract passes only when every required
 * check is satisfied.
 */
export function evaluateContract(
  contract: CompletionContract,
  results: CheckResult[]
): ContractEvaluation {
  const byKind = new Map(results.map((r) => [r.kind, r]));
  const checks: EvaluatedCheck[] = contract.checks.map((check) => {
    const result = byKind.get(check.kind);
    // Required checks must have a passing result; optional checks never block
    // completion even when they fail.
    const satisfied = check.required ? Boolean(result?.passed) : true;
    return { check, result, satisfied };
  });
  return { passed: checks.every((c) => c.satisfied), checks };
}
