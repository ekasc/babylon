import { useMemo, type ComponentType } from "react";
import { assignProjectIdentities, type ProjectIconKey } from "../lib/colors";
import {
  ArchiveIcon,
  BoltIcon,
  BranchIcon,
  ChatIcon,
  CpuIcon,
  FlaskIcon,
  FolderIcon,
  LayersIcon,
  ShieldIcon,
  TerminalIcon,
} from "./icons";

const ICONS: Record<ProjectIconKey, ComponentType<{ size?: number; className?: string }>> = {
  folder: FolderIcon,
  layers: LayersIcon,
  cpu: CpuIcon,
  terminal: TerminalIcon,
  flask: FlaskIcon,
  branch: BranchIcon,
  archive: ArchiveIcon,
  bolt: BoltIcon,
  shield: ShieldIcon,
  chat: ChatIcon,
};

/**
 * Per-project identity mark. Each project in `allCwds` gets a distinct
 * icon (hashed from its cwd, stable across restarts); repeats keep the
 * icon and shift color instead. Replaces the old colored dots.
 */
export function ProjectIcon({
  cwd,
  allCwds,
  size = 13,
  className = "shrink-0",
}: {
  cwd: string;
  allCwds: string[];
  size?: number;
  className?: string;
}) {
  const identity = useMemo(
    () => assignProjectIdentities(allCwds).get(cwd) ?? { icon: "folder" as const, color: "currentColor" },
    [allCwds, cwd]
  );
  const Icon = ICONS[identity.icon];
  return (
    <span className={`grid place-items-center ${className}`} style={{ color: identity.color }} aria-hidden>
      <Icon size={size} />
    </span>
  );
}
