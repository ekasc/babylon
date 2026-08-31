export function SettingsCard({ children, accent }: { children: React.ReactNode; accent?: boolean }) {
  return <div className={`rounded-xl border overflow-visible shadow-sm ${accent ? "border-[var(--accent)]/20 bg-[oklch(0.13_0.015_260)]" : "border-white/12 bg-[oklch(0.11_0.01_260)]"}`}>{children}</div>;
}
