import { useEffect, useState } from "react";
import { highlight } from "../lib/highlight";

interface Props {
  code: string;
  lang?: string;
  /** Hide the header bar (used for tool output). */
  bare?: boolean;
}

export default function CodeBlock({ code, lang, bare }: Props) {
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    // Small debounce: streaming markdown churns code blocks per delta.
    const timer = setTimeout(() => {
      highlight(code, lang)
        .then((h) => {
          if (alive) setHtml(h);
        })
        .catch(() => {
          if (alive) setHtml(null);
        });
    }, 120);
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

  return (
    <div className="codeblock">
      {!bare && (
        <div className="codeblock-bar">
          <span>{lang ?? "text"}</span>
          <button onClick={copy} className="hover:text-fg">
            {copied ? "copied ✓" : "copy"}
          </button>
        </div>
      )}
      {html ? (
        <div dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="codeblock-fallback">
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}
