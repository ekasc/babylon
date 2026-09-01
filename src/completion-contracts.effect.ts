import * as Effect from "effect/Effect";
import { createContract, evaluateContract, type CompletionContract } from "./completion-contracts";

export const createContractEffect = (params: Parameters<typeof createContract>[0]): Effect.Effect<CompletionContract> =>
  Effect.sync(() => createContract(params));

export const evaluateContractEffect = (
  contract: CompletionContract,
  results: Parameters<typeof evaluateContract>[1],
): Effect.Effect<ReturnType<typeof evaluateContract>> => Effect.sync(() => evaluateContract(contract, results));
