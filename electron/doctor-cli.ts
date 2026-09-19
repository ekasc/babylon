import { homedir } from "node:os";
import path from "node:path";
import { doctor } from "./doctor";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function defaultDataDir(): string {
  const override = process.env.BABYLON_DOCTOR_DATA_DIR;
  if (override) return override;
  const prod = process.argv.includes("--prod");
  const name = prod ? "Babylon" : "Babylon Dev";
  if (process.platform === "darwin") return path.join(homedir(), "Library", "Application Support", name);
  if (process.platform === "win32" && process.env.APPDATA) return path.join(process.env.APPDATA, name);
  return path.join(homedir(), ".config", name);
}

async function defaultStateDir(): Promise<string> {
  const override = process.env.BABYLON_DOCTOR_STATE_DIR;
  if (override) return override;
  try {
    const sdk = (await import("@earendil-works/pi-coding-agent")) as { getAgentDir?: () => string };
    if (typeof sdk.getAgentDir === "function") return path.join(sdk.getAgentDir(), "pideck-state");
  } catch {
    // Fall through to the conventional location.
  }
  return path.join(homedir(), ".pi", "agent", "pideck-state");
}

const dataDir = flag("--data-dir") ?? defaultDataDir();
const stateDir = flag("--state-dir") ?? (await defaultStateDir());
const sourceBuildId = process.env.BABYLON_SOURCE_BUILD_ID ?? "unknown";

const { findings, ok } = await doctor({ dataDir, stateDir, sourceBuildId });
for (const finding of findings) {
  const tag = finding.status === "pass" ? "PASS" : finding.status === "warn" ? "WARN" : "FAIL";
  console.log(`[${tag}] ${finding.detail ? `${finding.label} — ${finding.detail}` : finding.label}`);
  if (finding.remedy) console.log(`       Remedy: ${finding.remedy}`);
}
if (!ok) {
  console.log("doctor: problems found above.");
  process.exit(1);
}
console.log("doctor: all clear.");
