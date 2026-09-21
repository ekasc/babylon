/**
 * Pure argument helpers for the in-app browser tools (sim-tools.ts).
 *
 * The tool `execute` callbacks run in Electron main against a live
 * SimController, so they can't unit-test. Everything branchy about their
 * inputs lives here instead: required-field validation, tab-id parsing,
 * preset checks, and result formatting. Same error strings as the inline
 * versions so agent-visible behavior is unchanged.
 */
import { SIM_PRESETS } from "../src/lib/simulator";

export const PRESET_IDS = SIM_PRESETS.map((p) => p.id);

export function textResult(t: string) {
  return { content: [{ type: "text" as const, text: t }], details: { text: t } };
}

export function tabParam(description = "Tab id (defaults to the active tab; see browser_list_tabs)"): unknown {
  return { type: "string", description };
}

/** Tab id that defaults to the active tab: null means "active". */
export function parseTabArg(raw: unknown): string | null {
  const tab = (raw as { tab?: unknown } | null | undefined)?.tab;
  return typeof tab === "string" && tab ? tab : null;
}

/** Tab id that defaults to the active tab: undefined means "active". */
export function parseTabArgOptional(raw: unknown): string | undefined {
  const tab = (raw as { tab?: unknown } | null | undefined)?.tab;
  return typeof tab === "string" && tab ? tab : undefined;
}

/** Trimmed required URL, or throws the tool's established error. */
export function requireUrl(raw: unknown, toolName: string): string {
  const url = String((raw as { url?: unknown } | null | undefined)?.url ?? "").trim();
  if (!url) throw new Error(`${toolName}: url is required`);
  return url;
}

/** Trimmed required selector, or throws the tool's established error. */
export function requireSelector(raw: unknown, toolName: string): string {
  const selector = String((raw as { selector?: unknown } | null | undefined)?.selector ?? "");
  if (!selector) throw new Error(`${toolName}: selector is required`);
  return selector;
}

/** Required tab id for browser_activate_tab. */
export function requireTabId(raw: unknown): string {
  const tab = String((raw as { tab?: unknown } | null | undefined)?.tab ?? "").trim();
  if (!tab) throw new Error("browser_activate_tab: tab is required");
  return tab;
}

export function checkPreset(raw: unknown): string {
  const preset = String(raw ?? "");
  if (!PRESET_IDS.includes(preset)) throw new Error(`unknown preset ${preset || "(missing)"} — one of: ${PRESET_IDS.join(", ")}`);
  return preset;
}

/** Pick the tab to reuse for browser_open: the active tab unless newTab. */
export function reuseTabId(activeId: string | null, newTab: unknown): string | undefined {
  return newTab === true || !activeId ? undefined : activeId;
}

export interface TabListEntry {
  id: string;
  url: string;
  title: string | null;
}

/** Rendered tab list for browser_list_tabs ("No browser tabs open." when empty). */
export function formatTabList(tabs: TabListEntry[], activeId: string | null): string {
  if (!tabs.length) return "No browser tabs open.";
  return tabs.map((t) => `${t.id === activeId ? "●" : "○"} ${t.id} — ${t.title || "(no title)"} · ${t.url}`).join("\n");
}

/** Emulation label for browser_emulate results, with landscape suffix. */
export function emulateResult(preset: string, rotated: unknown): string {
  const label = SIM_PRESETS.find((p) => p.id === preset)?.label ?? preset;
  return `Emulating ${label}${rotated === true ? " (landscape)" : ""}`;
}

export interface SnapshotLike {
  url: string;
  title: string;
  text: string;
  a11y: string;
}

/** Full browser_snapshot body: URL/title/text plus the ref tree section. */
export function snapshotBody(snap: SnapshotLike): string {
  const body = [`URL: ${snap.url}\nTitle: ${snap.title || "(none)"}\n\n${snap.text || "(no text)"}`];
  if (snap.a11y) body.push(`Interactive elements (click/fill with selector "ref:N"):\n${snap.a11y}`);
  return body.join("\n\n");
}
