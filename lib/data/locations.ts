// MOIC locations for cross-flagship benchmarking.
// Place IDs need to be filled in via .env (find via Google Place ID Finder).
// In dev these may all be empty, we degrade gracefully.

export type MoicLocation = {
  id: "nyc" | "boston" | "chicago" | "miami" | "singapore";
  city: string;
  isFlagship: boolean;
  isCurrent: boolean;
  envKeyForPlaceId: string;
  searchHint: string; // for the user setting up the env vars
};

export const moicLocations: MoicLocation[] = [
  {
    id: "nyc",
    city: "New York",
    isFlagship: true,
    isCurrent: true,
    envKeyForPlaceId: "MOIC_NYC_PLACE_ID",
    searchHint: "Museum of Ice Cream, 558 Broadway, New York",
  },
  {
    id: "boston",
    city: "Boston",
    isFlagship: false,
    isCurrent: false,
    envKeyForPlaceId: "MOIC_BOSTON_PLACE_ID",
    searchHint: "Museum of Ice Cream, Boston",
  },
  {
    id: "chicago",
    city: "Chicago",
    isFlagship: false,
    isCurrent: false,
    envKeyForPlaceId: "MOIC_CHICAGO_PLACE_ID",
    searchHint: "Museum of Ice Cream, Chicago",
  },
  {
    id: "miami",
    city: "Miami",
    isFlagship: false,
    isCurrent: false,
    envKeyForPlaceId: "MOIC_MIAMI_PLACE_ID",
    searchHint: "Museum of Ice Cream, Miami",
  },
  {
    id: "singapore",
    city: "Singapore",
    isFlagship: false,
    isCurrent: false,
    envKeyForPlaceId: "MOIC_SINGAPORE_PLACE_ID",
    searchHint: "Museum of Ice Cream, Singapore",
  },
];

// Categories Claude will tag every review with.
// These map directly to operational levers a GM can pull, not vague sentiment.
export const reviewCategories = [
  { id: "entry-exit", label: "Entry / Exit experience", color: "pink" as const },
  { id: "staff", label: "Staff & service", color: "rose" as const },
  { id: "cleanliness", label: "Cleanliness", color: "mint" as const },
  { id: "queue-wait", label: "Queue / wait time", color: "amber" as const },
  { id: "value", label: "Value for money", color: "lilac" as const },
  { id: "kid-friendly", label: "Kid-friendliness", color: "sky" as const },
  { id: "photo-ops", label: "Photo opportunities", color: "rose" as const },
  { id: "fnb", label: "F&B (ice cream, drinks)", color: "amber" as const },
  { id: "rooms-attractions", label: "Rooms & attractions", color: "lilac" as const },
  { id: "accessibility", label: "Accessibility", color: "sky" as const },
  { id: "broken-missing", label: "Broken / missing features", color: "pink" as const },
  { id: "communication", label: "Guest communication / signage", color: "mint" as const },
];

export type ReviewCategoryId = typeof reviewCategories[number]["id"];
