import { Component, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

/**
 * Last line of defense against a blank window. An uncaught render/effect error
 * otherwise makes React unmount the whole tree — the app would silently go
 * dark (#161616, no UI, no clue). This boundary keeps a visible, actionable
 * error panel on screen instead.
 */
class FatalBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="grid h-full place-items-center p-8">
          <div className="w-full max-w-md rounded-2xl border border-err/30 bg-raised p-6 text-left">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-err">
              Babylon hit an unexpected error
            </p>
            <p className="mt-2 font-mono break-words text-[12px] leading-relaxed text-fg/80">
              {this.state.error.message || String(this.state.error)}
            </p>
            <button
              onClick={() => location.reload()}
              className="mt-5 rounded-lg bg-accent px-4 py-2 text-[13px] font-semibold text-bg hover:opacity-90"
            >
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById("root")!).render(
  <FatalBoundary>
    <App />
  </FatalBoundary>
);
