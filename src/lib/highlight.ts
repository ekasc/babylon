// Syntax highlighting via shiki core + JavaScript regex engine (no wasm needed).
// Dual light/dark themes are emitted as CSS variables; styles.css switches them
// under html.dark — the same approach T3 Code's shiki integration uses.

import type { HighlighterCore } from "shiki/core";

let hlPromise: Promise<HighlighterCore> | null = null;

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
      import("shiki/langs/python.mjs"),
      import("shiki/langs/go.mjs"),
      import("shiki/langs/rust.mjs"),
      import("shiki/langs/c.mjs"),
      import("shiki/langs/cpp.mjs"),
      import("shiki/langs/java.mjs"),
      import("shiki/langs/kotlin.mjs"),
      import("shiki/langs/swift.mjs"),
      import("shiki/langs/css.mjs"),
      import("shiki/langs/html.mjs"),
      import("shiki/langs/xml.mjs"),
      import("shiki/langs/yaml.mjs"),
      import("shiki/langs/toml.mjs"),
      import("shiki/langs/sql.mjs"),
      import("shiki/langs/markdown.mjs"),
      import("shiki/langs/diff.mjs"),
      import("shiki/langs/ruby.mjs"),
      import("shiki/langs/php.mjs"),
    ],
    engine: createJavaScriptRegexEngine(),
  }));
  return hlPromise;
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
  let l = lang ? (ALIASES[lang.toLowerCase()] ?? lang.toLowerCase()) : undefined;
  try {
    const hl = await load();
    if (!l || !hl.getLoadedLanguages().includes(l)) l = undefined;
    if (!l) return `<pre class="shiki shiki-plain"><code>${escapeHtml(code)}</code></pre>`;
    return hl.codeToHtml(code, {
      lang: l,
      themes: { light: "github-light", dark: "github-dark" },
      defaultColor: false,
    });
  } catch {
    return `<pre class="shiki shiki-plain"><code>${escapeHtml(code)}</code></pre>`;
  }
}
