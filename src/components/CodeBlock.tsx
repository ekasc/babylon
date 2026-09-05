import { useEffect, useState } from "react";
import { cachedHighlight, highlight } from "../lib/highlight";
import { cachedHighlightEffect, highlightEffect } from "../lib/highlight.effect";
import * as Effect from "effect/Effect";

interface Props {
  code: string;
  lang?: string;
  /** Hide the header bar (used for tool output). */
  bare?: boolean;
  /** Start collapsed: a one-line summary, click to expand. */
  collapsed?: boolean;
  /** Optional annotation lines: lines starting with `// !` render in italic gray next to the hunk they precede. */
  annotations?: string[];
}

export default function CodeBlock({ code, lang, bare, collapsed: startCollapsed, annotations = [] }: Props) {
  const [html, setHtml] = useState<string | null>(() => Effect.runSync(cachedHighlightEffect(code, lang)));
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(startCollapsed ? false : true);
  const [lineToast, setLineToast] = useState<number | null>(null);

  useEffect(() => {
    if (Effect.runSync(cachedHighlightEffect(code, lang)) != null) return; // nothing to re-render
    let alive = true;
    const timer = setTimeout(() => {
      Effect.runPromise(highlightEffect(code, lang))
        .then((h) => {
          if (alive) setHtml(h);
        })
        .catch(() => {
          if (alive) setHtml(null);
        });
    }, 16);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [code, lang]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable */
    }
  };

  const copyLine = async (line: string, lineNo: number) => {
    try {
      await navigator.clipboard.writeText(line);
      setLineToast(lineNo);
      setTimeout(() => setLineToast((n) => (n === lineNo ? null : n)), 900);
    } catch {
      /* ignore */
    }
  };

  const copyWithContext = async (line: string, idx: number) => {
    const all = code.split("\n");
    const start = Math.max(0, idx - 3);
    const end = Math.min(all.length, idx + 4);
    const slice = all.slice(start, end).join("\n");
    try {
      await navigator.clipboard.writeText(slice);
      setLineToast(idx);
      setTimeout(() => setLineToast((n) => (n === idx ? null : n)), 900);
    } catch {
      /* ignore */
    }
  };

  const lines = code.split("\n");
  const summary = `${lines.length} line${lines.length === 1 ? "" : "s"}`;

  if (startCollapsed && !open) {
    return (
      <div className="codeblock codeblock-collapsed">
        {!bare && (
          <div className="codeblock-bar">
            <span>{lang ?? "text"}</span>
            <span className="text-dim">{summary}</span>
          </div>
        )}
        <button
          onClick={() => setOpen(true)}
          className="codeblock-collapse-toggle"
          aria-label={`Expand ${lang ?? "text"} block`}
        >
          Show code <span className="text-dim">— {summary}</span>
        </button>
      </div>
    );
  }

  const isShell = lang ? ["shell", "shellscript", "bash", "sh", "zsh", "console"].includes(lang.toLowerCase()) : false;
  return (
    <div className={`codeblock ${isShell ? "is-shell" : ""}`} data-language={lang ?? "text"}>
      {!bare && (
        <div className="codeblock-bar">
          <span>{lang ?? "text"}</span>
          <span className="text-dim">{summary}</span>
          <button onClick={copy} aria-label={`Copy ${lang ?? "text"} code`} className="cursor-pointer rounded px-2 py-1 hover:bg-inset hover:text-fg">
            {copied ? "copied ✓" : "copy"}
          </button>
        </div>
      )}
      {html ? (() => {
          const inner = html.replace(/^<pre[^>]*><code[^>]*>/, "").replace(/<\/code><\/pre>\s*$/, "");
          let lineHtmls: string[];
          if (inner.includes('class="line"')) {
            const rawLines = inner.split("\n");
            lineHtmls = rawLines.map((l) => {
              const m = l.match(/^<span class="line">(.*)<\/span>$/);
              return m ? m[1] : l;
            });
          } else {
            lineHtmls = inner.split("\n");
          }
          return (
            <div className="codeblock-linewrap">
              {lines.map((line, i) => {
                const annotation = annotations.find((a) => a.startsWith(`${i + 1}:`));
                const htmlLine = lineHtmls[i] ?? (line ? lineShiki(line) : " ");
                return (
                  <div
                    key={i}
                    className={`codeblock-line ${lineToast === i ? "is-toast" : ""}`}
                    onClick={(e) => {
                      if ((e.target as HTMLElement).closest("button")) return;
                      if (e.altKey || e.metaKey) copyWithContext(line, i);
                      else copyLine(line, i);
                    }}
                    title="Click to copy · Alt/⌘-Click for ±3 lines"
                  >
                    <span className="codeblock-lineno">{i + 1}</span>
                    <span className="codeblock-linebody shiki" dangerouslySetInnerHTML={{ __html: htmlLine || " " }} />
                    {annotation ? <span className="codeblock-note">// {annotation.slice(annotation.indexOf(":") + 1).trim()}</span> : null}
                  </div>
                );
              })}
            </div>
          );
        })() : (
        <pre className="codeblock-fallback">
          {lines.map((line, i) => (
            <div key={i} className="codeblock-line">
              <span className="codeblock-lineno">{i + 1}</span>
              <span className="codeblock-linebody"><code>{line}</code></span>
            </div>
          ))}
        </pre>
      )}
    </div>
  );
}

// Render a single line through Shiki so the colors stay consistent with the
// surrounding highlighted block. Reusing the cached HTML for the full block
// would require parsing it — instead we re-highlight per line on demand and
// keep the cost bounded by the line length.
function lineShiki(line: string): string {
  if (!line) return " ";
  const cached = Effect.runSync(cachedHighlightEffect(line));
  if (cached) {
    // Strip the wrapper <pre><code>…</code></pre> so we can splice just the inner HTML.
    return cached.replace(/^<pre[^>]*><code[^>]*>/, "").replace(/<\/code><\/pre>$/, "");
  }
  return line.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c] ?? c);
}
