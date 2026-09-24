import React from "react";

interface Props {
  fallback: React.ReactNode;
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
  error: string | null;
}

export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { hasError: true, error: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: unknown, info: unknown) {
    // Suppress the error from bubbling to the global handler — we've rendered fallback.
    console.warn("[Babylon] diagram render error caught:", error, info);
  }

  render() {
    if (this.state.hasError) return this.props.fallback;
    return this.props.children;
  }
}

/** Pane-level fallback: a crashed transcript/composer isolates to its
 *  column instead of taking the whole app (and its sidebar/tabs) down.
 *  Transcripts live on disk and drafts in storage, so reload is safe. */
export function PaneCrashFallback({ name }: { name: string }) {
  return (
    <div className="grid flex-1 place-items-center p-8 min-h-0" role="alert">
      <div className="w-full max-w-sm rounded-2xl border border-err/30 bg-raised p-6 text-left">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-err">This {name} crashed</p>
        <p className="mt-2 text-[12px] leading-relaxed text-fg/80">
          Your chats are saved. Reload to restore this pane.
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
