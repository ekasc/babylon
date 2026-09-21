/**
 * Bridge-shape mappers for pi-host state (pure, unit-tested).
 *
 * The Pi SDK's model/stats objects are untyped at our boundary (`any`) and
 * may carry SDK internals the renderer must never depend on. These mappers
 * project exactly the bridge contract (AgentModel / SessionStats), coercing
 * or dropping anything unexpected instead of passing it through.
 */
import type { AgentModel, SessionStats, SessionTokenTotals } from "../src/bridge";

/** Runtime model shape: the SDK's declared fields plus the vision flags and
 *  capabilities runtimes actually carry (see settings vision detection). */
export interface RuntimeModelLike {
  provider?: unknown;
  id?: unknown;
  name?: unknown;
  contextWindow?: unknown;
  cost?: unknown;
  reasoning?: unknown;
  input?: unknown;
  supportsImages?: unknown;
  vision?: unknown;
  capabilities?: unknown;
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
const strArr = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined;

function costOf(v: unknown): AgentModel["cost"] {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  const out = { input: num(o.input), output: num(o.output), cacheRead: num(o.cacheRead) };
  return out.input == null && out.output == null && out.cacheRead == null ? undefined : out;
}

export function toAgentModel(m: RuntimeModelLike | null | undefined): AgentModel | null {
  if (!m || typeof m !== "object") return null;
  const provider = str(m.provider) ?? "";
  const id = str(m.id) ?? "";
  if (!provider || !id) return null;
  const caps = (typeof m.capabilities === "object" && m.capabilities !== null ? m.capabilities : null) as {
    vision?: unknown;
  } | null;
  return {
    provider,
    id,
    name: str(m.name),
    contextWindow: num(m.contextWindow),
    cost: costOf(m.cost),
    reasoning: bool(m.reasoning),
    supportsImages: bool(m.supportsImages),
    vision: bool(m.vision),
    input: strArr(m.input),
    capabilities: caps && typeof caps.vision === "boolean" ? { vision: caps.vision } : undefined,
  };
}

function tokensOf(v: unknown): SessionTokenTotals | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  const out: SessionTokenTotals = {
    total: num(o.total),
    input: num(o.input),
    output: num(o.output),
    cacheRead: num(o.cacheRead),
    cacheWrite: num(o.cacheWrite),
  };
  return Object.values(out).every((x) => x == null) ? undefined : out;
}

function contextUsageOf(v: unknown): SessionStats["contextUsage"] {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  const tokens = o.tokens == null ? undefined : num(o.tokens);
  const contextWindow = num(o.contextWindow);
  const percent = o.percent == null ? undefined : num(o.percent);
  return tokens === undefined && contextWindow === undefined && percent === undefined
    ? undefined
    : { tokens, contextWindow, percent };
}

export function toSessionStats(raw: unknown): SessionStats {
  const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    userMessages: num(o.userMessages),
    assistantMessages: num(o.assistantMessages),
    toolCalls: num(o.toolCalls),
    toolResults: num(o.toolResults),
    totalMessages: num(o.totalMessages),
    tokens: tokensOf(o.tokens),
    cost: num(o.cost),
    contextUsage: contextUsageOf(o.contextUsage),
  };
}
