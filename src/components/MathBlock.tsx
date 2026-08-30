import { useEffect, useRef, useState } from "react";

let ready: Promise<typeof import("katex")> | null = null;
function ensure(): Promise<typeof import("katex")> {
  ready ??= import("katex");
  return ready;
}

export default function MathBlock({ tex, display }: { tex: string; display: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    ensure()
      .then((katex) => {
        if (!alive || !ref.current) return;
        try {
          katex.default.render(tex, ref.current, {
            throwOnError: false,
            displayMode: display,
            output: "html",
            strict: "ignore",
            trust: false,
          });
          setErr(null);
        } catch (e: unknown) {
          setErr(e instanceof Error ? e.message : String(e));
        }
      })
      .catch((e: unknown) => {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [tex, display]);

  if (err) {
    return (
      <code className={display ? "katex-fallback-block" : "katex-fallback"}>
        {display ? `$$${tex}$$` : `$${tex}$`}
      </code>
    );
  }
  return display ? <div className="katex-display" ref={ref as any} /> : <span className="katex-inline" ref={ref} />;
}
