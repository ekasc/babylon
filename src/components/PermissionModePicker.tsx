import { useEffect, useRef, useState } from "react";
import { bridge, type PermissionMode } from "../bridge";
import { ShieldIcon } from "./icons";

const MODE_META: Record<PermissionMode, { label: string; short: string; hint: string; danger?: boolean }> = {
  supervised: {
    label: "Supervised",
    short: "Supervised",
    hint: "Ask before every consequential action — writes, external access, shell, git push.",
  },
  auto: {
    label: "Auto",
    short: "Auto",
    hint: "Routine actions run; high or uncertain risk is approved interactively.",
  },
  full_access: {
    label: "Full Access",
    short: "Full Access",
    hint: "Run without approval prompts. Explicit deny rules still block.",
    danger: true,
  },
};

/**
 * Live execution-mode control for the composer meta row. The current mode is
 * always visible (truthful state); switching it takes one click. Enabling
 * Full Access releases any approvals the agent is currently waiting on.
 */
export default function PermissionModePicker() {
  const [mode, setMode] = useState<PermissionMode>("auto");
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bridge.permissionsGet().then((s) => setMode(s.mode)).catch(() => undefined);
    return bridge.onPermissionsChanged((next) => setMode(next.mode));
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const meta = MODE_META[mode];
  const danger = mode === "full_access";

  const choose = (next: PermissionMode) => {
    setOpen(false);
    if (next === mode) return;
    void bridge.permissionsSetMode(next).catch(() => undefined);
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title={`Execution mode: ${meta.label}`}
        aria-expanded={open}
        className={`operator-meta-control flex h-8 items-center gap-1.5 px-2.5 text-[13px] ${danger ? "text-warn" : ""}`}
      >
        <ShieldIcon size={12} className="shrink-0" />
        <span>{meta.short}</span>
      </button>

      {open && (
        <div className="operator-popover absolute bottom-full left-0 z-50 mb-2 w-[320px] overflow-hidden">
          <div className="px-3 pt-3 pb-1 text-[11.5px] font-semibold uppercase tracking-wide text-dim">
            Execution mode
          </div>
          <div className="p-1.5">
            {(Object.keys(MODE_META) as PermissionMode[]).map((m) => {
              const item = MODE_META[m];
              const active = m === mode;
              return (
                <button
                  key={m}
                  onClick={() => choose(m)}
                  aria-pressed={active}
                  className={`w-full rounded-md px-2.5 py-2 text-left transition-colors duration-100 hover:bg-inset ${active ? "bg-inset" : ""}`}
                >
                  <span className="flex items-center gap-2 text-[13px]">
                    <span className={item.danger ? "font-medium text-warn" : active ? "font-medium text-fg" : "text-fg"}>
                      {item.label}
                    </span>
                    {active && <span className="text-accent">✓</span>}
                  </span>
                  <span className="mt-0.5 block text-[11.5px] leading-snug text-dim">{item.hint}</span>
                </button>
              );
            })}
          </div>
          {danger && (
            <div className="border-t border-line/60 px-3 py-2 text-[11.5px] leading-snug text-warn">
              Full Access is active — consequential actions run without asking.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
