import type { ReactNode } from "react";

export default function WorkspacePane({
  children,
  width,
  onResizeStart,
}: {
  children: ReactNode;
  width: number;
  onResizeStart(event: React.PointerEvent<HTMLDivElement>): void;
}) {
  return (
    <aside className="context-workspace relative h-full shrink-0" style={{ width }}>
      <div
        className="context-resizer"
        role="separator"
        aria-label="Resize context workspace"
        aria-orientation="vertical"
        onPointerDown={onResizeStart}
      />
      {children}
    </aside>
  );
}
