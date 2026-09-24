import { useEffect, useState } from "react";
import { encodePlantUml } from "../lib/plantuml";

// PlantUML has no local renderer: the diagram source is sent to the public
// plantuml.com server for SVG rendering. That is third-party exfiltration of
// conversation content, so it never happens implicitly — the source renders
// with an explicit "load remote preview" choice per diagram. The shipped CSP
// allowlists only that host for images (see index.html); nothing is fetched
// until the user opts in.

export default function PlantUmlBlock({ code }: { code: string }) {
  const [consent, setConsent] = useState(false);
  const [state, setState] = useState<{ url: string } | { error: string } | null>(null);

  useEffect(() => {
    if (!consent) return;
    let alive = true;
    let img: HTMLImageElement | null = null;
    const finish = (s: NonNullable<typeof state>) => {
      if (alive) setState(s);
    };
    encodePlantUml(code).then(
      (encoded) => {
        if (!alive) return;
        const url = `https://www.plantuml.com/plantuml/svg/${encoded}`;
        img = new Image();
        img.onload = () => finish({ url });
        img.onerror = () => finish({ error: "Preview unavailable (offline, blocked, or invalid input)" });
        img.src = url;
      },
      () => finish({ error: "Preview unavailable (this browser cannot encode the diagram)" })
    );
    return () => {
      alive = false;
      img = null;
    };
  }, [code, consent]);

  if (state && "url" in state) {
    return <img className="plantuml-block" src={state.url} alt="PlantUML diagram" />;
  }
  return (
    <div className="mermaid-block" aria-label="PlantUML diagram">
      <pre className="codeblock-fallback"><code>{code}</code></pre>
      {"error" in (state ?? {}) ? (
        <p className="mermaid-error">{(state as { error: string }).error}</p>
      ) : (
        <button
          type="button"
          onClick={() => setConsent(true)}
          className="mt-2 rounded-md border border-line px-2.5 py-1 text-[12px] text-dim hover:text-fg"
        >
          Load remote preview (sends diagram to plantuml.com)
        </button>
      )}
    </div>
  );
}
