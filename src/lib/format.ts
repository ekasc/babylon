export function formatContextWindow(n?: number): string {
  if (!n) return "—";
  if (n >= 1000000) return `${(n / 1000000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

export function formatNumber(n?: number): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString();
}

import { formatTokens as formatTokensRaw } from "./usageFormat";
export function formatTokens(n?: number): string {
  if (n == null) return "0";
  return formatTokensRaw(n);
}

export function formatContextPercent(pct?: number, tokens?: number, win?: number): string {
  if (pct == null) return "—";
  const pctStr = `${pct.toFixed(1)}%`;
  if (tokens != null && win) return `${pctStr}/${formatTokens(win)}`;
  return pctStr;
}
