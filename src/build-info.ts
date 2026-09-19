// Build identity for daemon skew detection. Injected per bundle at build time
// (esbuild define of __BABYLON_BUILD_ID__); "unknown" when running unbundled
// (vitest) or built without it.
declare const __BABYLON_BUILD_ID__: string | undefined;

export function buildId(): string {
  try {
    return typeof __BABYLON_BUILD_ID__ === "string" && __BABYLON_BUILD_ID__ ? __BABYLON_BUILD_ID__ : "unknown";
  } catch {
    return "unknown";
  }
}
