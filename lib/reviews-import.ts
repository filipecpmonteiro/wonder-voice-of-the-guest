// Pure helpers for importing Outscraper review data.
// Lives outside any "use server" boundary because:
//   1. Server actions can't accept non-serializable params like Buffer
//   2. The on-boot seed (lib/seed.ts) needs to call these synchronously from db()
// Both the upload server action and the boot-time seed import from here.

import * as XLSX from "xlsx";
import crypto from "node:crypto";
import { db } from "./db";

export function parseOutscraperBuffer(buffer: Buffer): Record<string, unknown>[] {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error("Workbook has no sheets");
  return XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: null });
}

export function insertOutscraperRows(
  rows: Record<string, unknown>[],
  locationId: string
): { inserted: number; updated: number; skipped: number } {
  const insert = db().prepare(
    `INSERT OR IGNORE INTO reviews_cache
     (location_id, external_id, author_name, rating, text, time, relative_time_description, raw, owner_response, owner_response_time, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const update = db().prepare(
    `UPDATE reviews_cache
     SET owner_response = COALESCE(?, owner_response),
         owner_response_time = COALESCE(?, owner_response_time),
         source = ?
     WHERE location_id = ? AND external_id = ?`
  );

  let inserted = 0;
  let skipped = 0;
  let updated = 0;

  const tx = db().transaction((batchRows: Record<string, unknown>[]) => {
    for (const r of batchRows) {
      const reviewId = String(r["review_id"] ?? "").trim();
      const text = String(r["review_text"] ?? "").trim();
      if (!reviewId && !text) {
        skipped++;
        continue;
      }
      const rating = Number(r["review_rating"]);
      const safeRating =
        Number.isFinite(rating) && rating >= 1 && rating <= 5 ? Math.round(rating) : null;
      // Prefer the clean unix `review_timestamp` over the MM/DD/YYYY string
      const time =
        parseDateLoose(r["review_timestamp"]) ?? parseDateLoose(r["review_datetime_utc"]);
      const author = String(r["author_title"] ?? "").trim() || null;
      const ownerResponse = String(r["owner_answer"] ?? "").trim() || null;
      const ownerResponseTime =
        parseDateLoose(r["owner_answer_timestamp"]) ??
        parseDateLoose(r["owner_answer_timestamp_datetime_utc"]);
      const externalId = reviewId
        ? `outscraper-${reviewId}`
        : `outscraper-content-${crypto.createHash("sha256").update(`${safeRating}\n${text}`).digest("hex").slice(0, 24)}`;

      const result = insert.run(
        locationId,
        externalId,
        author,
        safeRating,
        text || null,
        time,
        null,
        JSON.stringify({ source: "outscraper", row: r }),
        ownerResponse,
        ownerResponseTime,
        "outscraper"
      );
      if (result.changes > 0) {
        inserted++;
      } else if (ownerResponse) {
        const upd = update.run(ownerResponse, ownerResponseTime, "outscraper", locationId, externalId);
        if (upd.changes > 0) updated++;
        else skipped++;
      } else {
        skipped++;
      }
    }
  });
  tx(rows);
  return { inserted, updated, skipped };
}

export function countOutscraperRows(locationId: string): number {
  const row = db()
    .prepare("SELECT COUNT(*) AS c FROM reviews_cache WHERE location_id = ? AND source = 'outscraper'")
    .get(locationId) as { c: number };
  return row.c;
}

// Tolerant date parser, handles ISO strings, "YYYY-MM-DD HH:MM:SS",
// "MM/DD/YYYY HH:MM:SS" (Outscraper's default), unix seconds, unix ms.
export function parseDateLoose(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return null;
    return v < 2e10 ? Math.round(v) : Math.round(v / 1000);
  }
  const s = String(v).trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return n < 2e10 ? n : Math.round(n / 1000);
  }
  // MM/DD/YYYY HH:MM:SS or MM/DD/YYYY (Outscraper), convert to ISO before Date.parse
  const usMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/);
  if (usMatch) {
    const [, mm, dd, yyyy, hh = "0", mi = "0", ss = "0"] = usMatch;
    const ms = Date.UTC(
      Number(yyyy),
      Number(mm) - 1,
      Number(dd),
      Number(hh),
      Number(mi),
      Number(ss)
    );
    if (!isNaN(ms)) return Math.round(ms / 1000);
  }
  // ISO-ish, replace space with T if needed
  const isoCandidate = s.includes("T") ? s : s.replace(" ", "T");
  const ms = Date.parse(isoCandidate);
  if (!isNaN(ms)) return Math.round(ms / 1000);
  return null;
}
