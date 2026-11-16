import { normalizeLocation } from "./flight-math.ts";
import type { FlightLocation } from "./types.ts";

/** A Photon (GeoJSON) search result; only the fields read here. */
export interface SearchFeature {
  geometry?: { coordinates?: unknown } | null;
  properties?: {
    name?: string;
    city?: string;
    state?: string;
    country?: string;
  } | null;
}
export interface SearchResult {
  name: string;
  detail: string;
  place: FlightLocation;
}
type FetchLike = (
  input: URL,
  init: { signal: AbortSignal; credentials: RequestCredentials },
) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
type StorageLike = Pick<Storage, "getItem" | "setItem">;

export class SearchThrottleError extends Error {}
function browserStorage(): StorageLike | null {
  try {
    return globalThis.sessionStorage;
  } catch {
    return null;
  }
}

export class PlaceSearch {
  endpoint: string;
  fetch: FetchLike;
  storage: StorageLike | null;
  now: () => number;
  cache = new Map<string, SearchFeature[]>();
  lastRequest = -Infinity;
  controller: AbortController | null = null;
  busy = false;

  constructor(
    endpoint: string,
    {
      fetchImpl = (input, init) => globalThis.fetch(input, init),
      storage = browserStorage(),
      now = () => performance.now(),
    }: {
      fetchImpl?: FetchLike;
      storage?: StorageLike | null;
      now?: () => number;
    } = {},
  ) {
    this.endpoint = endpoint;
    this.fetch = fetchImpl;
    this.storage = storage;
    this.now = now;
  }
  abort(): void {
    this.controller?.abort();
  }
  async search(query: string): Promise<SearchFeature[]> {
    const key = query.toLocaleLowerCase();
    let features = this.cache.get(key);
    if (!features) {
      try {
        const saved = JSON.parse(
          this.storage?.getItem("nightflight-search:" + key) ?? "null",
        );
        if (
          saved &&
          Date.now() - saved.time < 86400000 &&
          Array.isArray(saved.features)
        )
          features = saved.features;
      } catch {}
    }
    if (features) return features;
    if (this.now() - this.lastRequest < 1200)
      throw new SearchThrottleError(
        "Please wait a moment before searching again.",
      );
    this.busy = true;
    this.lastRequest = this.now();
    const controller = new AbortController();
    this.controller = controller;
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const url = new URL(this.endpoint);
      url.searchParams.set("q", query);
      url.searchParams.set("limit", "6");
      url.searchParams.set("lang", "en");
      const response = await this.fetch(url, {
        signal: controller.signal,
        credentials: "omit",
      });
      if (!response.ok) throw new Error("Search unavailable");
      const data = (await response.json()) as { features?: unknown } | null;
      features = Array.isArray(data?.features)
        ? (data.features as SearchFeature[])
        : [];
      this.cache.set(key, features);
      try {
        this.storage?.setItem(
          "nightflight-search:" + key,
          JSON.stringify({ time: Date.now(), features }),
        );
      } catch {}
      return features;
    } finally {
      clearTimeout(timeout);
      this.busy = false;
    }
  }
}

export function searchResults(features: SearchFeature[]): SearchResult[] {
  const results: SearchResult[] = [],
    seen = new Set<string>();
  for (const feature of features) {
    const properties = feature.properties || {},
      coordinates = feature.geometry?.coordinates;
    if (!Array.isArray(coordinates)) continue;
    const name = String(properties.name || properties.city || "Selected place");
    const detail = [properties.city, properties.state, properties.country]
      .filter(
        (value, index, all) =>
          value && value !== name && all.indexOf(value) === index,
      )
      .join(", ");
    const place = normalizeLocation({
      lat: coordinates[1],
      lon: coordinates[0],
      name: detail ? `${name}, ${detail}` : name,
    });
    if (!place) continue;
    const key = (name + "|" + detail).toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({
      name,
      detail: detail || `${place.lat.toFixed(4)}, ${place.lon.toFixed(4)}`,
      place,
    });
  }
  return results;
}
