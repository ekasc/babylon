import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import React from "react";
import { bridge } from "../bridge";
import CodeBlock from "./CodeBlock";
import MermaidBlock from "./MermaidBlock";
import PlantUmlBlock from "./PlantUmlBlock";
import MathBlock from "./MathBlock";

function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  const el = node as any;
  if (el?.props?.children != null) return textOf(el.props.children);
  return "";
}

function findCode(node: ReactNode): { lang?: string; text: string } | null {
  if (Array.isArray(node)) {
    for (const n of node) {
      const r = findCode(n);
      if (r) return r;
    }
    return null;
  }
  const el = node as any;
  if (!el || typeof el !== "object") return null;
  if (el.type === "code") {
    const m = /language-([\w+#-]+)/.exec(String(el.props?.className ?? ""));
    return { lang: m?.[1], text: textOf(el.props?.children) };
  }
  return findCode(el.props?.children);
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function getNodeText(node: ReactNode): string {
  return textOf(node).trim();
}

/** Extract `// !annotation: …` lines from the code body so CodeBlock can render
 *  them as italic gray notes next to the matching line. Stored as
 *  `1: text`, `2: text`, etc., matching the line number. */
function extractAnnotations(code: string): string[] {
  const out: string[] = [];
  for (const line of code.split("\n")) {
    const m = /^\s*\/\/\s*!\s*@?(\d+)?[: ]+(.*)$/.exec(line);
    if (!m) continue;
    const lineNo = m[1] ? Number(m[1]) : out.length + 1;
    out[lineNo] = `${lineNo}: ${m[2].trim()}`;
  }
  // Filter to only keep lines that match a `1:`, `2:` etc.
  return out.filter(Boolean);
}

/** Strip annotation lines from the displayed code so they don't double up. */
function stripAnnotations(code: string): string {
  return code
    .split("\n")
    .filter((l) => !/^\s*\/\/\s*!/.test(l))
    .join("\n");
}

/** Inline `$…$` and block `$$…$$` math. Skips inside code spans. */
function processMath(text: string): string {
  let out = "";
  let i = 0;
  let inFence = false;
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      out += line + "\n";
      continue;
    }
    if (!inFence) {
      out += line + "\n";
    } else {
      out += line + "\n";
    }
    i += line.length + 1;
  }
  // Extract fenced-code ranges to skip them.
  const fences: Array<[number, number]> = [];
  const re = /```[\s\S]*?```|`[^`\n]*`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(out))) {
    if (m[0].startsWith("```")) {
      fences.push([m.index, m.index + m[0].length]);
    } else {
      fences.push([m.index, m.index + m[0].length]);
    }
  }
  const inFenceAt = (pos: number) => fences.some(([a, b]) => pos >= a && pos < b);
  let result = "";
  let j = 0;
  const blockRe = /\$\$([\s\S]+?)\$\$/g;
  let last = 0;
  while ((m = blockRe.exec(out))) {
    if (inFenceAt(m.index)) continue;
    result += out.slice(last, m.index) + `\u0000MATH_BLOCK\u0001${m[1]}\u0001\u0000`;
    last = m.index + m[0].length;
  }
  result += out.slice(last);
  const inlineRe = /\$([^$\n]+?)\$/g;
  let result2 = "";
  let k = 0;
  let last2 = 0;
  while ((m = inlineRe.exec(result))) {
    if (inFenceAt(m.index)) continue;
    result2 += result.slice(last2, m.index) + `\u0000MATH_INLINE\u0001${m[1]}\u0001\u0000`;
    last2 = m.index + m[0].length;
  }
  result2 += result.slice(last2);
  return result2;
}

/** Split math placeholders back into React text children alongside math. */
function renderTextWithMath(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = /\u0000MATH_(BLOCK|INLINE)\u0001([\s\S]+?)\u0001\u0000/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(<span key={`${keyBase}-t-${i++}`}>{text.slice(last, m.index)}</span>);
    nodes.push(
      <MathBlock
        key={`${keyBase}-m-${i++}`}
        tex={m[2].trim()}
        display={m[1] === "BLOCK"}
      />
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push(<span key={`${keyBase}-t-${i++}`}>{text.slice(last)}</span>);
  return nodes;
}

function MarkdownTable({ children, ...props }: React.ComponentProps<"table">) {
  const tableRef = useRef<HTMLTableElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleCopy = (format: "markdown" | "csv") => {
    const table = tableRef.current;
    if (!table || typeof navigator === "undefined" || !navigator.clipboard) return;
    const rows = [...table.querySelectorAll("tr")].map((tr) =>
      [...tr.querySelectorAll("th, td")].map((cell) => cell.textContent?.trim() ?? "")
    );
    if (!rows.length) return;
    let textOut = "";
    if (format === "markdown") {
      textOut = rows.map((r) => `| ${r.join(" | ")} |`).join("\n");
      if (rows.length > 1) textOut = [textOut.split("\n")[0], `| ${rows[0].map(() => "---").join(" | ")} |`, ...textOut.split("\n").slice(1)].join("\n");
    } else {
      textOut = rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(",")).join("\n");
    }
    void navigator.clipboard.writeText(textOut).then(() => {
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1200);
    });
  };
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);
  return (
    <div className="my-3 overflow-hidden rounded-lg border border-line bg-[var(--raised)]">
      <div className="overflow-x-auto">
        <table ref={tableRef} {...props} className="w-full text-[13px]" style={{ border: 0, margin: 0, borderRadius: 0 }}>
          {children}
        </table>
      </div>
      <div className="flex items-center justify-between border-t border-line bg-inset px-2 py-1">
        <button onClick={() => setExpanded((v) => !v)} aria-pressed={expanded} className="rounded px-2 py-1 text-[11px] text-dim hover:text-fg">
          {expanded ? "Collapse cells" : "Expand cells"}
        </button>
        <button onClick={() => handleCopy(expanded ? "csv" : "markdown")} className="rounded px-2 py-1 text-[11px] text-dim hover:text-fg">
          {copied ? "Copied" : expanded ? "Copy as CSV" : "Copy as Markdown"}
        </button>
      </div>
    </div>
  );
}

export default function Markdown({ text }: { text: string }) {
  const preprocessed = useMemo(() => processMath(text), [text]);
  const headingSlugs = useRef<Map<string, number>>(new Map());
  // Reset slugs per message so headings don't leak counts across renders
  headingSlugs.current.clear();

  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a
              href={href}
              onClick={(e) => {
                if (href) {
                  e.preventDefault();
                  try {
                    const url = new URL(href);
                    if (url.protocol === "https:" || url.protocol === "http:") {
                      void bridge.openExternal(url.toString()).catch(() => undefined);
                    }
                  } catch {
                    // Relative and malformed model-generated links are inert.
                  }
                }
              }}
            >
              {children}
            </a>
          ),
          table: ({ children, ...props }) => <MarkdownTable {...props}>{children}</MarkdownTable>,
          h1: ({ children, ...rest }) => headingWithAnchor({ children, level: 1, headingSlugs }),
          h2: ({ children }) => headingWithAnchor({ children, level: 2, headingSlugs }),
          h3: ({ children }) => headingWithAnchor({ children, level: 3, headingSlugs }),
          h4: ({ children }) => headingWithAnchor({ children, level: 4, headingSlugs }),
          h5: ({ children }) => headingWithAnchor({ children, level: 5, headingSlugs }),
          h6: ({ children }) => headingWithAnchor({ children, level: 6, headingSlugs }),
          pre: ({ children }) => {
            const found = findCode(children);
            if (found) {
              const lang = found.lang?.toLowerCase();
              if (lang === "mermaid") {
                const isDark = typeof document !== "undefined" && document.documentElement.classList.contains("dark");
                return <MermaidBlock code={found.text.replace(/\n$/, "")} theme={isDark ? "dark" : "light"} />;
              }
              if (lang === "plantuml" || lang === "puml") {
                return <PlantUmlBlock code={found.text.replace(/\n$/, "")} />;
              }
              if (lang === "ascii") {
                return <pre className="md-ascii">{found.text.replace(/\n$/, "")}</pre>;
              }
              const raw = found.text.replace(/\n$/, "");
              const annotations = extractAnnotations(raw);
              const code = stripAnnotations(raw);
              const collapsed = lang === "collapsed" || lang === "summary";
              return <CodeBlock code={code} lang={lang} collapsed={collapsed} annotations={annotations} />;
            }
            return (
              <pre>
                <code>{textOf(children)}</code>
              </pre>
            );
          },
          p: ({ children }) => {
            const textChildren = renderTextWithMath(textOf(children), "p");
            return <p>{textChildren}</p>;
          },
          li: ({ children, ...rest }) => {
            const input = (rest as any).checked;
            if (typeof input === "boolean") {
              return (
                <li className="md-task">
                  <span className={`md-task-box ${input ? "is-checked" : ""}`} aria-hidden="true">
                    {input ? "✓" : ""}
                  </span>
                  <span className={input ? "md-task-text is-checked" : "md-task-text"}>{children}</span>
                </li>
              );
            }
            // For non-task list items, render text with math.
            return <li>{renderTextWithMath(textOf(children), "li")}</li>;
          },
          blockquote: ({ children }) => {
            const raw = textOf(children);
            const m = /^\[!(NOTE|TIP|WARNING|CAUTION|IMPORTANT)\]\s*/i.exec(raw);
            if (m) {
              const kind = m[1].toLowerCase();
              const body = raw.slice(m[0].length);
              return <blockquote className={`callout callout-${kind}`}><strong className="callout-label">{m[1].toUpperCase()}</strong>{body}</blockquote>;
            }
            return <blockquote>{children}</blockquote>;
          },
        }}
      >
        {preprocessed}
      </ReactMarkdown>
    </div>
  );
}

function headingWithAnchor({ children, level, headingSlugs }: { children: ReactNode; level: number; headingSlugs: React.MutableRefObject<Map<string, number>> }) {
  const [copied, setCopied] = useState(false);
  const raw = getNodeText(children) || "";
  const base = slugify(raw) || `h-${level}`;
  const seen = headingSlugs.current.get(base) ?? 0;
  headingSlugs.current.set(base, seen + 1);
  const id = seen === 0 ? base : `${base}-${seen + 1}`;
  const safeLevel = Math.min(Math.max(level, 1), 6);
  const inner = (
    <>
      <a
        href={`#${id}`}
        className="md-heading-anchor"
        aria-label="Copy link to this section"
        onClick={(e) => {
          e.preventDefault();
          const url = `${location.origin}${location.pathname}#${id}`;
          void navigator.clipboard.writeText(url).catch(() => undefined);
          try {
            history.replaceState(null, "", `#${id}`);
          } catch {}
          setCopied(true);
          setTimeout(() => setCopied(false), 1100);
        }}
      >
        {children}
      </a>
      <span className={`md-heading-link ${copied ? "is-copied" : ""}`} aria-hidden="true">
        #
      </span>
    </>
  );
  return React.createElement(`h${safeLevel}`, { id, className: "md-heading" }, inner);
}
