import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ReactNode } from "react";
import { bridge } from "../bridge";
import CodeBlock from "./CodeBlock";

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

export default function Markdown({ text }: { text: string }) {
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
          pre: ({ children }) => {
            const found = findCode(children);
            if (found) return <CodeBlock code={found.text.replace(/\n$/, "")} lang={found.lang} />;
            return (
              <pre>
                <code>{textOf(children)}</code>
              </pre>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
