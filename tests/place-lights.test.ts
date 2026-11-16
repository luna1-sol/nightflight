import test from "node:test";
import assert from "node:assert/strict";
import { insidePolygon, createPlaceLights } from "../src/place-lights.ts";
import type { GeoFeature, LngLat } from "../src/types.ts";
import { polygon } from "./fixtures.ts";
const outer: LngLat[] = [
  [139, 35],
  [139.04, 35],
  [139.04, 35.04],
  [139, 35.04],
  [139, 35],
];
const hole: LngLat[] = [
  [139.015, 35.015],
  [139.025, 35.015],
  [139.025, 35.025],
  [139.015, 35.025],
  [139.015, 35.015],
];
const area: GeoFeature & { type: "Feature" } = {
  type: "Feature",
  properties: { class: "residential" },
  geometry: { type: "Polygon", coordinates: [outer, hole] },
};
const options = { center: [139.02, 35.02], maxPoints: 200 } satisfies {
  center: LngLat;
  maxPoints: number;
};
test("neighborhood light points stay within mapped polygons and out of holes", () => {
  const result = createPlaceLights([area], options);
  assert.ok(result.features.length > 20);
  for (const feature of result.features)
    assert.ok(insidePolygon(feature.geometry.coordinates, [outer, hole]));
});
test("light generation is stable, capped, and deduplicates source tile overlaps", () => {
  const a = createPlaceLights([area], options),
    b = createPlaceLights([area], options),
    duplicates = createPlaceLights([area, area], options);
  assert.deepEqual(a, b);
  assert.deepEqual(a, duplicates);
  assert.ok(a.features.length <= 200);
  assert.equal(
    createPlaceLights([area], { ...options, maxPoints: 10 }).features.length,
    10,
  );
});
test("building lights vary in color, radius, and brightness without animation", () => {
  const features = createPlaceLights([area], options).features;
  assert.ok(new Set(features.map((f) => f.properties.color)).size >= 4);
  assert.ok(new Set(features.map((f) => f.properties.radius)).size > 20);
  assert.ok(new Set(features.map((f) => f.properties.opacity)).size > 20);
  for (const { properties: p } of features) {
    assert.ok(p.radius > 0 && p.radius < 2);
    assert.ok(p.opacity >= 0 && p.opacity <= 1);
  }
});
test("empty, non-polygon, and faraway data produce no local light points", () => {
  assert.equal(createPlaceLights([]).features.length, 0);
  assert.equal(
    createPlaceLights(
      [{ geometry: { type: "Point", coordinates: [139, 35] } }],
      options,
    ).features.length,
    0,
  );
  assert.equal(
    createPlaceLights([area], { center: [-74, 40] }).features.length,
    0,
  );
});
test("tile clipping never changes which lights exist (no tile-shaped density edges)", () => {
  // The same neighbourhood, whole and cut into the four pieces vector tiles
  // would deliver, must light up identically: density depends on distance only.
  const square = (x0: number, y0: number, x1: number, y1: number) =>
    polygon([[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]], {
      class: "residential",
    });
  for (const center of [[139.02, 35.02], [139.3, 35.02]] satisfies LngLat[]) {
    const ids = (areas: GeoFeature[]) =>
      createPlaceLights(areas, { center, maxPoints: 1e6 })
        .features.map((f) => f.id)
        .sort();
    const whole = ids([square(139, 35, 139.08, 35.08)]),
      pieces = ids([
        square(139, 35, 139.04, 35.04),
        square(139.04, 35, 139.08, 35.04),
        square(139, 35.04, 139.04, 35.08),
        square(139.04, 35.04, 139.08, 35.08),
      ]);
    assert.ok(whole.length > 20);
    assert.deepEqual(pieces, whole);
  }
});
test("an over-budget city is thinned evenly, not cut off in a circle", () => {
  // A city of solid residential land around the aircraft, like Paris: far
  // more candidates than the budget allows.
  const center: LngLat = [2.35, 48.86],
    city = polygon(
      [[[1.75, 48.46], [2.95, 48.46], [2.95, 49.26], [1.75, 49.26], [1.75, 48.46]]],
      { class: "residential" },
    );
  const cos = Math.cos((center[1] * Math.PI) / 180),
    km = (c: LngLat) =>
      Math.hypot((c[0] - center[0]) * cos, c[1] - center[1]) * 111.195;
  const all = createPlaceLights([city], { center, maxPoints: 1e9 }).features,
    budget = Math.round(all.length / 3),
    kept = createPlaceLights([city], { center, maxPoints: budget }).features;
  assert.equal(kept.length, budget);
  const count = (features: typeof all, from: number, to: number) =>
    features.filter((f) => {
      const d = km(f.geometry.coordinates);
      return d >= from && d < to;
    }).length;
  // The density is capped at one level: the sparsest, farthest lights all
  // stay, and the share kept only grows with distance, never dropping to
  // zero at some radius as a nearest-first cut did.
  assert.ok(count(all, 55, 65) > 0);
  assert.equal(count(kept, 55, 65), count(all, 55, 65));
  const shares = [0, 10, 20, 30, 40, 50, 55].map(
    (from, i, edges) => count(kept, from, edges[i + 1] ?? 65) / count(all, from, edges[i + 1] ?? 65),
  );
  assert.ok(shares[0] > 0.05 && shares[0] < 0.6, `near field kept ${shares[0]}`);
  for (let i = 1; i < shares.length; i++)
    assert.ok(shares[i] >= shares[i - 1] - 0.02, `share by distance ${shares.map((v) => v.toFixed(2))}`);
  const farthest = (features: typeof all) =>
    features.reduce((max, f) => Math.max(max, km(f.geometry.coordinates)), 0);
  assert.ok(farthest(kept) > farthest(all) - 1, "no circular cut-off");
  // Stable: the same input always keeps the same lights.
  assert.deepEqual(
    createPlaceLights([city], { center, maxPoints: budget }).features.map((f) => f.id),
    kept.map((f) => f.id),
  );
});
