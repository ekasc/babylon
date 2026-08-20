// Syntax highlighting via shiki core + JavaScript regex engine (no wasm needed).
// Dual light/dark themes are emitted as CSS variables; styles.css switches them
// under html.dark — the same approach T3 Code's shiki integration uses.
//
// Languages are split into a small eager core (the ones in nearly every agent
// session) and everything else loaded on demand per language, so the first code
// block never pays for the heavy grammars (cpp alone is ~800 KB).

import type { HighlighterCore } from "shiki/core";

const CORE_LANGS = [
  "typescript",
  "javascript",
  "tsx",
  "jsx",
  "json",
  "shellscript",
  "markdown",
  "diff",
  "yaml",
  "python",
] as const;

const HEAVY_LANGS: Record<string, () => Promise<unknown>> = {
  c: () => import("shiki/langs/c.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  kotlin: () => import("shiki/langs/kotlin.mjs"),
  swift: () => import("shiki/langs/swift.mjs"),
  ruby: () => import("shiki/langs/ruby.mjs"),
  php: () => import("shiki/langs/php.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  xml: () => import("shiki/langs/xml.mjs"),
};

let hlPromise: Promise<HighlighterCore> | null = null;
const langLoads = new Map<string, Promise<void>>();

// Shiki budget: at most two highlights run at once, the rest queue in mount
// order (visible blocks mount first). Keeps tokenization off the critical
// path without ever queueing a mega-block.
export const MAX_HIGHLIGHT_BYTES = 50 * 1024;
const MAX_CONCURRENT = 2;
let activeHighlights = 0;
const highlightQueue: Array<() => Promise<void>> = [];

function pump(): void {
  while (activeHighlights < MAX_CONCURRENT && highlightQueue.length) {
    const run = highlightQueue.shift()!;
    activeHighlights++;
    void run().finally(() => {
      activeHighlights--;
      pump();
    });
  }
}

function queued<T>(job: () => T | Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    highlightQueue.push(() => Promise.resolve(job()).then(resolve, reject));
    pump();
  });
}

// Highlight render cache, keyed by lang + content hash with a bounded LRU.
// Re-mounted code blocks (session switches, list reconciliation) render
// highlighted instantly instead of popping from plain text, which is what
// removes the syntax-highlight flicker during switches.
const CACHE_CAP = 300;
const highlightCache = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();

function cacheKey(code: string, lang: string | undefined): string {
  let hash = 5381;
  for (let i = 0; i < code.length; i++) hash = ((hash << 5) + hash + code.charCodeAt(i)) >>> 0;
  return `${lang ?? ""}:${code.length}:${hash}`;
}

/** Synchronous cache lookup for a block's rendered html, or null. */
export function cachedHighlight(code: string, lang?: string): string | null {
  return highlightCache.get(cacheKey(code, lang)) ?? null;
}

function load(): Promise<HighlighterCore> {
  hlPromise ??= Promise.all([import("shiki/core"), import("shiki/engine/javascript")]).then(
    ([{ createHighlighterCore }, { createJavaScriptRegexEngine }]) => createHighlighterCore({
    themes: [import("shiki/themes/github-light.mjs"), import("shiki/themes/github-dark.mjs")],
    langs: [
      import("shiki/langs/typescript.mjs"),
      import("shiki/langs/javascript.mjs"),
      import("shiki/langs/tsx.mjs"),
      import("shiki/langs/jsx.mjs"),
      import("shiki/langs/json.mjs"),
      import("shiki/langs/shellscript.mjs"),
      import("shiki/langs/markdown.mjs"),
      import("shiki/langs/diff.mjs"),
      import("shiki/langs/yaml.mjs"),
      import("shiki/langs/python.mjs"),
    ],
    engine: createJavaScriptRegexEngine(),
  }));
  return hlPromise;
}

/** Loads a non-core grammar once, on first use; concurrent callers share one promise. */
async function loadLang(hl: HighlighterCore, lang: string): Promise<void> {
  const factory = HEAVY_LANGS[lang];
  if (!factory || hl.getLoadedLanguages().includes(lang)) return;
  if (!langLoads.has(lang)) {
    langLoads.set(
      lang,
      factory()
        .then((module) => hl.loadLanguage(((module as { default?: unknown }).default ?? module) as any))
        .catch(() => undefined)
    );
  }
  await langLoads.get(lang);
}

const ALIASES: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  sh: "shellscript",
  shell: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  console: "shellscript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  golang: "go",
  kt: "kotlin",
  yml: "yaml",
  md: "markdown",
  "c++": "cpp",
  h: "c",
  hpp: "cpp",
  objectivec: "objective-c",
  plaintext: "markdown",
};

const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  mts: "typescript",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  json: "json",
  sh: "shellscript",
  bash: "shellscript",
  py: "python",
  go: "go",
  rs: "rust",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cc: "cpp",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  css: "css",
  scss: "css",
  html: "html",
  htm: "html",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  sql: "sql",
  md: "markdown",
  diff: "diff",
  patch: "diff",
  rb: "ruby",
  php: "php",
};

export function langFromPath(path: string): string | undefined {
  const ext = path.split("/").pop()?.split(".").pop()?.toLowerCase();
  return ext ? EXT_TO_LANG[ext] : undefined;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Returns a `<pre class="shiki …">` html string, or a plain escaped fallback. */
export async function highlight(code: string, lang?: string): Promise<string> {
  if (code.length > MAX_HIGHLIGHT_BYTES) {
    return `<pre class="shiki shiki-plain"><code>${escapeHtml(code)}</code></pre>`;
  }
  const key = cacheKey(code, lang);
  const cached = highlightCache.get(key);
  if (cached) return cached;
  const pending = inflight.get(key);
  if (pending) return pending;
  const work = renderHighlight(code, lang).then((html) => {
    if (highlightCache.size >= CACHE_CAP) {
      const oldest = highlightCache.keys().next().value;
      if (oldest !== undefined) highlightCache.delete(oldest);
    }
    highlightCache.set(key, html);
    inflight.delete(key);
    return html;
  });
  inflight.set(key, work);
  return work;
}

async function renderHighlight(code: string, lang?: string): Promise<string> {
  let l = lang ? (ALIASES[lang.toLowerCase()] ?? lang.toLowerCase()) : undefined;
  try {
    const hl = await load();
    if (l && !hl.getLoadedLanguages().includes(l)) {
      if (HEAVY_LANGS[l]) await loadLang(hl, l);
      else l = undefined;
    }
    if (!l) return `<pre class="shiki shiki-plain"><code>${escapeHtml(code)}</code></pre>`;
    const langName = l;
    return queued(() =>
      hl.codeToHtml(code, {
        lang: langName,
        themes: { light: "github-light", dark: "github-dark" },
        defaultColor: false,
      })
    );
  } catch {
    return `<pre class="shiki shiki-plain"><code>${escapeHtml(code)}</code></pre>`;
  }
}
