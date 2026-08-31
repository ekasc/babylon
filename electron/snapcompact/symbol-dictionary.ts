// Exact-token symbol dictionary extraction.
//
// Scans a serialized transcript for high-value tokens a coding agent must
// retrieve verbatim (paths, shas, branches, urls, package versions, commands,
// env vars, ports, identifiers). The dictionary is the only piece of the
// archive that ships as raw text; the rasterized transcript substitutes
// repeated long values with [E001] etc. so dense layout survives a vision
// model better than raw repetition.
//
// Deterministic, no LLM. Each token gets a stable ID within the archive
// generation (E001, E002, ...).

export type RawSymbolKind =
  | "path" | "sha" | "branch" | "url" | "version" | "command" | "env" | "port" | "identifier";

export interface RawSymbol {
  value: string;
  kind: RawSymbolKind;
}

const SHA_RE = /\b[0-9a-f]{7,40}\b/g;
const URL_RE = /\bhttps?:\/\/[^\s<>"'`)\]}]+/g;
const SEMVER_RE = /(?<![A-Za-z0-9_])(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?![A-Za-z0-9_])/g;
const BRANCH_HINT_RE = /\b(?:branch|checkout|switch(?:ed)? to|on branch|on)\s+[`'"]?([A-Za-z0-9._\-\/]+)[`'"]?/gi;

const PATH_HINT_RE = /(?:^|[\s'"`(])(?:\.{0,2}\/)?(?:[A-Za-z0-9_.@+-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]+/g;
const ABS_PATH_RE = /(?<![A-Za-z0-9_])\/(?:Users|home|var|tmp|opt|srv|etc)\/[A-Za-z0-9._\-\/]+/g;
const REL_PATH_RE = /(?:^|[\s'"`(])((?:\.\.?\/|[A-Za-z0-9_.@+-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]+)/g;

const ENV_RE = /\$\{?([A-Z][A-Z0-9_]{1,})\}?|(?<![A-Za-z0-9_])([A-Z][A-Z0-9_]{2,})=/g;
const PORT_RE = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})\b/g;
const COMMAND_RE = /(?:`|\b)(npm|pnpm|yarn|bun|node|python|python3|pip|go|cargo|make|git|docker|kubectl|terraform|cargo|swift|xcodebuild)\s+[^\n`]{2,200}/g;

const IDENT_RE = /(?:function|class|interface|type|const|let|var|method|def|fn|struct|enum)\s+([A-Za-z_][A-Za-z0-9_]{2,})/g;

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "when", "then",
  "true", "false", "null", "undefined", "return", "while", "break", "continue",
  "string", "number", "boolean", "object", "function",
]);

function uniqPush(out: Map<string, RawSymbol>, value: string, kind: RawSymbolKind): void {
  if (!value) return;
  if (out.has(value)) return;
  out.set(value, { value, kind });
}

function isLikelyPath(value: string): boolean {
  if (value.length < 4 || value.length > 512) return false;
  if (/\s/.test(value)) return false;
  if (!value.includes("/") && !value.includes(".")) return false;
  if (/^\d+$/.test(value.replace(/[./]/g, ""))) return false;
  if (STOPWORDS.has(value)) return false;
  return true;
}

function isLikelyIdentifier(value: string): boolean {
  if (value.length < 4 || value.length > 80) return false;
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value)) return false;
  if (STOPWORDS.has(value)) return false;
  if (value === value.toLowerCase() && value.length < 6) return false;
  return true;
}

export function extractHighValueTokens(text: string): RawSymbol[] {
  const out = new Map<string, RawSymbol>();
  if (!text) return [];
  let m: RegExpExecArray | null;

  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(text))) uniqPush(out, m[0], "url");

  SEMVER_RE.lastIndex = 0;
  while ((m = SEMVER_RE.exec(text))) uniqPush(out, m[1], "version");

  SHA_RE.lastIndex = 0;
  while ((m = SHA_RE.exec(text))) {
    const v = m[0];
    if (/^[0-9a-f]{7,40}$/.test(v) && v.match(/[0-9a-f]/g)!.length >= 7) uniqPush(out, v, "sha");
  }

  BRANCH_HINT_RE.lastIndex = 0;
  while ((m = BRANCH_HINT_RE.exec(text))) uniqPush(out, m[1], "branch");

  ABS_PATH_RE.lastIndex = 0;
  while ((m = ABS_PATH_RE.exec(text))) uniqPush(out, m[0], "path");
  PATH_HINT_RE.lastIndex = 0;
  while ((m = PATH_HINT_RE.exec(text))) {
    if (isLikelyPath(m[0].trim())) uniqPush(out, m[0].trim(), "path");
  }
  REL_PATH_RE.lastIndex = 0;
  while ((m = REL_PATH_RE.exec(text))) {
    const v = m[1];
    if (isLikelyPath(v)) uniqPush(out, v, "path");
  }

  PORT_RE.lastIndex = 0;
  while ((m = PORT_RE.exec(text))) uniqPush(out, m[1], "port");

  ENV_RE.lastIndex = 0;
  while ((m = ENV_RE.exec(text))) {
    const name = m[1] || m[2];
    if (name && /^[A-Z][A-Z0-9_]+$/.test(name) && name.length >= 3) uniqPush(out, name, "env");
  }

  COMMAND_RE.lastIndex = 0;
  while ((m = COMMAND_RE.exec(text))) {
    let cmd = m[0].replace(/^[`\s]+|[`\s]+$/g, "");
    if (cmd.length > 2) uniqPush(out, cmd, "command");
  }

  IDENT_RE.lastIndex = 0;
  while ((m = IDENT_RE.exec(text))) {
    if (isLikelyIdentifier(m[1])) uniqPush(out, m[1], "identifier");
  }

  return [...out.values()];
}

/** Assign deterministic IDs (E001..E999) in value-order. */
export function assignIds(symbols: RawSymbol[]): { id: string; value: string; kind: RawSymbolKind }[] {
  return symbols.map((s, i) => ({ id: `E${String(i + 1).padStart(3, "0")}`, value: s.value, kind: s.kind }));
}
