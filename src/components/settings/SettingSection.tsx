export function SettingSection({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="py-6 border-b border-white/10 last:border-0">
      <div className="mb-3">
        <h3 className="text-[11px] font-semibold tracking-[0.08em] uppercase text-white/75">{title}</h3>
        {hint ? <p className="mt-2 text-[13px] leading-5 text-white/65 max-w-[72ch]">{hint}</p> : null}
      </div>
      <div>{children}</div>
    </section>
  );
}
