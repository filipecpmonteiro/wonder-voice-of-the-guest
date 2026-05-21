// Thin wrapper over Google Places API (New).
// Docs: https://developers.google.com/maps/documentation/places/web-service/place-details

export type GoogleReview = {
  name: string; // resource name, used as external id
  relativePublishTimeDescription: string;
  rating: number;
  text?: { text: string; languageCode: string };
  originalText?: { text: string; languageCode: string };
  authorAttribution?: {
    displayName: string;
    uri?: string;
    photoUri?: string;
  };
  publishTime: string; // ISO datetime
};

export type PlaceDetails = {
  id: string;
  displayName?: { text: string; languageCode: string };
  formattedAddress?: string;
  rating?: number;
  userRatingCount?: number;
  reviews?: GoogleReview[];
};

export async function fetchPlaceDetails(placeId: string): Promise<PlaceDetails | null> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    throw new Error("GOOGLE_PLACES_API_KEY is not set");
  }
  if (!placeId) return null;

  const fields = [
    "id",
    "displayName",
    "formattedAddress",
    "rating",
    "userRatingCount",
    "reviews",
  ].join(",");

  const res = await fetch(
    `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}?languageCode=en`,
    {
      method: "GET",
      headers: {
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": fields,
      },
      // Tolerate slow API; cache at the framework layer if needed
      cache: "no-store",
    }
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Google Places API error: ${res.status} ${res.statusText}, ${body.slice(0, 300)}`);
  }
  return (await res.json()) as PlaceDetails;
}
