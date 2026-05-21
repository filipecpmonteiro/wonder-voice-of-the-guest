"use client";

import { useState, useMemo } from "react";
import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceLine,
  Legend,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import { cn } from "@/lib/cn";

type Point = {
  bucketStart: number;
  label: string;
  count: number;
  positiveCount: number;
  negativeCount: number;
  avgRating: number | null;
};
type Trends = { "1y": Point[]; "6m": Point[]; "3m": Point[]; "1m": Point[] };
type Range = keyof Trends;

const RELAUNCH_ISO = "2026-02-04";
const relaunchSec = Math.floor(new Date(RELAUNCH_ISO).getTime() / 1000);

// Soft, food-magazine palette: greenish for positive, pinkish-red for negative
const POSITIVE_FILL = "#bfe7d2";   // soft mint
const NEGATIVE_FILL = "#f7c1cc";   // soft rose
const RATING_LINE = "#ee5f0f";     // Wonder coral accent for the rating line

const ranges: { id: Range; label: string }[] = [
  { id: "1y", label: "1 year" },
  { id: "6m", label: "6 months" },
  { id: "3m", label: "3 months" },
  { id: "1m", label: "1 month" },
];

export function DeepTrendChart({
  trends,
  showRelaunchAnnotation = true,
}: {
  trends: Trends;
  showRelaunchAnnotation?: boolean;
}) {
  const [range, setRange] = useState<Range>("1y");
  const data = trends[range];

  const showRelaunchLine = useMemo(() => {
    if (!showRelaunchAnnotation) return false;
    if (data.length === 0) return false;
    return data[0].bucketStart <= relaunchSec && data[data.length - 1].bucketStart >= relaunchSec - 60 * 86400;
  }, [data, showRelaunchAnnotation]);

  // Snap the relaunch reference line to the nearest bucket label so it lines up on a category XAxis
  const relaunchBucketLabel = useMemo(() => {
    if (!showRelaunchLine || data.length === 0) return null;
    let nearest = data[0];
    let bestDiff = Math.abs(nearest.bucketStart - relaunchSec);
    for (const p of data) {
      const d = Math.abs(p.bucketStart - relaunchSec);
      if (d < bestDiff) {
        nearest = p;
        bestDiff = d;
      }
    }
    return nearest.label;
  }, [data, showRelaunchLine]);

  const totalReviews = data.reduce((acc, p) => acc + p.count, 0);
  const allRatings = data.filter((p) => p.avgRating != null && p.count > 0);
  const weightedAvg =
    allRatings.length > 0
      ? round1(
          allRatings.reduce((s, p) => s + (p.avgRating ?? 0) * p.count, 0) /
            allRatings.reduce((s, p) => s + p.count, 0)
        )
      : null;

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
        <div className="flex items-center gap-1 text-xs">
          {ranges.map((r) => (
            <button
              key={r.id}
              onClick={() => setRange(r.id)}
              className={cn(
                "px-3 py-1 rounded-full font-medium transition-colors",
                range === r.id
                  ? "bg-[var(--color-pink-600)] text-white"
                  : "bg-white border border-[var(--color-line)] text-[var(--color-ink-soft)] hover:border-[var(--color-pink-300)]"
              )}
            >
              {r.label}
            </button>
          ))}
        </div>
        <div className="text-[11px] text-[var(--color-ink-mute)]">
          {totalReviews.toLocaleString()} reviews · weighted avg {weightedAvg ?? "n/a"} ★
        </div>
      </div>

      {data.length === 0 ? (
        <div className="text-xs text-[var(--color-ink-mute)] py-12 text-center">
          No reviews in this window.
        </div>
      ) : (
        <div className="h-[300px] w-full">
          <ResponsiveContainer>
            <ComposedChart data={data} margin={{ top: 10, right: 30, left: -10, bottom: 5 }}>
              <CartesianGrid strokeDasharray="2 4" stroke="#f5e9e0" vertical={false} />
              <XAxis
                dataKey="label"
                stroke="#837a8e"
                fontSize={11}
                tick={{ fill: "#837a8e" }}
                interval="preserveStartEnd"
              />
              <YAxis
                yAxisId="left"
                stroke="#837a8e"
                fontSize={11}
                label={{ value: "Reviews", angle: -90, position: "insideLeft", offset: 15, style: { fontSize: 10, fill: "#837a8e" } }}
              />
              <YAxis
                yAxisId="right"
                orientation="right"
                domain={[1, 5]}
                ticks={[1, 2, 3, 4, 5]}
                stroke={RATING_LINE}
                fontSize={11}
                label={{ value: "Avg ★", angle: 90, position: "insideRight", offset: 10, style: { fontSize: 10, fill: RATING_LINE } }}
              />
              <Tooltip
                contentStyle={{
                  background: "white",
                  border: "1px solid #ecddd3",
                  borderRadius: 8,
                  fontSize: 12,
                }}
                formatter={(value, name) => {
                  if (name === "positiveCount" || name === "Positive (4-5★)") return [`${value}`, "Positive (4-5★)"];
                  if (name === "negativeCount" || name === "Negative (1-3★)") return [`${value}`, "Negative (1-3★)"];
                  if (name === "avgRating" || name === "Avg ★") {
                    const n = typeof value === "number" ? value : Number(value);
                    return [`${n.toFixed(1)} ★`, "Avg rating"];
                  }
                  return [value, String(name)];
                }}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {showRelaunchLine && relaunchBucketLabel && (
                <ReferenceLine
                  yAxisId="right"
                  x={relaunchBucketLabel}
                  stroke="#1f1a24"
                  strokeDasharray="4 4"
                  label={{ value: "Feb 4 relaunch", position: "insideTopRight", fontSize: 10, fill: "#1f1a24", offset: 8 }}
                />
              )}
              <Bar
                yAxisId="left"
                dataKey="positiveCount"
                stackId="r"
                fill={POSITIVE_FILL}
                name="Positive (4-5★)"
                radius={[0, 0, 3, 3]}
              />
              <Bar
                yAxisId="left"
                dataKey="negativeCount"
                stackId="r"
                fill={NEGATIVE_FILL}
                name="Negative (1-3★)"
                radius={[3, 3, 0, 0]}
              />
              <Line
                yAxisId="right"
                type="monotone"
                dataKey="avgRating"
                stroke={RATING_LINE}
                strokeWidth={2.5}
                dot={{ r: 3, fill: RATING_LINE }}
                name="Avg ★"
                connectNulls
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
