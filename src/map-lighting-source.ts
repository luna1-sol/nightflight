// The only adapter coupled to the pinned MapLibre tile representation.
// Keep geometry as transferable MVT coordinates until it reaches the worker.
// Minor roads are faded out by 13 km (lights-worker.ts), so only nearby
// tiles need them; there they are taken whole instead of thinned per tile,
// which used to make busy tiles sparser than quiet neighbours.
import type { Map as MapLibreMap } from "maplibre-gl";
import type {
  Geometry,
  LngLat,
  RawFeature,
  SourceProperties,
  TileCoord,
} from "./types.ts";

const MAJOR_ROADS = ["motorway", "trunk", "primary", "secondary", "tertiary"],
  MINOR_ROADS = ["minor", "service"],
  MINOR_RANGE = 15000;

// The parts of MapLibre's internals (pinned at 6.16.0) this adapter reads.
// None of this is public API: re-check it whenever MapLibre is upgraded.
interface VectorTileFeature {
  type: number;
  extent: number;
  loadGeometry(): { x: number; y: number }[][];
}
interface SourceFeature {
  properties?: Record<string, unknown> | null;
  geometry?: unknown;
  tile?: TileCoord;
  _vectorTileFeature?: VectorTileFeature;
  _x?: number;
  _y?: number;
  _z?: number;
}
interface InternalTile {
  tileID?: { canonical?: TileCoord };
  querySourceFeatures(result: SourceFeature[], params: object): void;
}
interface InternalStyle {
  tileManagers?: Record<
    string,
    | {
        getRenderableIds?(): string[];
        getTileByID(id: string): InternalTile | undefined;
      }
    | undefined
  >;
  _globalState?: unknown;
  projection: { worldCoordinateHelper: unknown };
}

export interface LightingGeometry {
  areas: RawFeature[];
  roads: RawFeature[];
  tiles: TileCoord[];
  transfers: ArrayBuffer[];
}

export function tileDistance(canonical: TileCoord, origin: LngLat): number {
  const n = 2 ** canonical.z,
    lat = (y: number) =>
      (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI,
    width = 360 / n,
    west = (canonical.x / n) * 360 - 180,
    north = lat(canonical.y),
    south = lat(canonical.y + 1),
    // Degrees east of the tile's west edge, so the nearest world copy counts
    // when the tile and the aircraft are on opposite sides of the date line.
    offset = (((origin[0] - west) % 360) + 360) % 360,
    dx = offset <= width ? 0 : Math.min(offset - width, 360 - offset),
    cy = Math.max(south, Math.min(north, origin[1]));
  return (
    Math.hypot(dx * Math.cos((origin[1] * Math.PI) / 180), cy - origin[1]) *
    111195
  );
}

export async function collectLightingGeometry(
  map: MapLibreMap,
  {
    isCancelled = () => false,
    origin = null,
  }: { isCancelled?: () => boolean; origin?: LngLat | null } = {},
): Promise<LightingGeometry | null> {
  const areas: RawFeature[] = [],
    roads: RawFeature[] = [],
    tiles: TileCoord[] = [],
    transfers: ArrayBuffer[] = [];
  const yieldUI = () => new Promise((resolve) => setTimeout(resolve, 0));
  const plain = (feature: SourceFeature, building = false): RawFeature => {
    const properties: SourceProperties = {
        class: feature.properties?.class as string | undefined,
        brunnel: feature.properties?.brunnel as string | undefined,
        lightBuilding: building,
      },
      vector = feature._vectorTileFeature,
      tile = feature.tile || {
        x: feature._x ?? 0,
        y: feature._y ?? 0,
        z: feature._z ?? 0,
      };
    if (!vector)
      return { geometry: feature.geometry as Geometry, tile, properties };
    const rings = vector.loadGeometry(),
      ringLengths = rings.map((r) => r.length),
      coordinates = new Float32Array(
        ringLengths.reduce((sum, n) => sum + n, 0) * 2,
      );
    let i = 0;
    for (const ring of rings)
      for (const p of ring) {
        coordinates[i++] = p.x;
        coordinates[i++] = p.y;
      }
    transfers.push(coordinates.buffer);
    return {
      tile,
      properties,
      type: vector.type,
      extent: vector.extent,
      ringLengths,
      coordinates,
    };
  };

  // MapLibre is pinned in package.json. Its per-tile adapter lets us yield
  // between tiles instead of running one large, synchronous querySourceFeatures scan.
  const style = map.style as unknown as InternalStyle | undefined,
    manager = style?.tileManagers?.world,
    ids = manager?.getRenderableIds?.(),
    seen = new Set<string>();
  let deadline = performance.now() + 3;
  if (style && manager && ids) {
    // Generous: dropping a clipped polygon piece leaves a tile-shaped hole.
    const areaQuota = Math.max(40, Math.ceil(4000 / Math.max(1, ids.length)));
    for (const id of ids) {
      const tile = manager.getTileByID(id),
        canonical = tile?.tileID?.canonical;
      if (!tile || !canonical) continue;
      const key = canonical.z + ":" + canonical.x + ":" + canonical.y;
      if (seen.has(key)) continue;
      seen.add(key);
      tiles.push({ x: canonical.x, y: canonical.y, z: canonical.z });
      const near = !origin || tileDistance(canonical, origin) < MINOR_RANGE;
      const passes: [string, string[], RawFeature[], number][] = [
        [
          "landuse",
          ["residential", "commercial", "retail", "industrial"],
          areas,
          areaQuota,
        ],
        ["transportation", MAJOR_ROADS, roads, 4000],
        ...(near
          ? [["transportation", MINOR_ROADS, roads, 6000] as [
              string,
              string[],
              RawFeature[],
              number,
            ]]
          : []),
      ];
      for (const [layer, allowed, output, quota] of passes) {
        const features: SourceFeature[] = [];
        tile.querySourceFeatures(features, {
          sourceLayer: layer,
          filter: ["in", "class", ...allowed],
          globalState: style._globalState,
          worldCoordinateHelper: style.projection.worldCoordinateHelper,
        });
        const stride = Math.max(1, Math.ceil(features.length / quota));
        for (let i = 0; i < features.length; i += stride) {
          output.push(plain(features[i]));
          if (performance.now() > deadline) {
            await yieldUI();
            deadline = performance.now() + 3;
            if (isCancelled()) return null;
          }
        }
        if (performance.now() > deadline) {
          await yieldUI();
          deadline = performance.now() + 3;
        }
      }
    }
  } else {
    // Compatibility fallback if the pinned renderer is replaced in the future.
    for (const [layer, output] of [
      ["landuse", areas],
      ["transportation", roads],
    ] as const) {
      const features = map.querySourceFeatures("world", {
        sourceLayer: layer,
      }) as unknown as SourceFeature[];
      const stride = Math.max(1, Math.ceil(features.length / 1500));
      for (let i = 0; i < features.length; i += stride) {
        output.push(plain(features[i]));
        if (performance.now() > deadline) {
          await yieldUI();
          deadline = performance.now() + 3;
        }
      }
    }
  }
  if (isCancelled()) return null;

  return { areas, roads, tiles, transfers };
}
