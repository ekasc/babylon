// Minimal inline SVG icon set (no emojis). All inherit currentColor.
interface IconProps {
  size?: number;
  className?: string;
  strokeWidth?: number;
}

function base(props: IconProps) {
  const { size = 14, className = "", strokeWidth = 1.5 } = props;
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className,
    "aria-hidden": true as const,
  };
}

export const PiMark = (props: IconProps) => (
  <svg {...base(props)}>
    <circle cx="12" cy="12" r="10" fill="currentColor" stroke="none" />
    <path
      d="M7 9.5h10M9 9.5c0 3.5.8 6 3 8M12 9.5c-1 3.2-1.2 5.6-.6 8M15 9.5c.4 2.4.3 4.8-.4 8"
      stroke="var(--bg)"
      strokeWidth="1.4"
      strokeLinecap="round"
      fill="none"
    />
  </svg>
);

export const CpuIcon = (props: IconProps) => (
  <svg {...base(props)}>
    <rect x="5" y="5" width="14" height="14" rx="2" />
    <rect x="9.5" y="9.5" width="5" height="5" rx="1" />
    <path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" />
  </svg>
);

export const BoltIcon = (props: IconProps) => (
  <svg {...base(props)}>
    <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z" />
  </svg>
);

export const GaugeIcon = (props: IconProps) => (
  <svg {...base(props)}>
    <path d="M4 15a8 8 0 1 1 16 0" />
    <path d="M12 15l3.5-4.5" />
    <circle cx="12" cy="15" r="1.5" fill="currentColor" stroke="none" />
  </svg>
);

export const TerminalIcon = (props: IconProps) => (
  <svg {...base(props)}>
    <path d="m5 7 4 5-4 5" />
    <path d="M11 17h8" />
  </svg>
);

export const BranchIcon = (props: IconProps) => (
  <svg {...base(props)}>
    <circle cx="6" cy="5" r="2.5" />
    <circle cx="6" cy="19" r="2.5" />
    <circle cx="18" cy="8" r="2.5" />
    <path d="M6 7.5v9M8.5 6h6a3.5 3.5 0 0 1 3.5 3.5v0" />
  </svg>
);

export const FlaskIcon = (props: IconProps) => (
  <svg {...base(props)}>
    <path d="M9 3h6M10 3v6l-5.2 9.4A2 2 0 0 0 6.5 21h11a2 2 0 0 0 1.7-2.6L14 9V3" />
    <path d="M7.5 15h9" />
  </svg>
);

export const PaperclipIcon = (props: IconProps) => (
  <svg {...base(props)}>
    <path d="m20 11-8.5 8.5a5 5 0 0 1-7-7L13 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 6" />
  </svg>
);

export const CopyIcon = (props: IconProps) => (
  <svg {...base(props)}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V5a2 2 0 0 1 2-2h10" />
  </svg>
);

export const ChevronIcon = (props: IconProps) => (
  <svg {...base(props)}>
    <path d="m9 6 6 6-6 6" />
  </svg>
);

export const CheckIcon = (props: IconProps) => (
  <svg {...base(props)}>
    <path d="m4 12.5 5 5L20 6.5" />
  </svg>
);

export const SparkleIcon = (props: IconProps) => (
  <svg {...base(props)}>
    <path d="M12 3v4M12 17v4M3 12h4M17 12h4" />
    <path d="M12 8a4 4 0 0 0 4 4 4 4 0 0 0-4 4 4 4 0 0 0-4-4 4 4 0 0 0 4-4z" fill="currentColor" stroke="none" />
  </svg>
);

export const CompressIcon = (props: IconProps) => (
  <svg {...base(props)}>
    <path d="M4 9h4V5M20 15h-4v4M4 15h4v4M20 9h-4V5" />
  </svg>
);

export const RefreshIcon = (props: IconProps) => (
  <svg {...base(props)}>
    <path d="M20 12a8 8 0 1 1-2.5-5.8" />
    <path d="M20 3v4h-4" />
  </svg>
);

export const XIcon = (props: IconProps) => (
  <svg {...base(props)}>
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
);

export const SendIcon = (props: IconProps) => (
  <svg {...base(props)}>
    <path d="M21 3 10.5 13.5M21 3l-7 18-3.5-7.5L3 10l18-7z" />
  </svg>
);

export const StopIcon = (props: IconProps) => (
  <svg {...base(props)}>
    <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />
  </svg>
);

export const PlayIcon = (props: IconProps) => (
  <svg {...base(props)}>
    <path d="M8 5.5v13l10-6.5-10-6.5z" fill="currentColor" stroke="none" />
  </svg>
);

export const PauseIcon = (props: IconProps) => (
  <svg {...base(props)}>
    <rect x="6.5" y="5" width="3.6" height="14" rx="1.2" fill="currentColor" stroke="none" />
    <rect x="13.9" y="5" width="3.6" height="14" rx="1.2" fill="currentColor" stroke="none" />
  </svg>
);

export const LayersIcon = (props: IconProps) => (
  <svg {...base(props)}>
    <path d="m12 3 9 5-9 5-9-5 9-5z" />
    <path d="m3 12.5 9 5 9-5" />
    <path d="m3 17 9 5 9-5" />
  </svg>
);

export const ListIcon = (props: IconProps) => (
  <svg {...base(props)}>
    <path d="M9 6h11M9 12h11M9 18h11" />
    <path d="M4.5 6h.01M4.5 12h.01M4.5 18h.01" strokeWidth="2.4" />
  </svg>
);

export const SearchIcon = (props: IconProps) => (
  <svg {...base(props)}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 4.5 4.5" />
  </svg>
);

export const FolderIcon = (props: IconProps) => (
  <svg {...base(props)}>
    <path d="M3 6.5h6l2 2h10v9.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </svg>
);

export const MoreIcon = (props: IconProps) => (
  <svg {...base(props)}>
    <circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
    <circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" />
  </svg>
);

/** Small leading icon for tool cards (bash/edit/read/grep/find/ls). */
export const ToolGlyph = ({ name, ...props }: IconProps & { name: string }) => {
  switch (name) {
    case "bash":
      return <TerminalIcon {...props} />;
    case "edit":
      return <SparkleIcon {...props} />;
    case "write":
      return <FilePlusIcon {...props} />;
    case "read":
    case "grep":
    case "find":
    case "ls":
      return <FileIcon {...props} />;
    default:
      return <CpuIcon {...props} />;
  }
};

export const FileIcon = (props: IconProps) => (
  <svg {...base(props)}>
    <path d="M6 3h8l4 4v14H6z" />
    <path d="M14 3v4h4M9 13h6M9 17h4" />
  </svg>
);

export const FilePlusIcon = (props: IconProps) => (
  <svg {...base(props)}>
    <path d="M6 3h8l4 4v14H6z" />
    <path d="M14 3v4h4M12 12v6M9 15h6" />
  </svg>
);

export const PlusIcon = (props: IconProps) => (
  <svg {...base(props)}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const PinIcon = (props: IconProps) => (
  <svg {...base(props)}>
    <path d="M9 4h6l-1 7 3 3v2H7v-2l3-3-1-7z" />
    <path d="M12 13v7" />
  </svg>
);

export const ClockIcon = (props: IconProps) => (
  <svg {...base(props)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
);

export const ArchiveIcon = (props: IconProps) => (
  <svg {...base(props)}>
    <rect x="3" y="4" width="18" height="4" rx="1" />
    <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4" />
  </svg>
);

export const ChatIcon = (props: IconProps) => (
  <svg {...base(props)}>
    <path d="M21 12a8 8 0 0 1-11.5 7.2L4 20l1-4.3A8 8 0 1 1 21 12z" />
  </svg>
);

export const GearIcon = (props: IconProps) => (
  <svg {...base(props)}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

export const ArrowUpIcon = (props: IconProps) => (
  <svg {...base(props)}>
    <path d="M12 19V5M6 11l6-6 6 6" />
  </svg>
);

export const ArrowDownIcon = (props: IconProps) => (
  <svg {...base(props)}>
    <path d="M12 5v14M6 13l6 6 6-6" />
  </svg>
);

export const RunningIcon = (props: IconProps) => (
  <svg {...base(props)}>
    <path d="M3 12h4l2-6 4 12 2-6h6" />
  </svg>
);

export const BlockedIcon = (props: IconProps) => (
  <svg {...base(props)}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M6.5 6.5l11 11" />
  </svg>
);

export const InputIcon = (props: IconProps) => (
  <svg {...base(props)}>
    <path d="M20 13a8 8 0 0 1-11.5 7.2L4 20l1-4.3A8 8 0 1 1 20 13z" />
    <circle cx="9" cy="12.5" r="0.9" fill="currentColor" stroke="none" />
    <circle cx="12.5" cy="12.5" r="0.9" fill="currentColor" stroke="none" />
    <circle cx="16" cy="12.5" r="0.9" fill="currentColor" stroke="none" />
  </svg>
);



