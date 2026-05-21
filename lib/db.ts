import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

// Single, shared SQLite handle. On Railway, mount a volume at /data and set DB_PATH=/data/wonder.db
const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), "data", "wonder.db");

const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

let _db: Database.Database | null = null;

export function db() {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  migrate(_db);
  // Run the on-boot seed. It's idempotent, only inserts if there are no
  // outscraper-sourced rows yet.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { maybeSeedFromOutscraper } = require("./seed") as typeof import("./seed");
  try {
    maybeSeedFromOutscraper();
  } catch (err) {
    console.error("[db] seed step threw:", err);
  }
  return _db;
}

function migrate(d: Database.Database) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS reviews_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      location_id TEXT NOT NULL,
      external_id TEXT,
      author_name TEXT,
      rating INTEGER,
      text TEXT,
      time INTEGER,
      relative_time_description TEXT,
      raw TEXT,
      fetched_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    );

    CREATE INDEX IF NOT EXISTS idx_reviews_cache_location ON reviews_cache(location_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_cache_dedup ON reviews_cache(location_id, external_id);

    CREATE TABLE IF NOT EXISTS review_analysis (
      review_id INTEGER PRIMARY KEY,
      sentiment TEXT,
      categories TEXT,
      themes TEXT,
      operational_signal TEXT,
      analyzed_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      FOREIGN KEY (review_id) REFERENCES reviews_cache(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS location_summary (
      location_id TEXT PRIMARY KEY,
      summary TEXT NOT NULL,
      summarized_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS response_analysis (
      review_id INTEGER PRIMARY KEY,
      response_style TEXT,            -- 'canned' | 'personalized' | 'defensive' | 'empathetic' | 'mixed'
      addresses_complaint INTEGER,    -- 0/1
      offers_remediation INTEGER,     -- 0/1
      tone TEXT,
      notes TEXT,
      analyzed_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      FOREIGN KEY (review_id) REFERENCES reviews_cache(id) ON DELETE CASCADE
    );
  `);

  // Additive migrations, run on every boot, no-op if already applied
  addColumnIfMissing(d, "reviews_cache", "owner_response", "TEXT");
  addColumnIfMissing(d, "reviews_cache", "owner_response_time", "INTEGER");
  addColumnIfMissing(d, "reviews_cache", "source", "TEXT"); // 'google_api' | 'pasted' | 'outscraper'
}

function addColumnIfMissing(d: Database.Database, table: string, column: string, type: string) {
  const cols = d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}
