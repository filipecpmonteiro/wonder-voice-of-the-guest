"use server";

import { db } from "@/lib/db";
import { VOG_AGGREGATE_KEYS } from "@/lib/data/vog-locations";
import { fetchPlaceDetails } from "@/lib/google-places";
import { anthropic, REVIEW_MODEL } from "@/lib/anthropic";
import { moicLocations, reviewCategories } from "@/lib/data/locations";
import { revalidatePath } from "next/cache";
import crypto from "node:crypto";
import { parseOutscraperBuffer, insertOutscraperRows } from "@/lib/reviews-import";

export type ReviewRow = {
  id: number;
  location_id: string;
  external_id: string | null;
  author_name: string | null;
  rating: number | null;
  text: string | null;
  time: number | null;
  relative_time_description: string | null;
  owner_response: string | null;
  owner_response_time: number | null;
  source: string | null;
  fetched_at: number;
};

export type AnalysisRow = {
  review_id: number;
  sentiment: "positive" | "negative" | "mixed" | "neutral" | null;
  categories: string;
  themes: string;
  operational_signal: string | null;
  analyzed_at: number;
};

export type ResponseAnalysisRow = {
  review_id: number;
  response_style: "canned" | "personalized" | "defensive" | "empathetic" | "mixed" | null;
  addresses_complaint: number;
  offers_remediation: number;
  tone: string | null;
  notes: string | null;
  analyzed_at: number;
};

export type ReviewWithAnalysis = ReviewRow & {
  analysis?: AnalysisRow;
  responseAnalysis?: ResponseAnalysisRow;
};

export async function getReviewsForLocation(locationId: string): Promise<ReviewWithAnalysis[]> {
  const reviews = db()
    .prepare("SELECT * FROM reviews_cache WHERE location_id = ? ORDER BY time DESC")
    .all(locationId) as ReviewRow[];
  if (reviews.length === 0) return [];
  const ids = reviews.map((r) => r.id);
  const placeholders = ids.map(() => "?").join(",");
  const analyses = db()
    .prepare(`SELECT * FROM review_analysis WHERE review_id IN (${placeholders})`)
    .all(...ids) as AnalysisRow[];
  const responseAnalyses = db()
    .prepare(`SELECT * FROM response_analysis WHERE review_id IN (${placeholders})`)
    .all(...ids) as ResponseAnalysisRow[];
  const aById = new Map(analyses.map((a) => [a.review_id, a]));
  const raById = new Map(responseAnalyses.map((a) => [a.review_id, a]));
  return reviews.map((r) => ({ ...r, analysis: aById.get(r.id), responseAnalysis: raById.get(r.id) }));
}

export async function getAllLocationsSummary() {
  const rows = db()
    .prepare("SELECT * FROM location_summary")
    .all() as { location_id: string; summary: string; summarized_at: number }[];
  return Object.fromEntries(
    rows.map((r) => [r.location_id, { summary: JSON.parse(r.summary), summarized_at: r.summarized_at }])
  );
}

export async function getDataFreshness(): Promise<{ lastFetch: number | null; lastAnalyze: number | null }> {
  const f = db().prepare("SELECT MAX(fetched_at) as t FROM reviews_cache").get() as { t: number | null };
  const a = db().prepare("SELECT MAX(analyzed_at) as t FROM review_analysis").get() as { t: number | null };
  return { lastFetch: f?.t ?? null, lastAnalyze: a?.t ?? null };
}

// Trigger a refresh, fetch from Google, then analyze new reviews with Claude.
export async function refreshAllReviews(formData: FormData): Promise<{ ok: boolean; error?: string; details?: string }> {
  const password = String(formData.get("__password") ?? "");
  const required = process.env.EDIT_PASSWORD;
  if (required && password !== required) return { ok: false, error: "Incorrect edit password." };

  if (!process.env.GOOGLE_PLACES_API_KEY) {
    return { ok: false, error: "GOOGLE_PLACES_API_KEY not configured on the server." };
  }

  const summary: string[] = [];

  for (const loc of moicLocations) {
    const placeId = process.env[loc.envKeyForPlaceId];
    if (!placeId) {
      summary.push(`${loc.city}: no Place ID configured`);
      continue;
    }
    try {
      const details = await fetchPlaceDetails(placeId);
      const reviews = details?.reviews ?? [];
      let inserted = 0;
      for (const rv of reviews) {
        const externalId = rv.name;
        const text = rv.text?.text ?? rv.originalText?.text ?? "";
        const time = Math.floor(new Date(rv.publishTime).getTime() / 1000);
        const result = db()
          .prepare(
            `INSERT OR IGNORE INTO reviews_cache
             (location_id, external_id, author_name, rating, text, time, relative_time_description, raw)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            loc.id,
            externalId,
            rv.authorAttribution?.displayName ?? null,
            rv.rating ?? null,
            text,
            time,
            rv.relativePublishTimeDescription ?? null,
            JSON.stringify(rv)
          );
        if (result.changes > 0) inserted++;
      }
      // Update aggregate snapshot
      const snapshot = {
        rating_avg: details?.rating ?? null,
        count: details?.userRatingCount ?? null,
        display_name: details?.displayName?.text ?? loc.city,
        address: details?.formattedAddress ?? null,
        sample_size: reviews.length,
      };
      db()
        .prepare(
          `INSERT INTO location_summary (location_id, summary)
           VALUES (?, ?)
           ON CONFLICT(location_id) DO UPDATE SET summary = excluded.summary, summarized_at = (strftime('%s','now') * 1000)`
        )
        .run(loc.id, JSON.stringify(snapshot));
      summary.push(`${loc.city}: ${reviews.length} reviews fetched, ${inserted} new`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      summary.push(`${loc.city}: ERROR. ${msg.slice(0, 120)}`);
    }
  }

  const analysisLine = await runAnalysisPass();
  summary.push(analysisLine);

  // Cluster themes into top 5 wins / top 5 issues per location
  for (const loc of moicLocations) {
    const has = db().prepare("SELECT 1 FROM reviews_cache WHERE location_id = ? LIMIT 1").get(loc.id);
    if (has) {
      const sumResult = await summarizeReviewThemes(loc.id);
      if (sumResult.ok) summary.push(`${loc.city} themes: ${sumResult.details}`);
    }
  }

  revalidatePath("/");
  return { ok: true, details: summary.join(" · ") };
}

// Run analysis on reviews that don't yet have a row in review_analysis.
// Capped per call. Processes batches with 8-way concurrency for speed:
// at ~1.5s sequential per Claude call, 8 in parallel turns 800 reviews
// from ~20 minutes into ~2.5 minutes.
const ANALYSIS_BATCH_CAP = 800;
const ANALYSIS_CONCURRENCY = 8;

async function runAnalysisPass(maxToProcess = ANALYSIS_BATCH_CAP): Promise<string> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return "ANTHROPIC_API_KEY not set, skipping analysis pass";
  }
  try {
    const totalUnanalyzed = (db()
      .prepare(
        `SELECT COUNT(*) AS c FROM reviews_cache r
         LEFT JOIN review_analysis a ON a.review_id = r.id
         WHERE a.review_id IS NULL AND r.text IS NOT NULL AND length(r.text) > 0`
      )
      .get() as { c: number }).c;

    const batch = db()
      .prepare(
        `SELECT r.id, r.text, r.rating
         FROM reviews_cache r
         LEFT JOIN review_analysis a ON a.review_id = r.id
         WHERE a.review_id IS NULL AND r.text IS NOT NULL AND length(r.text) > 0
         ORDER BY r.time DESC NULLS LAST
         LIMIT ?`
      )
      .all(maxToProcess) as { id: number; text: string; rating: number | null }[];

    const insertStmt = db().prepare(
      `INSERT INTO review_analysis (review_id, sentiment, categories, themes, operational_signal)
       VALUES (?, ?, ?, ?, ?)`
    );

    let analyzed = 0;
    await processInParallel(batch, ANALYSIS_CONCURRENCY, async (u) => {
      try {
        const result = await analyzeReview(u.text, u.rating ?? undefined);
        insertStmt.run(
          u.id,
          result.sentiment,
          JSON.stringify(result.categories),
          JSON.stringify(result.themes),
          result.operationalSignal
        );
        analyzed++;
      } catch (err) {
        console.error("Analyze failed for review", u.id, err);
      }
    });

    const remaining = totalUnanalyzed - analyzed;
    const remainingNote = remaining > 0 ? ` (${remaining} still to go, re-run to process more)` : "";
    return `Claude analysis: ${analyzed}/${batch.length} reviews analyzed${remainingNote}`;
  } catch (err) {
    return `Analysis ERROR: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// Tiny async pool, processes items with bounded concurrency.
async function processInParallel<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let cursor = 0;
  const runners = new Array(Math.min(concurrency, items.length)).fill(0).map(async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      await worker(items[i]);
    }
  });
  await Promise.all(runners);
}

// Manual-trigger pass (UI button). Same logic as the auto pass but exposed as an action.
export async function processMoreReviews(formData: FormData): Promise<{
  ok: boolean;
  error?: string;
  details?: string;
}> {
  const password = String(formData.get("__password") ?? "");
  const required = process.env.EDIT_PASSWORD;
  if (required && password !== required) return { ok: false, error: "Incorrect edit password." };

  const cap = Math.max(1, Math.min(800, Number(formData.get("cap") ?? ANALYSIS_BATCH_CAP)));
  const line = await runAnalysisPass(cap);
  // Re-cluster after processing more
  const sumLine = await summarizeReviewThemes("nyc");
  // Run response analysis on any unanalyzed responses
  const respLine = await runResponseAnalysisPass(cap);
  revalidatePath("/");
  return {
    ok: true,
    details: [line, respLine, sumLine.ok ? `themes: ${sumLine.details}` : `themes: ${sumLine.error}`].join(" · "),
  };
}

// Analyze owner responses, separate Claude pass, runs on reviews that have
// owner_response but no row in response_analysis yet.
async function runResponseAnalysisPass(maxToProcess = ANALYSIS_BATCH_CAP): Promise<string> {
  if (!process.env.ANTHROPIC_API_KEY) return "Skipping response analysis (no API key)";
  try {
    const totalUnanalyzed = (db()
      .prepare(
        `SELECT COUNT(*) AS c FROM reviews_cache r
         LEFT JOIN response_analysis ra ON ra.review_id = r.id
         WHERE ra.review_id IS NULL
           AND r.owner_response IS NOT NULL AND length(r.owner_response) > 5`
      )
      .get() as { c: number }).c;

    if (totalUnanalyzed === 0) return "Response analysis: 0 unanalyzed";

    const batch = db()
      .prepare(
        `SELECT r.id, r.text AS review_text, r.rating, r.owner_response
         FROM reviews_cache r
         LEFT JOIN response_analysis ra ON ra.review_id = r.id
         WHERE ra.review_id IS NULL
           AND r.owner_response IS NOT NULL AND length(r.owner_response) > 5
         ORDER BY r.time DESC NULLS LAST
         LIMIT ?`
      )
      .all(maxToProcess) as { id: number; review_text: string; rating: number | null; owner_response: string }[];

    const insertStmt = db().prepare(
      `INSERT INTO response_analysis (review_id, response_style, addresses_complaint, offers_remediation, tone, notes)
       VALUES (?, ?, ?, ?, ?, ?)`
    );

    let analyzed = 0;
    await processInParallel(batch, ANALYSIS_CONCURRENCY, async (u) => {
      try {
        const result = await analyzeOwnerResponse(u.review_text, u.rating ?? undefined, u.owner_response);
        insertStmt.run(
          u.id,
          result.style,
          result.addressesComplaint ? 1 : 0,
          result.offersRemediation ? 1 : 0,
          result.tone,
          result.notes
        );
        analyzed++;
      } catch (err) {
        console.error("Response analyze failed for", u.id, err);
      }
    });
    const remaining = totalUnanalyzed - analyzed;
    const note = remaining > 0 ? ` (${remaining} responses still to go)` : "";
    return `Response analysis: ${analyzed}/${batch.length} processed${note}`;
  } catch (err) {
    return `Response analysis ERROR: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function analyzeOwnerResponse(
  reviewText: string | null,
  rating: number | undefined,
  responseText: string
): Promise<{
  style: "canned" | "personalized" | "defensive" | "empathetic" | "mixed";
  addressesComplaint: boolean;
  offersRemediation: boolean;
  tone: string;
  notes: string;
}> {
  // Reviews can be star-only (no text body), but the owner can still respond.
  // Those responses are still worth grading, they reveal whether the team
  // sends boilerplate to anyone who leaves a low star.
  const reviewBody = reviewText && reviewText.trim().length > 0
    ? reviewText.slice(0, 1500)
    : "[Star rating only, no written review.]";

  const prompt = `You are evaluating how a venue's management responded to a Google review. The review is from a guest at the Museum of Ice Cream NYC.

REVIEW (${rating ?? "?"} stars):
"""
${reviewBody}
"""

OWNER RESPONSE:
"""
${responseText.slice(0, 1500)}
"""

Assess the response. Return STRICT JSON:
{
  "style": "canned" | "personalized" | "defensive" | "empathetic" | "mixed",
  "addressesComplaint": boolean (does the response acknowledge the specific issue raised, or just generic thanks?),
  "offersRemediation": boolean (does the response invite contact, offer to fix, promise improvement, or just apologize?),
  "tone": short noun phrase (e.g. "warm but generic", "defensive", "professional and specific"),
  "notes": one short sentence noting anything that would surprise or land in an interview about response quality. <30 words. If the response is unremarkable, say so.
}

Definitions:
- "canned" = template language (e.g. "Thanks for visiting! We hope to see you again."), no specific acknowledgement
- "personalized" = mentions specifics from the review
- "defensive" = pushes back on the guest, makes excuses, blames the guest
- "empathetic" = acknowledges the guest's feelings, takes ownership
- "mixed" = has elements of more than one

Return ONLY the JSON.`;

  const res = await anthropic().messages.create({
    model: REVIEW_MODEL,
    max_tokens: 400,
    temperature: 0.1,
    messages: [{ role: "user", content: prompt }],
  });
  const block = res.content[0];
  if (block.type !== "text") throw new Error("Unexpected response shape");
  let raw = block.text.trim();
  if (raw.startsWith("```")) raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  const parsed = JSON.parse(raw) as {
    style: "canned" | "personalized" | "defensive" | "empathetic" | "mixed";
    addressesComplaint: boolean;
    offersRemediation: boolean;
    tone: string;
    notes: string;
  };
  return {
    style: parsed.style,
    addressesComplaint: !!parsed.addressesComplaint,
    offersRemediation: !!parsed.offersRemediation,
    tone: parsed.tone ?? "",
    notes: parsed.notes ?? "",
  };
}

// Outscraper xlsx import, bulk import with rich per-review data including owner responses.
// Designed for the file format Outscraper generates from Google Maps reviews.
export async function importOutscraperFile(formData: FormData): Promise<{
  ok: boolean;
  error?: string;
  details?: string;
}> {
  const password = String(formData.get("__password") ?? "");
  const required = process.env.EDIT_PASSWORD;
  if (required && password !== required) return { ok: false, error: "Incorrect edit password." };

  const file = formData.get("file");
  if (!(file instanceof File)) return { ok: false, error: "No file uploaded." };
  if (file.size > 30 * 1024 * 1024) return { ok: false, error: "File too large (max 30MB)." };

  const locationId = String(formData.get("locationId") ?? "nyc").trim();
  if (!moicLocations.some((l) => l.id === locationId)) {
    return { ok: false, error: `Unknown location: ${locationId}` };
  }

  let rows: Record<string, unknown>[];
  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    rows = parseOutscraperBuffer(buffer);
  } catch (err) {
    return { ok: false, error: `Could not parse xlsx: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (rows.length === 0) return { ok: false, error: "Sheet is empty." };

  let counts;
  try {
    counts = insertOutscraperRows(rows, locationId);
  } catch (err) {
    return { ok: false, error: `DB write failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  const analysisLine = await runAnalysisPass(ANALYSIS_BATCH_CAP);
  const respLine = await runResponseAnalysisPass(ANALYSIS_BATCH_CAP);
  const sumResult = await summarizeReviewThemes(locationId);
  revalidatePath("/");
  return {
    ok: true,
    details: `${rows.length} rows · ${counts.inserted} new · ${counts.updated} updated · ${counts.skipped} duplicates/empty · ${analysisLine} · ${respLine}${sumResult.ok ? ` · summary: ${sumResult.details}` : ""}`,
  };
}


// Bulk-paste path: Cristina copies reviews from a Google Maps reviews page
// and pastes them here. Claude parses the messy text into structured records,
// we dedupe, insert, and run analysis on the new ones.
export async function addPastedReviews(formData: FormData): Promise<{
  ok: boolean;
  error?: string;
  details?: string;
}> {
  const password = String(formData.get("__password") ?? "");
  const required = process.env.EDIT_PASSWORD;
  if (required && password !== required) {
    return { ok: false, error: "Incorrect edit password." };
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return { ok: false, error: "ANTHROPIC_API_KEY not configured on the server." };
  }

  const rawText = String(formData.get("rawText") ?? "").trim();
  const locationId = String(formData.get("locationId") ?? "nyc").trim();
  if (!rawText) return { ok: false, error: "Paste at least one review." };
  // Hard ceiling, anything bigger really should be split into multiple submissions
  // for reliability. 1M chars covers ~1000 typical Google reviews, plenty for one paste.
  if (rawText.length > 1_000_000) {
    return { ok: false, error: "Pasted text too long (max 1M chars). Split into multiple paste operations." };
  }
  if (!moicLocations.some((l) => l.id === locationId)) {
    return { ok: false, error: `Unknown location: ${locationId}` };
  }

  // Step 1, chunk and ask Claude to parse each chunk.
  // Claude Haiku has a 200k token context, but smaller chunks parse faster, more
  // reliably, and one chunk's failure doesn't kill the whole batch.
  const CHUNK_SIZE = 40_000;
  const chunks = chunkOnReviewBoundaries(rawText, CHUNK_SIZE);
  let parsedReviews: ParsedPastedReview[] = [];
  const chunkErrors: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    try {
      const fromChunk = await parsePastedReviews(chunks[i]);
      parsedReviews = parsedReviews.concat(fromChunk);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      chunkErrors.push(`chunk ${i + 1}/${chunks.length}: ${msg.slice(0, 80)}`);
    }
  }
  if (parsedReviews.length === 0) {
    const errSummary = chunkErrors.length > 0 ? ` Errors: ${chunkErrors.join("; ")}` : "";
    return { ok: false, error: `Claude could not extract any reviews from the pasted text.${errSummary}` };
  }

  // Step 2, insert each, deduped by sha256(rating + text)
  let inserted = 0;
  let duplicates = 0;
  for (const r of parsedReviews) {
    if (!r.text || !r.text.trim()) continue;
    const fingerprint = crypto
      .createHash("sha256")
      .update(`${r.rating ?? ""}\n${r.text.trim()}`)
      .digest("hex")
      .slice(0, 24);
    const externalId = `pasted-${fingerprint}`;
    const time = relativeTimeToUnixSeconds(r.relativeTime);
    const result = db()
      .prepare(
        `INSERT OR IGNORE INTO reviews_cache
         (location_id, external_id, author_name, rating, text, time, relative_time_description, raw)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        locationId,
        externalId,
        r.author ?? null,
        r.rating ?? null,
        r.text.trim(),
        time,
        r.relativeTime ?? null,
        JSON.stringify({ source: "pasted", parsed: r })
      );
    if (result.changes > 0) inserted++;
    else duplicates++;
  }

  // Step 3, analyze any new reviews
  const analysisLine = await runAnalysisPass();

  // Step 4, re-cluster themes into top 5 wins / top 5 issues
  const sumResult = await summarizeReviewThemes(locationId);

  revalidatePath("/");
  const chunkLine = chunks.length > 1 ? ` (${chunks.length} chunks)` : "";
  const errorLine = chunkErrors.length > 0 ? ` · WARN ${chunkErrors.length} chunk${chunkErrors.length > 1 ? "s" : ""} failed: ${chunkErrors.join("; ")}` : "";
  const summaryLine = sumResult.ok ? ` · summary: ${sumResult.details}` : "";
  return {
    ok: true,
    details: `${parsedReviews.length} reviews parsed${chunkLine} · ${inserted} new · ${duplicates} duplicates · ${analysisLine}${summaryLine}${errorLine}`,
  };
}

// Split large pasted text into chunks that respect review boundaries.
// Reviews are typically separated by blank lines on Google Maps; we accumulate
// paragraph-blocks until we'd exceed maxSize, then start a new chunk.
function chunkOnReviewBoundaries(text: string, maxSize: number): string[] {
  if (text.length <= maxSize) return [text];
  const blocks = text.split(/\n\s*\n/);
  const chunks: string[] = [];
  let current = "";
  for (const block of blocks) {
    const next = current ? current + "\n\n" + block : block;
    if (next.length > maxSize && current.length > 0) {
      chunks.push(current);
      current = block;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  // Edge case, a single block bigger than maxSize. Fall back to hard split.
  return chunks.flatMap((c) => {
    if (c.length <= maxSize) return [c];
    const out: string[] = [];
    for (let i = 0; i < c.length; i += maxSize) out.push(c.slice(i, i + maxSize));
    return out;
  });
}

type ParsedPastedReview = {
  author?: string;
  rating?: number;
  text: string;
  relativeTime?: string;
};

async function parsePastedReviews(rawText: string): Promise<ParsedPastedReview[]> {
  const prompt = `You are extracting structured review records from text that was pasted from a Google Maps reviews page.

The text may contain one review or many. Each review typically has: author name, star rating (often shown as ★ characters or a number), a relative time like "2 weeks ago" or "3 months ago", and the review body. There may also be noise like "Local Guide · 25 reviews", owner responses, "Show more" buttons, like counts, etc. Ignore the noise.

For owner responses: do NOT include them as separate reviews. Skip them.

Return STRICT JSON: an array of objects, each with keys:
- author: string (the reviewer name, no badges or counts; null if not visible)
- rating: integer 1-5 (count the filled stars; if a number is visible like "5/5" use it; null if you cannot determine)
- relativeTime: string (the relative time exactly as shown, e.g. "2 weeks ago", "3 months ago", "a year ago"; null if not visible)
- text: string (the review body, the substantive content the reviewer wrote, with line breaks normalized to spaces; required)

If you can't extract any valid reviews, return an empty array [].

Pasted text:
"""
${rawText}
"""

Return ONLY the JSON array, no surrounding text.`;

  const res = await anthropic().messages.create({
    model: REVIEW_MODEL,
    max_tokens: 8192,
    temperature: 0.1,
    messages: [{ role: "user", content: prompt }],
  });
  const block = res.content[0];
  if (block.type !== "text") throw new Error("Unexpected response shape");
  let raw = block.text.trim();
  if (raw.startsWith("```")) {
    raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  }
  const parsed = JSON.parse(raw) as Array<{
    author?: string | null;
    rating?: number | null;
    relativeTime?: string | null;
    text?: string | null;
  }>;
  if (!Array.isArray(parsed)) throw new Error("Claude did not return an array");
  return parsed
    .filter((r) => r && typeof r.text === "string" && r.text.trim().length > 0)
    .map((r) => ({
      author: r.author?.toString().trim() || undefined,
      rating: typeof r.rating === "number" && r.rating >= 1 && r.rating <= 5 ? Math.round(r.rating) : undefined,
      relativeTime: r.relativeTime?.toString().trim() || undefined,
      text: r.text!.toString().trim(),
    }));
}

// Convert "2 weeks ago" → approximate unix seconds.
// Best-effort, the relative_time_description field carries the original string for display.
function relativeTimeToUnixSeconds(rel?: string): number {
  const now = Math.floor(Date.now() / 1000);
  if (!rel) return now;
  const lower = rel.toLowerCase().trim();
  // "a year ago", "an hour ago" → treat "a/an" as 1
  const normalized = lower.replace(/^(a|an)\s+/, "1 ");
  const m = normalized.match(/^(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago$/);
  if (!m) return now;
  const n = parseInt(m[1], 10);
  const unit = m[2];
  const seconds: Record<string, number> = {
    second: 1,
    minute: 60,
    hour: 3600,
    day: 86_400,
    week: 7 * 86_400,
    month: 30 * 86_400,
    year: 365 * 86_400,
  };
  return now - n * seconds[unit];
}

async function analyzeReview(
  text: string,
  rating?: number
): Promise<{
  sentiment: "positive" | "negative" | "mixed" | "neutral";
  categories: string[];
  themes: string[];
  operationalSignal: string;
}> {
  const validCategories = reviewCategories.map((c) => c.id).join(", ");
  const prompt = `You are categorizing a Google review for the Museum of Ice Cream NYC, helping the General Manager identify operational levers.

Review (${rating ? `${rating} stars` : "no rating"}):
"""
${text.slice(0, 2000)}
"""

Return STRICT JSON with these keys:
- sentiment: "positive" | "negative" | "mixed" | "neutral"
- categories: array of 1-4 ids from this set: [${validCategories}]. Pick only those that are explicitly relevant.
- themes: 1-3 short noun phrases (each <8 words) describing the specific theme
- operational_signal: one short sentence (<25 words) describing the actionable lever a GM could pull. If the review is purely positive with no actionable feedback, write "none".

Return ONLY the JSON object, no surrounding text.`;

  const res = await anthropic().messages.create({
    model: REVIEW_MODEL,
    max_tokens: 400,
    temperature: 0.1,
    messages: [{ role: "user", content: prompt }],
  });
  const block = res.content[0];
  if (block.type !== "text") throw new Error("Unexpected response shape");
  let raw = block.text.trim();
  // strip code fences if present
  if (raw.startsWith("```")) {
    raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  }
  const parsed = JSON.parse(raw) as {
    sentiment: "positive" | "negative" | "mixed" | "neutral";
    categories: string[];
    themes: string[];
    operational_signal: string;
  };
  return {
    sentiment: parsed.sentiment,
    categories: (parsed.categories ?? []).filter((c) => reviewCategories.some((rc) => rc.id === c)),
    themes: parsed.themes ?? [],
    operationalSignal: parsed.operational_signal ?? "",
  };
}

// Sharp analytics for the GM. Two questions only:
//   1. What's the trajectory of the rating?
//   2. Top 5 things guests reward us for. Top 5 things they punish us for. With %.

export type RatingTrendPoint = { weekStart: number; avgRating: number; count: number };

export type ThemeBucket = {
  label: string;
  count: number;
  pctOfBucket: number;       // % of positive reviews (or negative reviews) that mention this theme
  whatToDo: string;          // 1-line prescription, plain English
  exampleQuote?: string;
};

export type SharpAnalytics = {
  totalReviews: number;
  rolling30dRating: number | null;
  rolling30dCount: number;
  allTimeAvg: number | null;
  positiveCount: number;     // 4-5 stars
  negativeCount: number;     // 1-3 stars
  ratingTrend: RatingTrendPoint[];   // weekly rolling, last ~12 weeks
  topWins: ThemeBucket[];
  topIssues: ThemeBucket[];
  summaryGeneratedAt: number | null;
  hasFreshSummary: boolean;  // true if summary exists, false if user needs to regenerate
};

const POSITIVE_THRESHOLD = 4;  // 4-5 stars = positive
const NEGATIVE_THRESHOLD = 3;  // 1-3 stars = negative

export async function getSharpAnalytics(locationId = "nyc"): Promise<SharpAnalytics> {
  const reviews = await getReviewsForLocation(locationId);
  const totalReviews = reviews.length;

  // Ratings
  const ratings = reviews
    .map((r) => r.rating)
    .filter((x): x is number => typeof x === "number");
  const allTimeAvg =
    ratings.length > 0 ? round1(ratings.reduce((a, b) => a + b, 0) / ratings.length) : null;

  // Rolling 30-day
  const cutoff30 = Math.floor(Date.now() / 1000) - 30 * 86400;
  const last30 = reviews.filter((r) => (r.time ?? 0) >= cutoff30);
  const last30Ratings = last30.map((r) => r.rating).filter((x): x is number => typeof x === "number");
  const rolling30dRating =
    last30Ratings.length > 0 ? round1(last30Ratings.reduce((a, b) => a + b, 0) / last30Ratings.length) : null;

  const positiveCount = reviews.filter((r) => (r.rating ?? 0) >= POSITIVE_THRESHOLD).length;
  const negativeCount = reviews.filter((r) => (r.rating ?? 5) <= NEGATIVE_THRESHOLD).length;

  // Weekly trend, last 12 weeks
  const ratingTrend = computeWeeklyTrend(reviews, 12);

  // Read cached summary (top wins / top issues) generated by Claude
  const summaryRow = db()
    .prepare("SELECT summary, summarized_at FROM location_summary WHERE location_id = ?")
    .get(locationId) as { summary: string; summarized_at: number } | undefined;

  let topWins: ThemeBucket[] = [];
  let topIssues: ThemeBucket[] = [];
  let summaryGeneratedAt: number | null = null;
  let hasFreshSummary = false;

  if (summaryRow) {
    try {
      const parsed = JSON.parse(summaryRow.summary);
      if (Array.isArray(parsed.topWins)) topWins = parsed.topWins;
      if (Array.isArray(parsed.topIssues)) topIssues = parsed.topIssues;
      summaryGeneratedAt = summaryRow.summarized_at;
      hasFreshSummary = topWins.length > 0 || topIssues.length > 0;
    } catch {
      // ignore parse errors, older summary format
    }
  }

  return {
    totalReviews,
    rolling30dRating,
    rolling30dCount: last30Ratings.length,
    allTimeAvg,
    positiveCount,
    negativeCount,
    ratingTrend,
    topWins,
    topIssues,
    summaryGeneratedAt,
    hasFreshSummary,
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function computeWeeklyTrend(reviews: ReviewWithAnalysis[], weeks: number): RatingTrendPoint[] {
  if (reviews.length === 0) return [];
  const now = Date.now();
  const weekMs = 7 * 86400 * 1000;
  const startOfThisWeek = Math.floor(now / weekMs) * weekMs;

  const out: RatingTrendPoint[] = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const weekStartMs = startOfThisWeek - i * weekMs;
    const weekEndMs = weekStartMs + weekMs;
    const inWeek = reviews.filter((r) => {
      if (!r.time) return false;
      const tMs = r.time * 1000;
      return tMs >= weekStartMs && tMs < weekEndMs;
    });
    const ratings = inWeek.map((r) => r.rating).filter((x): x is number => typeof x === "number");
    out.push({
      weekStart: Math.floor(weekStartMs / 1000),
      avgRating: ratings.length > 0 ? round1(ratings.reduce((a, b) => a + b, 0) / ratings.length) : 0,
      count: ratings.length,
    });
  }
  return out;
}

// ─── Rich analytics for the upgraded VOTG page ─────────────────────────────────

export type DeepTrendPoint = {
  bucketStart: number;       // unix seconds, start of the bucket
  label: string;             // human label e.g. "Mar 2026" or "Wk of Mar 4"
  count: number;
  positiveCount: number;     // 4-5★
  negativeCount: number;     // 1-3★
  avgRating: number | null;
};

export type PrePostSnapshot = {
  count: number;
  avgRating: number | null;
  positivePct: number;
  negativePct: number;
  responseRate: number;
};

export type PersistentIssue = {
  label: string;             // human bucket label
  prePct: number;            // % of pre-relaunch negative reviews mentioning it
  postPct: number;           // % of post-relaunch negative reviews mentioning it
  status: "persisting" | "worsening" | "improving" | "new" | "resolved";
  exampleQuote?: string;
};

export type ResponseStats = {
  totalReviews: number;
  reviewsWithResponse: number;
  responseRatePct: number;
  negativeReviews: number;
  negativesWithResponse: number;
  negativeResponseRatePct: number;
  medianResponseHours: number | null;
  responsesAnalyzed: number;
  styleBreakdown: { style: string; count: number; pct: number }[];
  addressesComplaintPct: number;        // among analyzed responses to negatives
  offersRemediationPct: number;
  bestSampleResponse?: { reviewText: string; responseText: string; rating: number | null; tone: string };
  worstSampleResponse?: { reviewText: string; responseText: string; rating: number | null; tone: string };
};

export type DeepAnalytics = {
  totalReviews: number;
  rolling30dRating: number | null;
  allTimeAvg: number | null;
  trends: {
    "1y": DeepTrendPoint[];
    "6m": DeepTrendPoint[];
    "3m": DeepTrendPoint[];
    "1m": DeepTrendPoint[];
  };
  prePost: { pre: PrePostSnapshot; post: PrePostSnapshot } | null;
  topWins: ThemeBucket[];
  topIssues: ThemeBucket[];
  persistentIssues: PersistentIssue[];
  responseStats: ResponseStats;
  conversationOpener: string | null;       // the single sharpest line for the interview
  summaryGeneratedAt: number | null;
  analysisCoverage: {                      // for transparency on the page
    perReviewAnalyzed: number;
    perReviewTotal: number;
    responseAnalyzed: number;
    responseTotal: number;
  };
  unanalyzedCount: number;
};

const RELAUNCH_DATE_ISO = "2026-02-04"; // unused for Van Leeuwen (no relaunch event); kept so shared helpers compile
const STRATEGIC_SINCE_ISO = "2024-01-01";

// 4 stores in the Showcase. Constants live in /lib/data/vog-locations.ts so they
// can be re-exported here without violating "use server" rules.

// Returns per-location review counts (since the strategic-since date) for the
// switcher chip labels. Cheap query, runs once per page load.
export async function getVogLocationCounts(): Promise<Record<string, number>> {
  const sinceSec = Math.floor(new Date("2025-01-01T00:00:00Z").getTime() / 1000);
  const rows = db()
    .prepare(
      `SELECT location_id, COUNT(*) AS c FROM reviews_cache
       WHERE time IS NOT NULL AND time >= ?
       GROUP BY location_id`
    )
    .all(sinceSec) as { location_id: string; c: number }[];
  const out: Record<string, number> = { all: 0 };
  for (const r of rows) {
    out[r.location_id] = r.c;
    if (VOG_AGGREGATE_KEYS.includes(r.location_id)) out.all += r.c;
  }
  return out;
}

// ─── Strategic analytics, reads pre-computed JSON, filters to since-date ──────

export type MonthlyEvolutionPoint = {
  month: string;       // "YYYY-MM"
  label: string;       // "May 25"
  pct: number;         // % of bucket reviews mentioning this theme
  matches: number;     // count of mentions
  denominator: number; // count of reviews in this bucket+month
};

export type StrategicBucket = {
  label: string;
  whatToDo: string;
  rationale: string;
  totalPct: number;
  totalMentions: number;
  totalDenominator: number;
  exampleQuote: string | null;
  monthlyEvolution: MonthlyEvolutionPoint[];
};

export type StrategicAnalytics = {
  sinceDate: string;             // ISO
  totalReviews: number;          // since since-date, all
  textReviews: number;           // since since-date, with text
  allTimeAvg: number | null;
  positiveCount: number;         // 4-5★ all
  negativeCount: number;         // 1-3★ all
  positiveTextCount: number;     // 4-5★ with text (denominator for top wins)
  negativeTextCount: number;     // 1-3★ with text (denominator for top issues)
  trends: {
    "1y": DeepTrendPoint[];
    "6m": DeepTrendPoint[];
    "3m": DeepTrendPoint[];
    "1m": DeepTrendPoint[];
  };
  prePost: { pre: PrePostSnapshot; post: PrePostSnapshot } | null;
  topIssues: StrategicBucket[];
  topWins: StrategicBucket[];
  responseStats: ResponseStats;
  conversationOpener: string | null;
  generatedAt: string | null;     // when the JSON was generated
};

export async function getStrategicAnalytics(locationId = "nyc"): Promise<StrategicAnalytics> {
  // "all" = aggregate of the 4 GM-showcase stores (NYC, Chicago, Miami, Boston).
  let allReviews: ReviewWithAnalysis[];
  if (locationId === "all") {
    const batches = await Promise.all(VOG_AGGREGATE_KEYS.map((k) => getReviewsForLocation(k)));
    allReviews = batches.flat();
  } else {
    allReviews = await getReviewsForLocation(locationId);
  }
  const sinceSec = Math.floor(new Date(STRATEGIC_SINCE_ISO + "T00:00:00Z").getTime() / 1000);
  const reviews = allReviews.filter((r) => (r.time ?? 0) >= sinceSec);

  const totalReviews = reviews.length;
  const textReviews = reviews.filter((r) => r.text && r.text.length > 0).length;
  const ratings = reviews.map((r) => r.rating).filter((x): x is number => typeof x === "number");
  const allTimeAvg = ratings.length > 0 ? round1(ratings.reduce((a, b) => a + b, 0) / ratings.length) : null;
  const positiveCount = reviews.filter((r) => (r.rating ?? 0) >= POSITIVE_THRESHOLD).length;
  const negativeCount = reviews.filter((r) => (r.rating ?? 5) <= NEGATIVE_THRESHOLD).length;
  const positiveTextCount = reviews.filter(
    (r) => (r.rating ?? 0) >= POSITIVE_THRESHOLD && r.text && r.text.length > 0
  ).length;
  const negativeTextCount = reviews.filter(
    (r) => (r.rating ?? 5) <= NEGATIVE_THRESHOLD && r.text && r.text.length > 0
  ).length;

  const trends = {
    "1y": computeBucketTrend(reviews, 365, "month"),
    "6m": computeBucketTrend(reviews, 180, "month"),
    "3m": computeBucketTrend(reviews, 90, "week"),
    "1m": computeBucketTrend(reviews, 30, "week"),
  };

  const prePost = computePrePost(reviews, RELAUNCH_DATE_ISO);
  // Response stats: only reviews WITH TEXT (responses to star-only reviews aren't actionable)
  const reviewsWithText = reviews.filter((r) => r.text && r.text.length > 0);
  const responseStats = computeResponseStats(reviewsWithText);

  // Load the strategic JSON if it exists. Each location has its own precomputed
  // JSON; "all" loads the cross-location aggregate.
  let topIssues: StrategicBucket[] = [];
  let topWins: StrategicBucket[] = [];
  let generatedAt: string | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs");
    const path = require("node:path");
    const filePath = path.join(process.cwd(), `seed/strategic-${locationId}.json`);
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw) as {
        generatedAt: string;
        topIssues: StrategicBucket[];
        topWins: StrategicBucket[];
      };
      topIssues = parsed.topIssues ?? [];
      topWins = parsed.topWins ?? [];
      generatedAt = parsed.generatedAt ?? null;
    }
  } catch (err) {
    console.error("[strategic] could not load JSON:", err);
  }

  const conversationOpener = buildStrategicOpener(topIssues, prePost);

  return {
    sinceDate: STRATEGIC_SINCE_ISO,
    totalReviews,
    textReviews,
    allTimeAvg,
    positiveCount,
    negativeCount,
    positiveTextCount,
    negativeTextCount,
    trends,
    prePost,
    topIssues,
    topWins,
    responseStats,
    conversationOpener,
    generatedAt,
  };
}

function buildStrategicOpener(topIssues: StrategicBucket[], _prePost: { pre: PrePostSnapshot; post: PrePostSnapshot } | null): string | null {
  if (topIssues.length === 0) return null;
  const top = topIssues[0];
  // Compare last 6 months avg pct vs first 6 months avg pct in the strategic window
  const evo = top.monthlyEvolution.filter((m) => m.denominator > 0);
  if (evo.length >= 4) {
    const half = Math.floor(evo.length / 2);
    const earlyAvg = avgOf(evo.slice(0, half).map((m) => m.pct));
    const lateAvg = avgOf(evo.slice(-half).map((m) => m.pct));
    if (lateAvg >= earlyAvg) {
      return `"${top.label}" appears in ${top.totalPct}% of negative reviews, and it hasn't moved in 12 months (${earlyAvg}% then, ${lateAvg}% now). How is the team thinking about that?`;
    } else {
      return `"${top.label}" still appears in ${top.totalPct}% of negative reviews. It's improving (${earlyAvg}% → ${lateAvg}%) but isn't fixed. What's driving the change?`;
    }
  }
  return `"${top.label}" appears in ${top.totalPct}% of negative reviews. ${top.rationale}`;
}

function avgOf(xs: number[]): number {
  if (xs.length === 0) return 0;
  return Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
}

export async function getDeepAnalytics(locationId = "nyc"): Promise<DeepAnalytics> {
  const reviews = await getReviewsForLocation(locationId);
  const totalReviews = reviews.length;

  const ratings = reviews.map((r) => r.rating).filter((x): x is number => typeof x === "number");
  const allTimeAvg = ratings.length > 0 ? round1(ratings.reduce((a, b) => a + b, 0) / ratings.length) : null;

  const cutoff30 = Math.floor(Date.now() / 1000) - 30 * 86400;
  const last30Ratings = reviews
    .filter((r) => (r.time ?? 0) >= cutoff30)
    .map((r) => r.rating)
    .filter((x): x is number => typeof x === "number");
  const rolling30dRating =
    last30Ratings.length > 0 ? round1(last30Ratings.reduce((a, b) => a + b, 0) / last30Ratings.length) : null;

  const trends = {
    "1y": computeBucketTrend(reviews, 365, "month"),
    "6m": computeBucketTrend(reviews, 180, "month"),
    "3m": computeBucketTrend(reviews, 90, "week"),
    "1m": computeBucketTrend(reviews, 30, "week"),
  };

  const prePost = computePrePost(reviews, RELAUNCH_DATE_ISO);

  // Read cached summary
  const summaryRow = db()
    .prepare("SELECT summary, summarized_at FROM location_summary WHERE location_id = ?")
    .get(locationId) as { summary: string; summarized_at: number } | undefined;
  let topWins: ThemeBucket[] = [];
  let topIssues: ThemeBucket[] = [];
  let summaryGeneratedAt: number | null = null;
  if (summaryRow) {
    try {
      const parsed = JSON.parse(summaryRow.summary);
      if (Array.isArray(parsed.topWins)) topWins = parsed.topWins;
      if (Array.isArray(parsed.topIssues)) topIssues = parsed.topIssues;
      summaryGeneratedAt = summaryRow.summarized_at;
    } catch {}
  }

  const persistentIssues = computePersistentIssues(reviews, topIssues, RELAUNCH_DATE_ISO);
  const responseStats = computeResponseStats(reviews);
  const conversationOpener = buildConversationOpener(persistentIssues, topIssues, prePost);

  const perReviewTotal = reviews.filter((r) => r.text && r.text.length > 0).length;
  const perReviewAnalyzed = reviews.filter((r) => r.analysis).length;
  const responseTotal = reviews.filter((r) => r.owner_response).length;
  const responseAnalyzed = reviews.filter((r) => r.responseAnalysis).length;
  const unanalyzedCount = perReviewTotal - perReviewAnalyzed;

  return {
    totalReviews,
    rolling30dRating,
    allTimeAvg,
    trends,
    prePost,
    topWins,
    topIssues,
    persistentIssues,
    responseStats,
    conversationOpener,
    summaryGeneratedAt,
    analysisCoverage: { perReviewAnalyzed, perReviewTotal, responseAnalyzed, responseTotal },
    unanalyzedCount,
  };
}

// ─── Trend bucketing helpers ──────────────────────────────────────────────────

type BucketUnit = "day" | "week" | "month";

// Compute the bucket-key (start of bucket in unix seconds) for a date and unit.
function bucketKey(d: Date, unit: BucketUnit): number {
  if (unit === "month") {
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
  }
  if (unit === "week") {
    const day = d.getUTCDay();
    const diff = (day + 6) % 7; // Monday-based week
    const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - diff));
    return monday.getTime() / 1000;
  }
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000;
}

// Step from one bucket-key to the next.
function nextBucketKey(keySec: number, unit: BucketUnit): number {
  const d = new Date(keySec * 1000);
  if (unit === "month") return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000;
  if (unit === "week") return keySec + 7 * 86400;
  return keySec + 86400;
}

function bucketLabel(keySec: number, unit: BucketUnit): string {
  const d = new Date(keySec * 1000);
  if (unit === "month") return d.toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" });
  if (unit === "week") return "Wk " + d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function computeBucketTrend(
  reviews: ReviewWithAnalysis[],
  windowDays: number,
  unit: BucketUnit
): DeepTrendPoint[] {
  if (reviews.length === 0) return [];
  const nowSec = Math.floor(Date.now() / 1000);
  // Snap the window start to the START of the bucket that today-windowDays falls in.
  // This keeps every displayed bucket full instead of chopping off the earliest one.
  const rawStart = nowSec - windowDays * 86400;
  const startKey = bucketKey(new Date(rawStart * 1000), unit);
  const inWindow = reviews.filter((r) => r.time != null && r.time >= startKey && r.time <= nowSec);

  const buckets = new Map<number, { count: number; sum: number; pos: number; neg: number }>();
  for (const r of inWindow) {
    if (r.time == null) continue;
    const key = bucketKey(new Date(r.time * 1000), unit);
    const cur = buckets.get(key) ?? { count: 0, sum: 0, pos: 0, neg: 0 };
    cur.count += 1;
    if (typeof r.rating === "number") {
      cur.sum += r.rating;
      if (r.rating >= POSITIVE_THRESHOLD) cur.pos += 1;
      else if (r.rating <= NEGATIVE_THRESHOLD) cur.neg += 1;
    }
    buckets.set(key, cur);
  }

  // Emit a continuous series of buckets from startKey to today, even if some are empty.
  // This keeps the chart's x-axis evenly spaced in time and avoids missing-bucket gaps.
  const out: DeepTrendPoint[] = [];
  const todayKey = bucketKey(new Date(nowSec * 1000), unit);
  for (let k = startKey; k <= todayKey; k = nextBucketKey(k, unit)) {
    const b = buckets.get(k);
    out.push({
      bucketStart: k,
      label: bucketLabel(k, unit),
      count: b?.count ?? 0,
      positiveCount: b?.pos ?? 0,
      negativeCount: b?.neg ?? 0,
      avgRating: b && b.count > 0 ? round1(b.sum / b.count) : null,
    });
  }
  return out;
}

// ─── Pre/post relaunch ────────────────────────────────────────────────────────

function computePrePost(reviews: ReviewWithAnalysis[], cutoffIso: string): { pre: PrePostSnapshot; post: PrePostSnapshot } | null {
  const cutoffSec = Math.floor(new Date(cutoffIso).getTime() / 1000);
  const lookbackSec = cutoffSec - 365 * 86400; // only look back 1 year for fairness
  const pre = reviews.filter((r) => r.time != null && r.time >= lookbackSec && r.time < cutoffSec);
  const post = reviews.filter((r) => r.time != null && r.time >= cutoffSec);
  if (pre.length === 0 && post.length === 0) return null;

  return {
    pre: snapshot(pre),
    post: snapshot(post),
  };
}

function snapshot(rs: ReviewWithAnalysis[]): PrePostSnapshot {
  const count = rs.length;
  const ratings = rs.map((r) => r.rating).filter((x): x is number => typeof x === "number");
  const avgRating = ratings.length > 0 ? round1(ratings.reduce((a, b) => a + b, 0) / ratings.length) : null;
  const pos = rs.filter((r) => (r.rating ?? 0) >= POSITIVE_THRESHOLD).length;
  const neg = rs.filter((r) => (r.rating ?? 5) <= NEGATIVE_THRESHOLD).length;
  const withResponse = rs.filter((r) => r.owner_response).length;
  return {
    count,
    avgRating,
    positivePct: count > 0 ? Math.round((pos / count) * 100) : 0,
    negativePct: count > 0 ? Math.round((neg / count) * 100) : 0,
    responseRate: count > 0 ? Math.round((withResponse / count) * 100) : 0,
  };
}

// ─── Issue persistence ────────────────────────────────────────────────────────

function computePersistentIssues(
  reviews: ReviewWithAnalysis[],
  topIssues: ThemeBucket[],
  cutoffIso: string
): PersistentIssue[] {
  if (topIssues.length === 0) return [];
  const cutoffSec = Math.floor(new Date(cutoffIso).getTime() / 1000);
  const lookbackSec = cutoffSec - 365 * 86400;
  const negativeReviews = reviews.filter((r) => (r.rating ?? 5) <= NEGATIVE_THRESHOLD);
  const preNeg = negativeReviews.filter((r) => r.time != null && r.time >= lookbackSec && r.time < cutoffSec);
  const postNeg = negativeReviews.filter((r) => r.time != null && r.time >= cutoffSec);
  if (preNeg.length === 0 && postNeg.length === 0) return [];

  // For each top issue, count reviews-mentioning in pre vs post.
  // We reuse the bucket label and check theme strings against it (substring + any-of-evidence trick).
  const out: PersistentIssue[] = [];
  for (const issue of topIssues) {
    const labelLower = issue.label.toLowerCase();
    const labelWords = labelLower.split(/\s+/).filter((w) => w.length > 3);
    const matches = (r: ReviewWithAnalysis) => {
      if (!r.analysis) return false;
      try {
        const themes: string[] = JSON.parse(r.analysis.themes || "[]");
        const text = themes.join(" | ").toLowerCase();
        // Match if any non-trivial word of the label appears in any theme
        return labelWords.some((w) => text.includes(w));
      } catch {
        return false;
      }
    };
    const preMatches = preNeg.filter(matches).length;
    const postMatches = postNeg.filter(matches).length;
    const prePct = preNeg.length > 0 ? Math.round((preMatches / preNeg.length) * 100) : 0;
    const postPct = postNeg.length > 0 ? Math.round((postMatches / postNeg.length) * 100) : 0;

    let status: PersistentIssue["status"];
    if (prePct === 0 && postPct > 5) status = "new";
    else if (postPct === 0 && prePct > 5) status = "resolved";
    else if (postPct > prePct + 3) status = "worsening";
    else if (prePct > postPct + 3) status = "improving";
    else status = "persisting";

    // Pick example quote from a recent post-relaunch matching review
    const examplePool = postNeg.filter(matches).slice(0, 5);
    const example = examplePool.find((r) => r.text && r.text.length > 30)?.text?.slice(0, 220);

    out.push({
      label: issue.label,
      prePct,
      postPct,
      status,
      exampleQuote: example,
    });
  }
  // Order: persisting/worsening first (these are the conversation), then new, then improving, then resolved
  const orderRank: Record<PersistentIssue["status"], number> = {
    worsening: 0,
    persisting: 1,
    new: 2,
    improving: 3,
    resolved: 4,
  };
  out.sort((a, b) => {
    const r = orderRank[a.status] - orderRank[b.status];
    if (r !== 0) return r;
    return b.postPct - a.postPct;
  });
  return out;
}

// ─── Response stats ───────────────────────────────────────────────────────────

function computeResponseStats(reviews: ReviewWithAnalysis[]): ResponseStats {
  const totalReviews = reviews.length;
  const reviewsWithResponse = reviews.filter((r) => r.owner_response).length;
  const negativeReviews = reviews.filter((r) => (r.rating ?? 5) <= NEGATIVE_THRESHOLD).length;
  const negativesWithResponse = reviews.filter(
    (r) => (r.rating ?? 5) <= NEGATIVE_THRESHOLD && r.owner_response
  ).length;

  // Response time (hours) when both timestamps available
  const responseHours: number[] = [];
  for (const r of reviews) {
    if (r.owner_response && r.owner_response_time != null && r.time != null) {
      const diffSec = r.owner_response_time - r.time;
      if (diffSec > 0) responseHours.push(diffSec / 3600);
    }
  }
  const medianResponseHours = responseHours.length > 0 ? round1(median(responseHours)) : null;

  // Response style breakdown (only over analyzed responses)
  const analyzed = reviews.filter((r) => r.responseAnalysis);
  const styleCounts = new Map<string, number>();
  let addressed = 0;
  let remediated = 0;
  for (const r of analyzed) {
    const ra = r.responseAnalysis!;
    if (ra.response_style) styleCounts.set(ra.response_style, (styleCounts.get(ra.response_style) ?? 0) + 1);
    if (ra.addresses_complaint) addressed++;
    if (ra.offers_remediation) remediated++;
  }
  const styleBreakdown = Array.from(styleCounts.entries())
    .map(([style, count]) => ({ style, count, pct: analyzed.length > 0 ? Math.round((count / analyzed.length) * 100) : 0 }))
    .sort((a, b) => b.count - a.count);

  // Pick illustrative samples
  const sampleAnalyzed = analyzed.filter((r) => (r.rating ?? 5) <= NEGATIVE_THRESHOLD);
  const bestSample = sampleAnalyzed.find(
    (r) => r.responseAnalysis?.response_style === "personalized" || r.responseAnalysis?.response_style === "empathetic"
  );
  const worstSample = sampleAnalyzed.find(
    (r) => r.responseAnalysis?.response_style === "canned" || r.responseAnalysis?.response_style === "defensive"
  );

  return {
    totalReviews,
    reviewsWithResponse,
    responseRatePct: totalReviews > 0 ? Math.round((reviewsWithResponse / totalReviews) * 100) : 0,
    negativeReviews,
    negativesWithResponse,
    negativeResponseRatePct: negativeReviews > 0 ? Math.round((negativesWithResponse / negativeReviews) * 100) : 0,
    medianResponseHours,
    responsesAnalyzed: analyzed.length,
    styleBreakdown,
    addressesComplaintPct: analyzed.length > 0 ? Math.round((addressed / analyzed.length) * 100) : 0,
    offersRemediationPct: analyzed.length > 0 ? Math.round((remediated / analyzed.length) * 100) : 0,
    bestSampleResponse: bestSample
      ? {
          reviewText: bestSample.text?.slice(0, 320) ?? "",
          responseText: bestSample.owner_response?.slice(0, 320) ?? "",
          rating: bestSample.rating,
          tone: bestSample.responseAnalysis?.tone ?? "",
        }
      : undefined,
    worstSampleResponse: worstSample
      ? {
          reviewText: worstSample.text?.slice(0, 320) ?? "",
          responseText: worstSample.owner_response?.slice(0, 320) ?? "",
          rating: worstSample.rating,
          tone: worstSample.responseAnalysis?.tone ?? "",
        }
      : undefined,
  };
}

function median(arr: number[]): number {
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

// The single sharpest line for the interview, derived from the data.
function buildConversationOpener(
  persistent: PersistentIssue[],
  topIssues: ThemeBucket[],
  prePost: { pre: PrePostSnapshot; post: PrePostSnapshot } | null
): string | null {
  const candidate = persistent.find((p) => p.status === "persisting" || p.status === "worsening");
  if (candidate && prePost) {
    return `"${candidate.label}" appears in ${candidate.postPct}% of negative reviews since the Feb 4 relaunch, vs. ${candidate.prePct}% before. ${
      candidate.status === "worsening" ? "It's gotten worse." : "The relaunch didn't fix it."
    } How is the team thinking about that?`;
  }
  if (topIssues.length > 0) {
    const top = topIssues[0];
    return `"${top.label}" appears in ${top.pctOfBucket}% of negative reviews. How is the team thinking about that?`;
  }
  return null;
}

export async function getCrossLocationBenchmark() {
  const summaries = await getAllLocationsSummary();
  return moicLocations.map((loc) => {
    const s = summaries[loc.id]?.summary ?? null;
    return {
      id: loc.id,
      city: loc.city,
      isCurrent: loc.isCurrent,
      avgRating: s?.rating_avg ?? null,
      count: s?.count ?? null,
      sampleSize: s?.sample_size ?? null,
      hasPlaceId: !!process.env[loc.envKeyForPlaceId],
    };
  });
}

// ─── Claude theme-clustering summary pass ───────────────────────────────────────
// Aggregates all themes from positive reviews and from negative reviews,
// sends to Claude with instructions to cluster + rank into top-5 buckets with %,
// stores the result in location_summary. Called automatically after refresh/paste,
// and exposed as a manual server action.

type ClusteredBucket = {
  label: string;
  evidenceThemes: string[];
  pctOfBucket: number;
  whatToDo: string;
};

export async function summarizeReviewThemes(locationId = "nyc"): Promise<{
  ok: boolean;
  error?: string;
  details?: string;
}> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { ok: false, error: "ANTHROPIC_API_KEY not configured" };
  }

  const reviews = await getReviewsForLocation(locationId);
  if (reviews.length === 0) {
    return { ok: false, error: "No reviews to summarize. Refresh or paste reviews first." };
  }

  // Bucket reviews by sentiment-from-rating (more reliable than Claude's per-review sentiment)
  const positive = reviews.filter((r) => (r.rating ?? 0) >= POSITIVE_THRESHOLD);
  const negative = reviews.filter((r) => (r.rating ?? 5) <= NEGATIVE_THRESHOLD);

  // Collect themes per bucket
  const positiveThemes: { theme: string; example: string }[] = [];
  const negativeThemes: { theme: string; example: string }[] = [];
  for (const r of positive) {
    if (!r.analysis) continue;
    try {
      const themes: string[] = JSON.parse(r.analysis.themes || "[]");
      for (const t of themes) positiveThemes.push({ theme: t, example: r.text?.slice(0, 240) ?? "" });
    } catch {}
  }
  for (const r of negative) {
    if (!r.analysis) continue;
    try {
      const themes: string[] = JSON.parse(r.analysis.themes || "[]");
      for (const t of themes) negativeThemes.push({ theme: t, example: r.text?.slice(0, 240) ?? "" });
    } catch {}
  }

  if (positiveThemes.length === 0 && negativeThemes.length === 0) {
    return {
      ok: false,
      error: "Reviews are present but no themes have been extracted. Run the per-review analysis first.",
    };
  }

  const positiveJson = JSON.stringify(positiveThemes.map((t) => t.theme));
  const negativeJson = JSON.stringify(negativeThemes.map((t) => t.theme));

  const prompt = `You are a hospitality operations analyst. You have themes extracted from Google reviews of the Museum of Ice Cream NYC, split by review rating (positive = 4-5 stars, negative = 1-3 stars).

Your job: cluster these into the TOP 5 wins (positive themes) and TOP 5 fixable issues (negative themes), so the General Manager can act on a short list, not a laundry list.

GUIDELINES:
- Cluster aggressively. "long wait", "long line", "wait time at entry", "queue too long" are ALL the same bucket.
- Use plain English bucket labels (3-7 words). E.g. "Long wait at entry", "Kids visibly happy", "F&B is generous".
- For each bucket, "whatToDo" must be a SPECIFIC operational action a GM can take, in one short sentence (<20 words). NEVER suggest changing pricing, since a $24M operation has already optimized that. Suggest things like better signage, staff scripts, room flow, cleaning cadence, role assignments.
- For wins: "whatToDo" should be what to PROTECT or REPLICATE. E.g. "Protect the cleaning rotation cadence" or "Brief staff at the cocktail counter on the singing routine to replicate elsewhere".
- For issues: "whatToDo" should be the cheapest, fastest fix that addresses the root.
- Skip noise themes ("good", "bad", "cool", "fun", "nice"). They're not actionable.
- Skip owner-response leakage ("thanks for visiting").

POSITIVE REVIEW THEMES (${positive.length} reviews, ${positiveThemes.length} themes):
${positiveJson}

NEGATIVE REVIEW THEMES (${negative.length} reviews, ${negativeThemes.length} themes):
${negativeJson}

Return STRICT JSON with this shape:
{
  "topWins": [
    { "label": "...", "evidenceThemes": ["...", "..."], "whatToDo": "..." },
    ... up to 5
  ],
  "topIssues": [
    { "label": "...", "evidenceThemes": ["...", "..."], "whatToDo": "..." },
    ... up to 5
  ]
}

For each bucket, evidenceThemes is the list of original themes that map into that cluster (used downstream to compute % of reviews mentioning the bucket).

Return ONLY the JSON, no surrounding text.`;

  let parsed: { topWins: ClusteredBucket[]; topIssues: ClusteredBucket[] };
  try {
    const res = await anthropic().messages.create({
      model: REVIEW_MODEL,
      max_tokens: 4096,
      temperature: 0.1,
      messages: [{ role: "user", content: prompt }],
    });
    const block = res.content[0];
    if (block.type !== "text") throw new Error("Unexpected response shape");
    let raw = block.text.trim();
    if (raw.startsWith("```")) {
      raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    }
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `Claude summary failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Compute % of reviews-of-that-bucket mentioning each theme.
  // We count a review as "mentioning the bucket" if any of its themes substring-match
  // any of the evidenceThemes in the bucket.
  const computePct = (
    bucket: ClusteredBucket,
    bucketReviews: ReviewWithAnalysis[]
  ): number => {
    if (bucketReviews.length === 0) return 0;
    const evidenceLower = bucket.evidenceThemes.map((e) => e.toLowerCase());
    let mentions = 0;
    for (const r of bucketReviews) {
      if (!r.analysis) continue;
      try {
        const themes: string[] = JSON.parse(r.analysis.themes || "[]");
        const themesLower = themes.map((t) => t.toLowerCase());
        const hit = evidenceLower.some((e) =>
          themesLower.some((t) => t.includes(e) || e.includes(t))
        );
        if (hit) mentions++;
      } catch {}
    }
    return Math.round((mentions / bucketReviews.length) * 100);
  };

  const findExample = (bucket: ClusteredBucket, themeList: { theme: string; example: string }[]): string | undefined => {
    const evidenceLower = bucket.evidenceThemes.map((e) => e.toLowerCase());
    const hit = themeList.find((t) =>
      evidenceLower.some((e) => t.theme.toLowerCase().includes(e) || e.includes(t.theme.toLowerCase()))
    );
    return hit?.example;
  };

  const topWins: ThemeBucket[] = (parsed.topWins ?? []).slice(0, 5).map((b) => ({
    label: b.label,
    count: b.evidenceThemes.length,
    pctOfBucket: computePct(b, positive),
    whatToDo: b.whatToDo,
    exampleQuote: findExample(b, positiveThemes),
  }));

  const topIssues: ThemeBucket[] = (parsed.topIssues ?? []).slice(0, 5).map((b) => ({
    label: b.label,
    count: b.evidenceThemes.length,
    pctOfBucket: computePct(b, negative),
    whatToDo: b.whatToDo,
    exampleQuote: findExample(b, negativeThemes),
  }));

  // Read existing summary (so we don't blow away rating_avg/count fields from Google fetch)
  const existing = db()
    .prepare("SELECT summary FROM location_summary WHERE location_id = ?")
    .get(locationId) as { summary: string } | undefined;
  let merged: Record<string, unknown> = {};
  if (existing) {
    try {
      merged = JSON.parse(existing.summary);
    } catch {}
  }
  merged.topWins = topWins;
  merged.topIssues = topIssues;
  merged.positive_count = positive.length;
  merged.negative_count = negative.length;

  db()
    .prepare(
      `INSERT INTO location_summary (location_id, summary)
       VALUES (?, ?)
       ON CONFLICT(location_id) DO UPDATE SET summary = excluded.summary, summarized_at = (strftime('%s','now') * 1000)`
    )
    .run(locationId, JSON.stringify(merged));

  return {
    ok: true,
    details: `${topWins.length} wins · ${topIssues.length} issues clustered from ${positive.length} positive + ${negative.length} negative reviews.`,
  };
}

// Manual server action, re-cluster without re-fetching from Google
export async function regenerateSummary(formData: FormData): Promise<{
  ok: boolean;
  error?: string;
  details?: string;
}> {
  const password = String(formData.get("__password") ?? "");
  const required = process.env.EDIT_PASSWORD;
  if (required && password !== required) {
    return { ok: false, error: "Incorrect edit password." };
  }
  const locationId = String(formData.get("locationId") ?? "nyc").trim();
  const result = await summarizeReviewThemes(locationId);
  if (result.ok) revalidatePath("/");
  return result;
}
