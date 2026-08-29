import { useEffect, useState } from "react";

// PlantUML via public plantuml.com server. The code is encoded as a PlantUML
// URL (`@startuml … @enduml`) and rendered to SVG. Failures (offline, bad
// diagram) fall back to the raw source so the message is still readable.

function encode(text: string): string {
  // PlantUML's custom UTF-8 + base64-like alphabet.
  const utf8 = new TextEncoder().encode(text);
  let s = "";
  for (let i = 0; i < utf8.length; i++) {
    s += String.fromCharCode(utf8[i]);
  }
  return btoa(s)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export default function PlantUmlBlock({ code }: { code: string }) {
  const [state, setState] = useState<{ url: string } | { error: string } | null>(null);

  useEffect(() => {
    let alive = true;
    const url = `https://www.plantuml.com/plantuml/svg/${encode(code)}`;
    let img: HTMLImageElement | null = null;
    const finish = (s: typeof state) => {
      if (alive) setState(s);
    };
    img = new Image();
    img.onload = () => finish({ url });
    img.onerror = () => finish({ error: "PlantUML render failed (offline or invalid)" });
    img.src = url;
    return () => {
      alive = false;
      img = null;
    };
  }, [code]);

  if (!state) return <div className="mermaid-block" aria-label="PlantUML diagram" />;
  if ("error" in state) {
    return (
      <div className="mermaid-fallback">
        <p className="mermaid-error">{state.error}</p>
        <pre className="codeblock-fallback"><code>{code}</code></pre>
      </div>
    );
  }
  return <img className="plantuml-block" src={state.url} alt="PlantUML diagram" />;
}
