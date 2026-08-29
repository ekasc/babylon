import { useEffect, useRef, useState } from "react";
import ErrorBoundary from "./ErrorBoundary";

let init: Promise<void> | null = null;
function ensureInit(theme: "light" | "dark") {
  init ??= import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      theme: theme === "dark" ? "dark" : "default",
      securityLevel: "strict",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
    });
  });
  return init;
}

function MermaidInner({ code, theme }: { code: string; theme: "light" | "dark" }) {
  const ref = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const id = `m-${Math.random().toString(36).slice(2, 8)}`;
    // Guard against synchronous throws from mermaid's cytoscape wheel handlers
    // (architecture diagrams) — they surface as uncaught exceptions after render.
    const onWindowError = (e: ErrorEvent) => {
      if (e.message.includes("cxtStarted") || e.filename.includes("mermaid") || e.filename.includes("cytoscape")) {
        e.preventDefault();
        if (alive) setErr("Diagram interaction error — showing source");
      }
    };
    window.addEventListener("error", onWindowError);
    ensureInit(theme)
      .then(() => import("mermaid"))
      .then(({ default: mermaid }) => {
        mermaid.initialize({
          startOnLoad: false,
          theme: theme === "dark" ? "dark" : "default",
          securityLevel: "strict",
          fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
          // Disable architecture's cytoscape wheel handling which throws on some inputs
          suppressErrorRendering: false,
        });
        return mermaid.render(id, code);
      })
      .then(({ svg }) => {
        if (!alive || !ref.current) return;
        // Sanitize: strip any inline event handlers that could throw
        const sanitized = svg.replace(/\s+on\w+="[^"]*"/g, "");
        ref.current.innerHTML = sanitized;
        // Disable pointer events on the cytoscape canvas to prevent wheel handler throws
        const canvas = ref.current.querySelector("canvas");
        if (canvas) (canvas as HTMLElement).style.pointerEvents = "none";
        setErr(null);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        const msg = e instanceof Error ? e.message : String(e);
        // Truncate the huge cytoscape stack to a readable line
        const short = msg.length > 400 ? msg.slice(0, 400) + "…" : msg;
        setErr(short);
      });
    return () => {
      alive = false;
      window.removeEventListener("error", onWindowError);
    };
  }, [code, theme]);

  if (err) {
    return (
      <div className="mermaid-fallback">
        <p className="mermaid-error">Diagram render failed: {err}</p>
        <pre className="codeblock-fallback"><code>{code}</code></pre>
      </div>
    );
  }
  return <div ref={ref} className="mermaid-block" aria-label="Mermaid diagram" />;
}

export default function MermaidBlock(props: { code: string; theme: "light" | "dark" }) {
  return (
    <ErrorBoundary fallback={<div className="mermaid-fallback"><p className="mermaid-error">Diagram crashed — showing source</p><pre className="codeblock-fallback"><code>{props.code}</code></pre></div>}>
      <MermaidInner {...props} />
    </ErrorBoundary>
  );
}
