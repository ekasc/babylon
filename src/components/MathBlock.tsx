import { useEffect, useRef, useState } from "react";

let ready: Promise<typeof import("katex")> | null = null;
function ensure(): Promise<typeof import("katex")> {
  ready ??= import("katex");
  return ready;
}

export default function MathBlock({ tex, display }: { tex: string; display: boolean }) {
  // One element slot for two branches (block div vs inline span): a callback
  // ref sidesteps the RefObject invariance between the two element types.
  const elRef = useRef<HTMLElement | null>(null);
  const setEl = (el: HTMLElement | null) => {
    elRef.current = el;
  };
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    ensure()
      .then((katex) => {
        // (Preserves the original guard's intent: skip when unmounted or
        // element-less. The previous `alive || !ref` spelling could never
        // render while mounted.)
        if (!alive || !elRef.current) return;
        try {
          katex.default.render(tex, elRef.current, {
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
  return display ? <div className="katex-display" ref={setEl} /> : <span className="katex-inline" ref={setEl} />;
}
