import { useEffect, useState } from "react";
import { PrototypeSwitcher } from "./switcher";
import { VariantRail } from "./VariantRail";
import { VariantInbox } from "./VariantInbox";
import { VariantTimeline } from "./VariantTimeline";

// THROWAWAY UI PROTOTYPE. Question: what should the session sidebar look like?
// Three structurally different variants, switchable via ?variant=A|B|C.

const VARIANTS = ["A", "B", "C"] as const;
type Variant = (typeof VARIANTS)[number];

const NAMES: Record<Variant, string> = {
  A: "Activity rail (two-pane)",
  B: "Inbox (state-first)",
  C: "Timeline (time-first)",
};

function readVariant(): Variant {
  const v = (new URLSearchParams(location.search).get("variant") ?? "A").toUpperCase();
  return (VARIANTS as readonly string[]).includes(v) ? (v as Variant) : "A";
}

/** Mock main pane so variants are judged in context, not in a vacuum. */
function MockChat() {
  return (
    <div className="flex min-w-0 flex-1 flex-col bg-bg">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-4">
        <span className="text-[13px] font-semibold">Streaming render perf</span>
        <span className="rounded bg-inset px-1.5 py-0.5 font-mono text-[10px] text-dim">babylon</span>
      </header>
      <div className="flex-1 space-y-4 overflow-y-auto p-6">
        <div className="max-w-[560px] rounded-lg border border-line bg-raised p-3 text-[13px]">
          The sidebar repaints on every streamed token. Does the icon rail scan faster than the project tree?
        </div>
        <div className="max-w-[560px] rounded-lg border border-line bg-inset p-3 text-[13px] text-dim">
          Working… grouping sessions by recency.
        </div>
      </div>
    </div>
  );
}

export function SidebarPrototype() {
  const [variant, setVariant] = useState<Variant>(readVariant);

  useEffect(() => {
    const url = new URL(location.href);
    url.searchParams.set("variant", variant);
    history.replaceState(null, "", url);
  }, [variant]);

  return (
    <div className="flex h-full w-full overflow-hidden bg-bg text-fg">
      {variant === "A" ? <VariantRail /> : variant === "B" ? <VariantInbox /> : <VariantTimeline />}
      <MockChat />
      <PrototypeSwitcher
        variants={VARIANTS}
        current={variant}
        nameFor={(v) => (v === "A" || v === "B" || v === "C" ? NAMES[v] : v)}
        onSelect={(v) => setVariant(v === "A" || v === "B" || v === "C" ? v : "A")}
      />
    </div>
  );
}
