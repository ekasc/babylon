import * as Effect from "effect/Effect";
import { filterModels, findModel, getProviders } from "./model-helpers";

export const findModelEffect = (
  models: any[],
  ref?: { provider: string; modelId: string } | null,
): Effect.Effect<any> => Effect.sync(() => findModel(models, ref));

export const getProvidersEffect = (models: any[]): Effect.Effect<string[]> =>
  Effect.sync(() => getProviders(models));

export const filterModelsEffect = (models: any[], query: string, provider?: string): Effect.Effect<any[]> =>
  Effect.sync(() => filterModels(models, query, provider));
