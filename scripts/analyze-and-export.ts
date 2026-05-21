/**
 * One-time analysis pre-compute for the Wonder Voice-of-the-Guest page.
 *
 * - Boots ./lib/db, which seeds reviews_cache from seed/outscraper-wonder.xlsx
 * - Filters to reviews on/after SINCE_DATE
 * - Per-review Claude categorization (parallel, cached in review_analysis)
 * - Strategic top-5 issues / top-5 wins (one Claude call each)
 * - Month-by-month evolution per bucket
 * - Writes seed/strategic-all.json (read directly by app/page.tsx)
 *
 * Idempotent: analyses already in the DB are reused; only missing ones are computed.
 *
 * Run: npm run analyze   (needs ANTHROPIC_API_KEY in .env)
 */

import path from "node:path";
import fs from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { db as getDb } from "../lib/db";

// Tiny .env loader (dotenv shipped a noisy variant that didn't load reliably here)
const envPath = path.join(process.cwd(), ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}

const SINCE_DATE = "2024-01-01T00:00:00Z";
const SINCE_SEC = Math.floor(new Date(SINCE_DATE).getTime() / 1000);
const MODEL = "claude-haiku-4-5-20251001";
const CONCURRENCY = 10;
const SEED_DIR = path.join(process.cwd(), "seed");

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_KEY) {
  console.error("Set ANTHROPIC_API_KEY in .env or the shell");
  process.exit(1);
}

const ai = new Anthropic({ apiKey: ANTHROPIC_KEY });
// Booting lib/db triggers the on-boot seed from seed/outscraper-wonder.xlsx.
const db = getDb();

// Operational levers a multi-shop Wonder operator can actually pull.
const REVIEW_CATEGORIES = [
  "staff-service",
  "speed-wait",
  "food-quality",
  "menu-variety",
  "value-pricing",
  "cleanliness",
  "ambiance-seating",
  "consistency",
  "order-accuracy",
  "delivery-pickup",
  "kiosk-app-ordering",
  "kid-friendly",
  "accessibility",
  "communication-hours",
];

const BRAND_CONTEXT =
  "Wonder is a fast-casual multi-restaurant concept with 14 shops across New York City and northern New Jersey. Each Wonder location houses several chef-driven restaurant brands under one roof, ordered via in-store kiosks or the app for dine-in, pickup, and delivery. These are Google reviews of those shops. The reader is a multi-shop operations manager who pulls levers like staffing, training, SOPs, kitchen consistency across concepts, order accuracy when bundling concepts, kiosk/app UX, pickup-and-delivery handoff, cleaning cadence, menu/concept rotation, and shop-to-shop consistency.";

async function withRetry<T>(fn: () => Promise<T>, tries = 4): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw lastErr;
}

function parseJsonLoose(text: string): unknown {
  let raw = text.trim();
  if (raw.startsWith("```")) raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  return JSON.parse(raw);
}

// ─── Per-review categorization ───────────────────────────────────────────────────

async function analyzeReview(text: string, rating: number | null) {
  const prompt = `You are categorizing a Google review for a Wonder shop (multi-restaurant fast-casual), helping the multi-shop operations manager find actionable levers.

${BRAND_CONTEXT}

Review (${rating ?? "?"} stars):
"""
${text.slice(0, 2000)}
"""

Return STRICT JSON:
{
  "sentiment": "positive" | "negative" | "mixed" | "neutral",
  "categories": array of 1-4 ids from [${REVIEW_CATEGORIES.join(", ")}] that are explicitly relevant,
  "themes": 1-3 short noun phrases (each <8 words) describing the specific theme, use NORMALIZED phrasing so the same theme expressed in different reviews collapses to the same string,
  "operational_signal": one short sentence (<25 words) describing the actionable lever the manager could pull. Suggest kitchen consistency across concepts, staffing-to-volume, training, kiosk/app UX, order-accuracy checks when bundling concepts, pickup/delivery handoff, cleaning cadence, menu signage, or portion/temperature consistency. If there's no actionable feedback, write "none".
}

Return ONLY the JSON.`;
  const res = await ai.messages.create({
    model: MODEL,
    max_tokens: 400,
    temperature: 0.1,
    messages: [{ role: "user", content: prompt }],
  });
  const block = res.content[0];
  if (block.type !== "text") throw new Error("not text");
  return parseJsonLoose(block.text) as {
    sentiment: "positive" | "negative" | "mixed" | "neutral";
    categories: string[];
    themes: string[];
    operational_signal: string;
  };
}

// ─── Strategic top-5 (one big Claude call per direction) ─────────────────────────

type StrategicBucket = {
  label: string;
  evidenceThemes: string[];
  whatToDo: string;
  rationale: string;
};

async function pickStrategicTop5(
  direction: "issues" | "wins",
  themesByMonth: Record<string, string[]>
): Promise<StrategicBucket[]> {
  const monthLines = Object.entries(themesByMonth)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([month, themes]) => `  ${month}: [${themes.slice(0, 200).map((t) => `"${t.replace(/"/g, "'")}"`).join(", ")}]`)
    .join("\n");

  const directionWord = direction === "issues" ? "negative" : "positive";
  const ranked = direction === "issues"
    ? "issues that recur across multiple months (not one-time spikes), and look HIGH-VOLUME or HIGH-PERSISTENCE"
    : "themes that customers consistently reward across multiple months";
  const actionGuide =
    direction === "issues"
      ? "Recommend one concrete thing the manager can do. Examples: 'check that food stays hot at the pickup counter', 'have one cook in charge of each restaurant inside the shop', 'add another order screen so the line moves faster', 'double-check every bag before it leaves the counter'."
      : "Recommend specifically what to PROTECT or REPLICATE across the other shops in the fleet, in plain English.";

  const prompt = `You are a hospitality operations analyst for Wonder (multi-restaurant fast-casual). ${BRAND_CONTEXT}

Below are themes extracted from ${directionWord} reviews (${direction === "issues" ? "1-3 stars" : "4-5 stars"}), grouped by month, pooled across all 14 NYC + NJ shops.

Pick the TOP 5 ${ranked}. The point is for the manager to act on a SHORT LIST, not a laundry list.

PLAIN ENGLISH RULES (very important):
- Write like you are explaining the issue to a friend who has never worked in a restaurant.
- BANNED words and phrases — never use any of these or close cousins:
  SOP, SOPs, "standard operating procedure", QA, "quality assurance", UX, "user experience",
  KPI, "throughput", "right-size", "staffing-to-volume", "value prop", "value perception",
  "table-stakes", "differentiator", "premium positioning", "operational lever", "handoff protocol",
  "audit cadence", "SKU", "ops", "execution", "concept-specific", "cross-concept", "leverage",
  "drive loyalty", "fulfillment", "compliance".
- If you catch yourself using a corporate or restaurant-industry word, rewrite that sentence in everyday words.
- Keep sentences short and concrete. Use words like "check", "train", "add", "fix", "make sure", "watch", "ask", "count", "test".

GUIDELINES:
- Cluster aggressively: "long wait", "long line", "slow pickup", "waited forever" → ONE bucket.
- Plain English bucket labels (3-7 words). E.g. "Long wait to get food", "Food arrives cold", "Staff are warm and helpful", "Lots of variety to choose from".
- For each, "whatToDo" = ONE specific action (<20 words), no jargon. ${actionGuide}
- Skip noise themes ("good", "bad", "fun", "nice", "great"), not actionable.
- Skip owner-response leakage ("thanks for visiting").
- For each, "rationale" = ONE plain-English sentence (<20 words) on why this bucket matters, e.g. "shows up almost every month for two years" or "spikes every summer when shops are busiest".

THEMES BY MONTH:
${monthLines}

Return STRICT JSON: an array of up to 5 buckets, each:
{
  "label": "...",
  "evidenceThemes": ["...", "..."],
  "whatToDo": "...",
  "rationale": "..."
}

Return ONLY the JSON array.`;

  const res = await ai.messages.create({
    model: MODEL,
    max_tokens: 4096,
    temperature: 0.1,
    messages: [{ role: "user", content: prompt }],
  });
  const block = res.content[0];
  if (block.type !== "text") throw new Error("not text");
  const parsed = parseJsonLoose(block.text);
  if (!Array.isArray(parsed)) throw new Error("expected array");
  return parsed.slice(0, 5) as StrategicBucket[];
}

// ─── Tiny async pool ──────────────────────────────────────────────────────────────

async function pool<T>(items: T[], concurrency: number, worker: (item: T, i: number) => Promise<void>) {
  let cursor = 0;
  let done = 0;
  const total = items.length;
  const start = Date.now();
  const runners = new Array(Math.min(concurrency, total)).fill(0).map(async () => {
    while (true) {
      const i = cursor++;
      if (i >= total) return;
      await worker(items[i], i);
      done++;
      if (done % 50 === 0 || done === total) {
        const elapsed = ((Date.now() - start) / 1000).toFixed(0);
        const rate = (done / Math.max(1, Number(elapsed))).toFixed(1);
        console.log(`  …${done}/${total} (${elapsed}s, ${rate}/s)`);
      }
    }
  });
  await Promise.all(runners);
}

// ─── Main ────────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n=== Wonder analysis pre-compute (since ${SINCE_DATE}) ===\n`);

  const totalRows = (db.prepare("SELECT COUNT(*) AS c FROM reviews_cache").get() as { c: number }).c;
  console.log(`reviews_cache has ${totalRows} rows total`);

  // 1. Per-review categorization
  console.log("\n[1/3] Per-review categorization");
  const reviews = db
    .prepare(
      `SELECT r.id, r.text, r.rating
       FROM reviews_cache r
       LEFT JOIN review_analysis a ON a.review_id = r.id
       WHERE r.time >= ? AND r.text IS NOT NULL AND length(r.text) > 0
         AND a.review_id IS NULL`
    )
    .all(SINCE_SEC) as { id: number; text: string; rating: number | null }[];
  console.log(`  ${reviews.length} reviews need categorization`);
  const insertReview = db.prepare(
    `INSERT INTO review_analysis (review_id, sentiment, categories, themes, operational_signal)
     VALUES (?, ?, ?, ?, ?)`
  );
  let reviewFails = 0;
  await pool(reviews, CONCURRENCY, async (r) => {
    try {
      const a = await withRetry(() => analyzeReview(r.text, r.rating));
      const cats = (a.categories ?? []).filter((c) => REVIEW_CATEGORIES.includes(c));
      insertReview.run(r.id, a.sentiment, JSON.stringify(cats), JSON.stringify(a.themes ?? []), a.operational_signal ?? "");
    } catch {
      reviewFails++;
    }
  });
  console.log(`  done · ${reviewFails} failed`);

  // 2. Strategic top-5
  console.log("\n[2/3] Strategic top-5 issues + wins");
  const analyzed = db
    .prepare(
      `SELECT r.id, r.rating, r.time, a.themes
       FROM reviews_cache r
       JOIN review_analysis a ON a.review_id = r.id
       WHERE r.time >= ? AND r.text IS NOT NULL AND length(r.text) > 0`
    )
    .all(SINCE_SEC) as { id: number; rating: number; time: number; themes: string }[];

  function monthKey(timeSec: number) {
    const d = new Date(timeSec * 1000);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  }

  const negThemesByMonth: Record<string, string[]> = {};
  const posThemesByMonth: Record<string, string[]> = {};
  for (const r of analyzed) {
    let themes: string[] = [];
    try {
      themes = JSON.parse(r.themes || "[]");
    } catch {}
    const k = monthKey(r.time);
    if (r.rating <= 3) {
      (negThemesByMonth[k] ??= []).push(...themes);
    } else if (r.rating >= 4) {
      (posThemesByMonth[k] ??= []).push(...themes);
    }
  }

  console.log(`  picking top-5 issues (across ${Object.keys(negThemesByMonth).length} months)…`);
  const topIssues = await withRetry(() => pickStrategicTop5("issues", negThemesByMonth));
  console.log(`    → ${topIssues.length} buckets`);
  console.log(`  picking top-5 wins (across ${Object.keys(posThemesByMonth).length} months)…`);
  const topWins = await withRetry(() => pickStrategicTop5("wins", posThemesByMonth));
  console.log(`    → ${topWins.length} buckets`);

  // 3. Monthly evolution per bucket
  console.log("\n[3/3] Computing monthly evolution per bucket");

  function expandMonthsBetween(startKey: string, endKey: string): string[] {
    const out: string[] = [];
    const [sy, sm] = startKey.split("-").map(Number);
    const [ey, em] = endKey.split("-").map(Number);
    let y = sy, m = sm;
    while (y < ey || (y === ey && m <= em)) {
      out.push(`${y}-${String(m).padStart(2, "0")}`);
      m++;
      if (m > 12) { m = 1; y++; }
    }
    return out;
  }
  const today = new Date();
  const sinceKey = monthKey(SINCE_SEC);
  const todayKey = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}`;
  const allMonths = expandMonthsBetween(sinceKey, todayKey);

  function denominatorFor(direction: "issues" | "wins", monthKeyStr: string): { reviewIds: number[]; themesById: Map<number, string[]> } {
    const reviewIds: number[] = [];
    const themesById = new Map<number, string[]>();
    for (const r of analyzed) {
      const k = monthKey(r.time);
      if (k !== monthKeyStr) continue;
      if (direction === "issues" && r.rating > 3) continue;
      if (direction === "wins" && r.rating < 4) continue;
      let themes: string[] = [];
      try { themes = JSON.parse(r.themes || "[]"); } catch {}
      reviewIds.push(r.id);
      themesById.set(r.id, themes.map((t) => t.toLowerCase()));
    }
    return { reviewIds, themesById };
  }

  function reviewMatchesBucket(reviewThemes: string[], evidenceLowered: string[]): boolean {
    return reviewThemes.some((rt) => evidenceLowered.some((et) => rt.includes(et) || et.includes(rt)));
  }

  type BucketWithEvolution = StrategicBucket & {
    totalPct: number;
    totalMentions: number;
    totalDenominator: number;
    exampleQuote: string | null;
    monthlyEvolution: { month: string; label: string; pct: number; matches: number; denominator: number }[];
  };

  function buildEvolution(direction: "issues" | "wins", buckets: StrategicBucket[]): BucketWithEvolution[] {
    return buckets.map((b) => {
      const evidenceLowered = b.evidenceThemes.map((e) => e.toLowerCase());
      let totalMatches = 0;
      let totalDenominator = 0;
      let exampleReviewId: number | null = null;

      const monthly = allMonths.map((mKey) => {
        const { reviewIds, themesById } = denominatorFor(direction, mKey);
        let matches = 0;
        for (const id of reviewIds) {
          const themes = themesById.get(id) ?? [];
          if (reviewMatchesBucket(themes, evidenceLowered)) {
            matches++;
            if (exampleReviewId == null) exampleReviewId = id;
          }
        }
        totalMatches += matches;
        totalDenominator += reviewIds.length;
        const denom = reviewIds.length;
        const dt = new Date(`${mKey}-01T00:00:00Z`);
        const label = dt.toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" });
        return {
          month: mKey,
          label,
          pct: denom > 0 ? Math.round((matches / denom) * 100) : 0,
          matches,
          denominator: denom,
        };
      });

      let exampleQuote: string | null = null;
      if (exampleReviewId != null) {
        const row = db.prepare("SELECT text FROM reviews_cache WHERE id = ?").get(exampleReviewId) as { text: string } | undefined;
        exampleQuote = row?.text?.slice(0, 280) ?? null;
      }

      return {
        ...b,
        totalMentions: totalMatches,
        totalDenominator,
        totalPct: totalDenominator > 0 ? Math.round((totalMatches / totalDenominator) * 100) : 0,
        exampleQuote,
        monthlyEvolution: monthly,
      };
    });
  }

  const issuesWithEvolution = buildEvolution("issues", topIssues);
  const winsWithEvolution = buildEvolution("wins", topWins);

  // ─── Export ──────────────────────────────────────────────────────────────────────
  console.log("\n[exporting]");
  if (!fs.existsSync(SEED_DIR)) fs.mkdirSync(SEED_DIR, { recursive: true });

  const strategic = {
    sinceDate: SINCE_DATE,
    generatedAt: new Date().toISOString(),
    months: allMonths,
    topIssues: issuesWithEvolution,
    topWins: winsWithEvolution,
  };
  fs.writeFileSync(path.join(SEED_DIR, "strategic-all.json"), JSON.stringify(strategic, null, 2));
  console.log(`  seed/strategic-all.json · ${issuesWithEvolution.length} issues + ${winsWithEvolution.length} wins`);

  console.log("\n=== done ===\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
