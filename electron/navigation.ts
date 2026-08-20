export function isTrustedRendererUrl(url: string, devUrl: string | undefined, productionUrl: string): boolean {
  try {
    const candidate = new URL(url);
    if (devUrl) return candidate.origin === new URL(devUrl).origin;
    const expected = new URL(productionUrl);
    return candidate.protocol === "file:" && candidate.href === expected.href;
  } catch {
    return false;
  }
}
