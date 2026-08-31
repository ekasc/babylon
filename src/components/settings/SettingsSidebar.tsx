export type SettingsSectionId = "models" | "context" | "permissions" | "git" | "background" | "appearance" | "advanced";

export const SECTIONS: Array<{ id: SettingsSectionId; label: string; group: string }> = [
  { id: "models", label: "Models", group: "AGENT" },
  { id: "context", label: "Context", group: "AGENT" },
  { id: "permissions", label: "Permissions", group: "AGENT" },
  { id: "git", label: "Git", group: "WORKSPACE" },
  { id: "background", label: "Background", group: "WORKSPACE" },
  { id: "appearance", label: "Appearance", group: "APP" },
  { id: "advanced", label: "Advanced", group: "APP" },
];

export function SettingsSidebar({ active, onSelect, onBack }: { active: SettingsSectionId; onSelect: (id: SettingsSectionId) => void; onBack?: () => void; }) {
  let lastGroup = "";
  return (
    <nav className="settings-rail w-[180px] shrink-0 p-2 pt-[60px] flex flex-col" aria-label="Settings sections" style={{WebkitAppRegion: 'drag'} as any}>
      <div className="flex-1 flex flex-col gap-0 pt-4">
      {SECTIONS.map((s) => {
        const showGroup = s.group !== lastGroup;
        const isFirst = lastGroup === "";
        lastGroup = s.group;
        return (
          <div key={s.id} className="text-center">
            {showGroup && !isFirst ? <div className="mx-0 mt-3 mb-1 h-px bg-white/12" /> : null}
            <button
              role="tab"
              aria-selected={active === s.id}
              onClick={() => onSelect(s.id)}
              style={{WebkitAppRegion: 'no-drag'} as any}
              className={`settings-tab w-full text-center py-1.5 text-[13px] leading-6 tracking-[-0.01em] transition-colors rounded-md ${active === s.id ? "bg-[var(--accent-soft)] text-[var(--accent)] font-[600] border border-[var(--accent)]/20 shadow-sm" : "text-white/70 hover:text-white hover:bg-white/[0.05] font-[450] border border-transparent"}`}
            >
              {s.label}
            </button>
          </div>
        );
      })}
      </div>
      {onBack ? (
        <button onClick={onBack} style={{WebkitAppRegion: 'no-drag'} as any} className="settings-tab mx-auto flex items-center gap-1.5 py-1.5 text-[12px] tracking-[-0.01em] text-white/75 hover:text-white text-center">
          <span aria-hidden>←</span> Back
        </button>
      ) : null}
      <div className="pt-3 pb-2 text-center" style={{WebkitAppRegion: 'no-drag'} as any}>
        <div className="text-[11px] font-medium tracking-[0.04em] text-white/85">Babylon</div>
        <div className="text-[11px] text-white/60 font-mono">v0.1.0</div>
      </div>
    </nav>
  );
}
