// Typed builders for the test fixtures, so literals keep the narrow shapes in
// src/types.ts (tuples, "LineString", "Feature") instead of widening.
import type { Map as MapLibreMap } from "maplibre-gl";
import type {
  GeoFeature,
  LightFeature,
  LightKind,
  LightResponse,
  LngLat,
  SourceProperties,
} from "../src/types.ts";

export type LightResult = Extract<LightResponse, { error?: undefined }>;

export const lngLat = (lon: number, lat: number): LngLat => [lon, lat];

export const lineString = (
  coordinates: LngLat[],
  properties: SourceProperties,
): GeoFeature => ({
  properties,
  geometry: { type: "LineString", coordinates },
});

export const polygon = (
  coordinates: LngLat[][],
  properties: SourceProperties,
): GeoFeature => ({
  properties,
  geometry: { type: "Polygon", coordinates },
});

export const light = (
  id: string,
  kind: LightKind,
  lon: number,
  lat: number,
): LightFeature => ({
  type: "Feature",
  id,
  geometry: { type: "Point", coordinates: [lon, lat] },
  properties: { kind, color: "#ff8000", radius: 0.8, opacity: 0.5 },
});

/** A worker reply for `epoch` that changes no lights. */
export const emptyResponse = (epoch: number): LightResponse => ({
  id: 0,
  epoch,
  count: 0,
  visible: 0,
  diff: { add: [], remove: [] },
});

/** Narrows a worker reply to a success, failing the test on an error reply. */
export function succeeded(response: LightResponse): LightResult {
  if (response.error !== undefined) throw new Error(response.error);
  return response;
}

/** Hands a partial fake to code that expects a whole MapLibre map. */
export const asMap = (fake: object): MapLibreMap =>
  fake as unknown as MapLibreMap;
