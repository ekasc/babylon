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

const INTEGER = new Intl.NumberFormat("en-US");

export function formatTokens(n?: number): string {
  if (n == null) return "0";
  const abs = Math.abs(n);
  if (abs >= 1e12) return `${trim(n / 1e12)}T`;
  if (abs >= 1e9) return `${trim(n / 1e9)}B`;
  if (abs >= 1e6) return `${trim(n / 1e6)}M`;
  if (abs >= 1e3) return `${trim(n / 1e3)}K`;
  return INTEGER.format(Math.round(n));
}

function trim(value: number): string {
  const abs = Math.abs(value);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return value.toFixed(digits).replace(/\.0+$/, "");
}
