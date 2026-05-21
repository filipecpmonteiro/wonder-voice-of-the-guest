import { getStrategicAnalytics } from "@/lib/server/reviews";
import { VOG_LOCATIONS } from "@/lib/data/vog-locations";
import { DeepTrendChart } from "@/components/DeepTrendChart";
import { StrategicBucketCard } from "@/components/StrategicBucketCard";

export const dynamic = "force-dynamic";

export default async function Home() {
  const currentKey = "all";
  const currentLabel = VOG_LOCATIONS.find((l) => l.key === currentKey)?.city ?? "All shops";

  const a = await getStrategicAnalytics(currentKey);
  const sinceLabel = new Date(a.sinceDate + "T00:00:00Z").toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

  return (
    <div className="max-w-6xl mx-auto px-4 md:px-8">
      {/* HERO */}
      <section className="pt-12 md:pt-16 pb-8 reveal">
        <div className="text-[11px] uppercase tracking-[0.18em] font-semibold text-[var(--color-pink-700)]">
          Voice of the Guest · {currentLabel} · {a.totalReviews.toLocaleString()} reviews since {sinceLabel} · {a.allTimeAvg ?? "n/a"}★ avg
        </div>
        <h1 className="text-3xl md:text-5xl font-semibold leading-[1.05] tracking-tight mt-3 max-w-4xl">
          What guests are telling us across every shop.{" "}
          <span className="text-[var(--color-pink-600)]">What we do about it.</span>
        </h1>
        <p className="mt-5 text-[var(--color-ink-soft)] max-w-3xl leading-relaxed">
          Every public Google review of the Wonder fleet — 14 shops across New York City and
          northern New Jersey — read and clustered into the short list of things a multi-shop
          operator can actually act on, not a wall of star ratings. The point is consistency:
          a theme that recurs month after month, across shops, is a systems problem, not a
          one-off.
        </p>
      </section>

      {/* TREND CHART */}
      <section className="py-8 border-t border-[var(--color-line)]">
        <SectionLabel>Volume + rating over time</SectionLabel>
        <h2 className="text-2xl md:text-3xl font-semibold mt-2 max-w-3xl tracking-tight">
          Is the guest experience holding as we scale?
        </h2>
        <p className="mt-2 text-[var(--color-ink-soft)] max-w-3xl">
          Bars are review counts (green = 4–5★, rose = 1–3★). The line is the average rating in
          that bucket. Switch the time window to zoom in or out — watch whether the line stays
          flat as volume grows.
        </p>
        <div className="mt-7 card">
          <DeepTrendChart trends={a.trends} showRelaunchAnnotation={false} />
        </div>
      </section>

      {/* TOP ISSUES */}
      <section className="py-10 border-t border-[var(--color-line)]">
        <div className="flex items-baseline gap-3 flex-wrap">
          <SectionLabel className="text-[#a01a44]">
            Recurring complaints, fleet-wide
          </SectionLabel>
          <span className="text-[11px] text-[var(--color-ink-mute)]">
            top 5 strategic · clustered from {a.negativeTextCount.toLocaleString()} negative reviews with text
          </span>
        </div>
        <h2 className="text-2xl md:text-3xl font-semibold mt-2 max-w-3xl tracking-tight">
          The same issues, month after month.
        </h2>
        <p className="mt-2 text-[var(--color-ink-soft)] max-w-3xl">
          Click any row to expand the monthly evolution. Persisting at the same level is the
          signal — it means the fix hasn&apos;t moved the needle and it&apos;s worth a systems
          response, not another one-shop reminder.
        </p>

        {a.topIssues.length === 0 ? (
          <PendingHint kind="issue" />
        ) : (
          <ol className="mt-7 space-y-2.5">
            {[...a.topIssues].sort((x, y) => y.totalPct - x.totalPct).map((b, i) => (
              <StrategicBucketCard key={i} bucket={b} index={i} kind="issue" />
            ))}
          </ol>
        )}
      </section>

      {/* TOP WINS */}
      <section className="py-10 border-t border-[var(--color-line)]">
        <div className="flex items-baseline gap-3 flex-wrap">
          <SectionLabel className="text-[#1f7a5c]">
            What guests consistently praise
          </SectionLabel>
          <span className="text-[11px] text-[var(--color-ink-mute)]">
            top 5 strategic · clustered from {a.positiveTextCount.toLocaleString()} positive reviews with text
          </span>
        </div>
        <h2 className="text-2xl md:text-3xl font-semibold mt-2 max-w-3xl tracking-tight">
          The reasons people come back. Protect these as you grow.
        </h2>
        <p className="mt-2 text-[var(--color-ink-soft)] max-w-3xl">
          Click any row to expand the monthly evolution. Each one is something to{" "}
          <strong>protect, replicate across shops, and lean into in marketing</strong>.
        </p>

        {a.topWins.length === 0 ? (
          <PendingHint kind="win" />
        ) : (
          <ol className="mt-7 space-y-2.5">
            {[...a.topWins].sort((x, y) => y.totalPct - x.totalPct).map((b, i) => (
              <StrategicBucketCard key={i} bucket={b} index={i} kind="win" />
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

function PendingHint({ kind }: { kind: "win" | "issue" }) {
  return (
    <div className="mt-7 card-cream">
      <p className="text-sm leading-relaxed text-[var(--color-ink-soft)]">
        Strategic top-5 {kind === "win" ? "wins" : "issues"} are still being clustered (the
        per-review analysis + clustering takes a few minutes). Once the seed JSON lands the
        section populates automatically.
      </p>
    </div>
  );
}

function SectionLabel({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`text-[11px] uppercase tracking-[0.18em] font-semibold ${className || "text-[var(--color-pink-700)]"}`}>
      {children}
    </div>
  );
}
