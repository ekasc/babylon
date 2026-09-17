import type { ComponentType } from "react";
import {
  BranchIcon,
  ChatIcon,
  ClockIcon,
  CpuIcon,
  GearIcon,
  LayersIcon,
  ShieldIcon,
  ThemeIcon,
} from "../icons";

export type SettingsSectionId = "models" | "context" | "permissions" | "bots" | "git" | "background" | "appearance" | "advanced";

export const SECTIONS: Array<{ id: SettingsSectionId; label: string; group: string; icon: ComponentType<{ size?: number; className?: string }> }> = [
  { id: "models", label: "Models", group: "Agent", icon: CpuIcon },
  { id: "bots", label: "Bots", group: "Agent", icon: ChatIcon },
  { id: "context", label: "Context", group: "Agent", icon: LayersIcon },
  { id: "permissions", label: "Permissions", group: "Agent", icon: ShieldIcon },
  { id: "git", label: "Git", group: "Workspace", icon: BranchIcon },
  { id: "background", label: "Background", group: "Workspace", icon: ClockIcon },
  { id: "appearance", label: "Appearance", group: "App", icon: ThemeIcon },
  { id: "advanced", label: "Advanced", group: "App", icon: GearIcon },
];

export function SettingsSidebar({ active, onSelect, onBack }: { active: SettingsSectionId; onSelect: (id: SettingsSectionId) => void; onBack?: () => void; }) {
  let lastGroup = "";
  return (
    <nav className="settings-rail w-[232px] shrink-0 p-2 pt-[60px] flex flex-col" aria-label="Settings sections" style={{WebkitAppRegion: 'drag'} as any}>
      <div className="flex-1 flex flex-col gap-0 pt-4">
      {SECTIONS.map((s) => {
        const showGroup = s.group !== lastGroup;
        lastGroup = s.group;
        const Icon = s.icon;
        return (
          <div key={s.id}>
            {showGroup ? <div className="px-2.5 pt-3 pb-1 text-[11px] font-semibold tracking-[0.08em] uppercase text-dim">{s.group}</div> : null}
            <button
              role="tab"
              aria-selected={active === s.id}
              onClick={() => onSelect(s.id)}
              style={{WebkitAppRegion: 'no-drag'} as any}
              className={`settings-tab flex h-9 w-full items-center gap-2 px-2.5 text-[13px] tracking-[-0.01em] transition-colors rounded-md ${active === s.id ? "bg-accent/10 text-fg font-[600]" : "text-fg/70 hover:text-fg hover:bg-raised font-[450]"}`}
            >
              <Icon size={16} className="shrink-0" />
              {s.label}
            </button>
          </div>
        );
      })}
      </div>
      {onBack ? (
        <button onClick={onBack} style={{WebkitAppRegion: 'no-drag'} as any} className="settings-tab flex items-center gap-2 px-2.5 py-2 text-[14px] tracking-[-0.01em] text-fg/75 hover:text-fg border-t border-line mt-2 pt-3">
          <span aria-hidden>←</span> Back
        </button>
      ) : null}
    </nav>
  );
}
