"use client";

import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";

type Point = { month: string; label: string; pct: number; matches: number; denominator: number };

// "YYYY-MM" of the current month, drop it from charts since it's still in-progress
function currentMonthKey(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function SparklineChart({ data, color = "#a01a44" }: { data: Point[]; color?: string }) {
  const nowKey = currentMonthKey();
  // Drop months with zero denominator (no signal) AND drop the current in-progress month.
  const filtered = data.filter((d) => d.denominator > 0 && d.month !== nowKey);
  if (filtered.length < 2) {
    return (
      <div className="text-xs text-[var(--color-ink-mute)] py-6 text-center">
        Need at least 2 months of data to draw a trend.
      </div>
    );
  }
  const maxPct = Math.max(10, ...filtered.map((d) => d.pct));

  return (
    <div className="h-[140px] w-full">
      <ResponsiveContainer>
        <LineChart data={filtered} margin={{ top: 10, right: 12, left: -10, bottom: 0 }}>
          <XAxis dataKey="label" stroke="#837a8e" fontSize={10} interval="preserveStartEnd" />
          <YAxis
            domain={[0, Math.ceil(maxPct / 5) * 5]}
            stroke="#837a8e"
            fontSize={10}
            tickFormatter={(v) => `${v}%`}
            width={40}
          />
          <Tooltip
            contentStyle={{
              background: "white",
              border: "1px solid #ecddd3",
              borderRadius: 8,
              fontSize: 11,
            }}
            formatter={(value, name, ctx) => {
              if (name === "pct") {
                const m = (ctx?.payload as Point) ?? null;
                return [`${value}%  (${m?.matches ?? 0} of ${m?.denominator ?? 0})`, "Mentions"];
              }
              return [value, String(name)];
            }}
            labelFormatter={(l) => `Month: ${l}`}
          />
          <Line
            type="monotone"
            dataKey="pct"
            stroke={color}
            strokeWidth={2}
            dot={{ r: 2, fill: color }}
            activeDot={{ r: 4 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
