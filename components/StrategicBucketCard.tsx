"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { SparklineChart } from "./SparklineChart";

type Point = { month: string; label: string; pct: number; matches: number; denominator: number };
type Bucket = {
  label: string;
  whatToDo: string;
  rationale: string;
  totalPct: number;
  totalMentions: number;
  totalDenominator: number;
  exampleQuote: string | null;
  monthlyEvolution: Point[];
};

export function StrategicBucketCard({
  bucket,
  index,
  kind,
}: {
  bucket: Bucket;
  index: number;
  kind: "win" | "issue";
}) {
  const [expanded, setExpanded] = useState(false);
  const pctColor =
    kind === "win"
      ? "bg-[#e6faf2] text-[#1f7a5c] border-[#b8ebd9]"
      : "bg-[#ffe1ea] text-[#a01a44] border-[#ffb6c8]";
  const lineColor = kind === "win" ? "#1f7a5c" : "#a01a44";
  const verbLabel = kind === "win" ? "Keep doing" : "Fix";
  const denomNote = kind === "win" ? "positive reviews" : "negative reviews";

  return (
    <li className="card">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full text-left flex items-start gap-4 group"
      >
        <div className="text-2xl font-semibold text-[var(--color-pink-200)] shrink-0 leading-none w-7">
          {String(index + 1).padStart(2, "0")}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div className="font-semibold text-[16px] leading-tight flex items-center gap-2">
              {bucket.label}
              {expanded ? (
                <ChevronDown size={16} className="text-[var(--color-ink-mute)]" />
              ) : (
                <ChevronRight size={16} className="text-[var(--color-ink-mute)]" />
              )}
            </div>
            <div className={`text-xs font-semibold px-2.5 py-1 rounded-full border ${pctColor}`}>
              {bucket.totalPct}% of {denomNote}{" "}
              <span className="opacity-60 font-normal">
                ({bucket.totalMentions.toLocaleString()} of {bucket.totalDenominator.toLocaleString()})
              </span>
            </div>
          </div>
          <div className="mt-2 text-sm text-[var(--color-ink-soft)] leading-relaxed">
            <span className="font-medium text-[var(--color-pink-700)] uppercase tracking-[0.11em] text-[10px]">
              {verbLabel} →{" "}
            </span>
            {bucket.whatToDo}
          </div>
          {bucket.rationale && (
            <div className="mt-1.5 text-xs text-[var(--color-ink-mute)] italic leading-relaxed">
              Why this is strategic: {bucket.rationale}
            </div>
          )}
        </div>
      </button>

      {expanded && (
        <div className="mt-5 pt-4 border-t border-[var(--color-line-2)]">
          <div className="text-[11px] uppercase tracking-[0.13em] font-semibold text-[var(--color-pink-700)] mb-1">
            Monthly evolution · % of {denomNote} mentioning this theme
          </div>
          <SparklineChart data={bucket.monthlyEvolution} color={lineColor} />
          {bucket.exampleQuote && (
            <div className="mt-4">
              <div className="text-[10px] uppercase tracking-[0.13em] text-[var(--color-ink-mute)] mb-1.5">
                Sample quote
              </div>
              <div className="text-xs text-[var(--color-ink-soft)] italic leading-relaxed border-l-2 border-[var(--color-line)] pl-3">
                "{bucket.exampleQuote}"
              </div>
            </div>
          )}
          <details className="mt-4">
            <summary className="text-[10px] uppercase tracking-[0.13em] text-[var(--color-ink-mute)] cursor-pointer hover:text-[var(--color-ink-soft)]">
              Monthly numbers
            </summary>
            <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
              {(() => {
                const now = new Date();
                const nowKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
                return bucket.monthlyEvolution
                  .filter((m) => m.denominator > 0 && m.month !== nowKey)
                  .map((m) => (
                    <div key={m.month} className="card-cream py-2 px-3">
                      <div className="font-medium">{m.label}</div>
                      <div className="text-[var(--color-ink-mute)] mt-0.5">
                        {m.pct}% · {m.matches}/{m.denominator}
                      </div>
                    </div>
                  ));
              })()}
            </div>
          </details>
        </div>
      )}
    </li>
  );
}
