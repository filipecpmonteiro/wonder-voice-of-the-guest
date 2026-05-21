import path from "node:path";
import fs from "node:fs";

// On-boot seed: if the DB has zero outscraper-sourced reviews for the fleet,
// import them from the bundled Wonder Outscraper xlsx. Idempotent —
// re-running is a no-op once rows are present.

const FLEET_LOCATION_ID = "fleet";
const SEED_XLSX = "seed/outscraper-wonder.xlsx";

export function maybeSeedFromOutscraper(): void {
  // Lazy-import to avoid a circular dependency (lib/reviews-import imports
  // lib/db which imports this file).
  let helpers: typeof import("./reviews-import");
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    helpers = require("./reviews-import");
  } catch (err) {
    console.warn("[seed] could not load reviews-import helpers:", err);
    return;
  }

  try {
    const existing = helpers.countOutscraperRows(FLEET_LOCATION_ID);
    if (existing > 0) {
      console.log(`[seed] fleet: ${existing} outscraper rows already present, skipping`);
      return;
    }
    const filePath = path.join(process.cwd(), SEED_XLSX);
    if (!fs.existsSync(filePath)) {
      console.log(`[seed] fleet: no seed file at ${filePath}, skipping`);
      return;
    }
    console.log(`[seed] fleet: reading ${SEED_XLSX}…`);
    const buffer = fs.readFileSync(filePath);
    const rows = helpers.parseOutscraperBuffer(buffer);
    console.log(`[seed] fleet: parsed ${rows.length} rows, inserting…`);
    const counts = helpers.insertOutscraperRows(rows, FLEET_LOCATION_ID);
    console.log(
      `[seed] fleet: ${counts.inserted} inserted, ${counts.updated} updated, ${counts.skipped} skipped`
    );
  } catch (err) {
    console.error("[seed] fleet FAILED:", err);
  }
}
