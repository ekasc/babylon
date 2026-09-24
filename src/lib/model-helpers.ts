import type { AgentModel } from "../bridge";

export function findModel(models: AgentModel[], ref?: { provider: string; modelId: string } | null): AgentModel | null {
  if (!ref) return null;
  return models.find((m) => m.provider === ref.provider && m.id === ref.modelId) ?? { provider: ref.provider, id: ref.modelId };
}

export function getProviders(models: AgentModel[]): string[] {
  return [...new Set(models.map((m) => m.provider))].sort();
}

export function filterModels(models: AgentModel[], query: string, provider: string = "all"): AgentModel[] {
  let out = models;
  if (provider !== "all") out = out.filter((m) => m.provider === provider);
  const q = query.trim().toLowerCase();
  if (q) out = out.filter((m) => `${m.provider}/${m.id} ${m.name ?? ""}`.toLowerCase().includes(q));
  return out;
}
