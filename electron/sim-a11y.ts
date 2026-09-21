/**
 * Accessibility-tree condensing for browser snapshots (T3-style a11y trees).
 *
 * Pure CDP JSON handling with no Electron imports, so it unit tests in
 * vitest. The controller fetches `Accessibility.getFullAXTree` through its
 * existing debugger channel; this module turns the node soup into a compact
 * `[ref] role "name"` ledger. Refs resolve through fresh trees at click/fill
 * time and are valid until navigation.
 */

import { isArrayOf, isString, wireOf } from "../src/lib/wire";

export interface AxNodeJson {
  nodeId: string;
  role?: { value?: string };
  name?: { value?: string };
  value?: { value?: string | number };
  description?: { value?: string };
  backendDOMNodeId?: number;
  childIds?: string[];
  ignored?: boolean;
}

export interface AxRef {
  ref: number;
  backendDOMNodeId: number;
}

export interface CondensedAxTree {
  /** Rendered ledger, capped. Empty when the page exposes nothing useful. */
  text: string;
  /** ref -> backend DOM node for click/fill resolution. */
  refs: AxRef[];
  /** Total kept nodes before the node cap (for the truncation note). */
  keptNodes: number;
  /** True when output was cut by a cap. */
  truncated: boolean;
}

export const AX_MAX_NODES = 250;
export const AX_MAX_CHARS = 6000;
const AX_FIELD_CHARS = 100;

/** Structural/text nodes already covered by the rendered-text snapshot. */
const SKIPPED_ROLES = new Set(["StaticText", "InlineTextBox", "LineBreak", "none", "None"]);

/** Parse a `ref:N` selector from browser_click/browser_fill. */
export function parseAxRefSelector(selector: string): number | null {
  const match = /^ref:(\d+)$/.exec(selector.trim());
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

function field(value: unknown): string {
  const s = String(value ?? "").replace(/\s+/g, " ").trim();
  return s.length > AX_FIELD_CHARS ? `${s.slice(0, AX_FIELD_CHARS)}…` : s;
}

export function condenseAxTree(nodes: unknown[]): CondensedAxTree {
  // CDP payloads are unvalidated: gate the fields that can crash
  // (node identity, child iteration, backend ref numbers). Everything
  // else stays optional-chained at render, degrading gracefully.
  const clean: AxNodeJson[] = [];
  for (const n of nodes) {
    const w = wireOf(n);
    if (!w || typeof w.nodeId !== "string") continue;
    const childIds = isArrayOf(w.childIds, isString) ? w.childIds : undefined;
    const backendDOMNodeId = typeof w.backendDOMNodeId === "number" ? w.backendDOMNodeId : undefined;
    // CDP extras pass through untouched: the renderer optional-chains every
    // display field, so unknown keys degrade gracefully. This is the one
    // place the raw shape is asserted — narrowing it further would change
    // what the snapshot shows, not make it safer.
    clean.push({ ...(w as Partial<AxNodeJson>), nodeId: w.nodeId, childIds, backendDOMNodeId });
  }
  const byId = new Map<string, AxNodeJson>();
  const childed = new Set<string>();
  for (const n of clean) {
    byId.set(n.nodeId, n);
    for (const c of n.childIds ?? []) childed.add(c);
  }
  const roots = clean.filter((n) => !childed.has(n.nodeId));
  const lines: string[] = [];
  const refs: AxRef[] = [];
  let kept = 0;
  let truncated = false;

  const emit = (node: AxNodeJson): void => {
    const role = node.role?.value ?? "unknown";
    if (node.ignored) return;
    if (SKIPPED_ROLES.has(role)) {
      // Transparent wrapper: static text lives in the rendered-text part.
      for (const c of node.childIds ?? []) {
        const child = byId.get(c);
        if (child) emit(child);
      }
      return;
    }
    if (role === "Generic" && !node.name?.value && node.value?.value == null) {
      for (const c of node.childIds ?? []) {
        const child = byId.get(c);
        if (child) emit(child);
      }
      return;
    }
    kept += 1;
    if (kept > AX_MAX_NODES) {
      truncated = true;
      return;
    }
    const parts = [role];
    const name = field(node.name?.value);
    if (name) parts.push(`"${name}"`);
    if (node.value?.value != null && node.value.value !== "") parts.push(`value="${field(node.value.value)}"`);
    if (typeof node.backendDOMNodeId === "number") {
      const ref = refs.length + 1;
      refs.push({ ref, backendDOMNodeId: node.backendDOMNodeId });
      lines.push(`[${ref}] ${parts.join(" ")}`);
    } else {
      lines.push(parts.join(" "));
    }
    for (const c of node.childIds ?? []) {
      const child = byId.get(c);
      if (child) emit(child);
    }
  };

  for (const r of roots) emit(r);
  let text = lines.join("\n");
  if (text.length > AX_MAX_CHARS) {
    truncated = true;
    text = `${text.slice(0, AX_MAX_CHARS)}…`;
  }
  if (truncated) text += `\n… (${kept} elements, showing first ${refs.length} refs)`;
  return { text, refs, keptNodes: kept, truncated };
}
