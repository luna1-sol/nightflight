// Shared shapes passed between the app, the tile adapter and the lighting worker.

export type LngLat = [lon: number, lat: number];
export type Point2 = [x: number, y: number];

export interface Position {
  lat: number;
  lon: number;
}

export interface FlightLocation extends Position {
  heading: number;
  name: string;
}

/** Snapshot of the aircraft and camera, read by the sky and lighting code. */
export interface Frame {
  position: Position;
  heading: number;
  time: number;
  bank: number;
  tilt: number;
  yaw: number;
  width: number;
  height: number;
}

/** Camera description the worker uses to decide which lights are on screen. */
export interface LightView {
  position: Position;
  width: number;
  height: number;
  tilt: number;
  bearing: number;
  roll?: number;
}

export interface TileCoord {
  x: number;
  y: number;
  z: number;
}

export type Geometry =
  | { type: "Point"; coordinates: LngLat }
  | { type: "MultiPoint"; coordinates: LngLat[] }
  | { type: "LineString"; coordinates: LngLat[] }
  | { type: "MultiLineString"; coordinates: LngLat[][] }
  | { type: "Polygon"; coordinates: LngLat[][] }
  | { type: "MultiPolygon"; coordinates: LngLat[][][] };

export interface SourceProperties {
  class?: string;
  brunnel?: string;
  lightBuilding?: boolean;
}

/** A tile feature with geographic coordinates. */
export interface GeoFeature {
  tile?: TileCoord;
  properties?: SourceProperties;
  geometry: Geometry;
  sourceLayer?: string;
}

/** A tile feature still in raw MVT coordinates, as transferred to the worker. */
export interface PackedFeature {
  tile: TileCoord;
  properties: SourceProperties;
  type: number;
  extent?: number;
  ringLengths: number[];
  coordinates: ArrayLike<number>;
  geometry?: undefined;
}

export type RawFeature = GeoFeature | PackedFeature;

export type LightKind = "road" | "building";

export interface LightProperties {
  kind: LightKind;
  color: string;
  radius: number;
  opacity: number;
}

export interface LightFeature {
  type: "Feature";
  id: string;
  geometry: { type: "Point"; coordinates: LngLat };
  properties: LightProperties;
}

/** A light plus the bookkeeping fields the worker keeps but never sends. */
export interface CachedLight extends LightFeature {
  _zoom?: number;
  _cls?: string;
  _h?: number;
  _rank?: number;
  _distance?: number;
  _visible?: boolean;
}

export interface LightDiff {
  add: LightFeature[];
  remove: string[];
}

export interface LightRequest {
  id: number;
  epoch: number;
  areas: RawFeature[];
  roads: RawFeature[];
  tiles?: TileCoord[];
  center: LngLat;
  focus?: LngLat;
  view?: LightView | null;
  visibleBudget?: number;
  maxPoints?: number;
}

export type LightResponse =
  | {
      id: number;
      epoch: number;
      count: number;
      visible: number;
      diff: LightDiff;
      error?: undefined;
    }
  | { id: number; epoch: number; error: string; diff?: undefined };
