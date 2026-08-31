export function findModel(models: any[], ref?: { provider: string; modelId: string } | null) {
  if (!ref) return null;
  return models.find((m) => m.provider === ref.provider && m.id === ref.modelId) ?? { provider: ref.provider, id: ref.modelId };
}

export function getProviders(models: any[]): string[] {
  return [...new Set(models.map((m: any) => m.provider))].sort();
}

export function filterModels(models: any[], query: string, provider: string = "all"): any[] {
  let out = models;
  if (provider !== "all") out = out.filter((m) => m.provider === provider);
  const q = query.trim().toLowerCase();
  if (q) out = out.filter((m) => `${m.provider}/${m.id} ${m.name ?? ""}`.toLowerCase().includes(q));
  return out;
}
