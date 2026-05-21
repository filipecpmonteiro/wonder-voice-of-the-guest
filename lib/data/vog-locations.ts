// Voice of the Guest location config.
// Wonder's NYC+NJ footprint is a single fleet of shops reviewed under one
// brand on Google, so there is no per-city switcher: the whole NYC fleet
// (including Jersey City and Hoboken) is presented as one aggregate. Lives in
// /lib/data (not /lib/server) because /lib/server/reviews.ts is "use server",
// which forbids exporting non-async values.

export const VOG_LOCATIONS: ReadonlyArray<{ key: string; city: string }> = [
  { key: "all", city: "All Wonder · NYC + NJ fleet" },
];

// Every Outscraper row is seeded under this single location id; the "all"
// aggregate in reviews.ts sums these keys.
export const VOG_AGGREGATE_KEYS = ["fleet"];
