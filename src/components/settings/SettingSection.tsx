export function SettingSection({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="py-5 border-b border-line last:border-0">
      <div className="mb-3">
        <h3 className="text-[11px] font-semibold tracking-[0.08em] uppercase text-dim">{title}</h3>
        {hint ? <p className="mt-2 text-[13px] leading-5 text-dim max-w-[72ch]">{hint}</p> : null}
      </div>
      <div>{children}</div>
    </section>
  );
}
