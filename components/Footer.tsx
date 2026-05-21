export function Footer() {
  return (
    <footer className="mt-24 border-t border-[var(--color-line)]">
      <div className="max-w-6xl mx-auto px-4 md:px-8 py-10 grid gap-6 md:grid-cols-2 text-sm text-[var(--color-ink-soft)]">
        <div>
          <div className="font-semibold text-[var(--color-ink)] mb-1.5">Cristina Mello</div>
          <div className="leading-relaxed">
            Built for the Wonder manager interview — a working read of the guest voice
            across the NYC + NJ fleet.
          </div>
        </div>
        <div>
          <div className="font-semibold text-[var(--color-ink)] mb-1.5">Method</div>
          <div className="leading-relaxed">
            Public Google reviews, read individually and clustered into recurring,
            fleet-wide themes. Counts and trends are computed live from the review set.
          </div>
        </div>
      </div>
    </footer>
  );
}
