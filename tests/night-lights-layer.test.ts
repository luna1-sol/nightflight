import test from "node:test";
import assert from "node:assert/strict";
import {
  packLights,
  createLightsLayer,
  keepLightsLayerAttached,
  FLOATS,
} from "../src/night-lights-layer.ts";
import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
} from "maplibre-gl";
import { asMap, light } from "./fixtures.ts";

test("packs buildings before roads, relative to the centre, across the date line", () => {
  const center: [number, number] = [1, 0.5]; // mercator x = 1 is longitude 180
  const packed = packLights(
    [light("r", "road", -179.9, 0), light("b", "building", 179.9, 0)],
    center,
  );
  assert.equal(packed.buildings, 1);
  assert.equal(packed.roads, 1);
  const [bx, by, r, g, b, radius, opacity] = packed.data.slice(0, 7);
  assert.ok(bx < 0 && bx > -0.001, "179.9° sits just west of the centre");
  assert.ok(Math.abs(by) < 1e-6);
  assert.deepEqual([r, g, b].map((v) => Math.round(v * 255)), [255, 128, 0]);
  assert.ok(Math.abs(radius - 0.8) < 1e-6 && Math.abs(opacity - 0.5) < 1e-6);
  const rx = packed.data[FLOATS];
  assert.ok(rx > 0 && rx < 0.001, "-179.9° wraps to just east, not a world away");
});

test("the layer applies diffs and clears without a GPU", () => {
  const layer = createLightsLayer();
  assert.equal(layer.type, "custom");
  layer.applyDiff({ add: [light("a", "road", 0, 0), light("b", "building", 1, 1)] });
  assert.equal(layer.size, 2);
  layer.applyDiff({ add: [light("a", "road", 0.1, 0)], remove: ["b"] });
  assert.equal(layer.size, 1);
  layer.clear();
  assert.equal(layer.size, 0);
});

test("new lights fade in from their first appearance; updates keep their age", () => {
  let clock = 1000;
  const layer = createLightsLayer({ now: () => clock });
  clock = 1500;
  layer.applyDiff({ add: [light("a", "road", 0, 0)] });
  assert.equal(layer.bornAt("a"), 500);
  clock = 2500;
  layer.applyDiff({ add: [light("a", "road", 0.001, 0), light("b", "road", 1, 1)] });
  assert.equal(layer.bornAt("a"), 500, "an updated light does not fade in again");
  assert.equal(layer.bornAt("b"), 1500);
  const packed = packLights([light("a", "road", 0, 0)], [0.5, 0.5], new Map([["a", 500]]));
  assert.equal(packed.data[7], 500);
});

interface Handle {
  id: number;
}
interface FakeGl {
  uploads: number[];
  draws: number;
  alive: Set<Handle>;
}
// Hands the fake to code that expects a real WebGL2 context.
const asGl = (gl: FakeGl) => gl as unknown as WebGL2RenderingContext;

function fakeGl(): FakeGl {
  let next = 1;
  const alive = new Set<Handle>(),
    make = (): Handle => {
      const handle = { id: next++ };
      alive.add(handle);
      return handle;
    },
    gl = {
      uploads: [] as number[],
      draws: 0,
      alive,
      createProgram: make,
      createBuffer: make,
      createShader: make,
      deleteProgram: (h: Handle) => alive.delete(h),
      deleteBuffer: (h: Handle) => alive.delete(h),
      deleteShader: (h: Handle) => alive.delete(h),
      isProgram: (h: Handle) => alive.has(h),
      isBuffer: (h: Handle) => alive.has(h),
      getShaderParameter: () => true,
      getProgramParameter: () => true,
      getAttribLocation: () => 0,
      getUniformLocation: () => ({}),
      bufferData: (_: unknown, data: ArrayLike<number>) => gl.uploads.push(data.length),
      drawArrays: () => gl.draws++,
    };
  return new Proxy(gl, {
    get: (target, key) =>
      key in target ? target[key as keyof typeof target] : () => {},
  });
}
// Enough of a MapLibre map to replay what a context restore does to a style.
interface FakeMap {
  layers: Map<string, CustomLayerInterface>;
  visibility: Record<string, unknown>;
  beforeId?: string;
  on(event: string, fn: () => void): FakeMap;
  fire(event: string): void;
  getLayer(id: string): CustomLayerInterface | undefined;
  addLayer(layer: CustomLayerInterface, beforeId?: string): void;
  setLayoutProperty(id: string, key: string, value: unknown): void;
  getCenter(): { lng: number; lat: number };
  getPixelRatio(): number;
  getZoom(): number;
  triggerRepaint(): void;
}
function fakeMap(gl: FakeGl): FakeMap {
  const handlers: Record<string, (() => void)[]> = {},
    map: FakeMap = {
      layers: new Map(),
      visibility: {},
      on: (event, fn) => ((handlers[event] ??= []).push(fn), map),
      fire: (event) => (handlers[event] ?? []).forEach((fn) => fn()),
      getLayer: (id) => map.layers.get(id),
      addLayer: (layer, beforeId) => {
        map.beforeId = beforeId;
        map.layers.set(layer.id, layer);
        layer.onAdd!(asMap(map), asGl(gl));
      },
      setLayoutProperty: (id, key, value) => (map.visibility[id] = value),
      getCenter: () => ({ lng: 0, lat: 0 }),
      getPixelRatio: () => 1,
      getZoom: () => 11,
      triggerRepaint: () => {},
    };
  return map;
}
const renderInput = {
  modelViewProjectionMatrix: new Float64Array(16),
} as unknown as CustomRenderMethodInput;

test("the layer returns after a WebGL context restore, with its lights", () => {
  const gl = fakeGl(),
    map = fakeMap(gl),
    layer = createLightsLayer();
  keepLightsLayerAttached(asMap(map), layer, { beforeId: "overview-borders" });
  assert.equal(map.getLayer(layer.id), undefined, "waits for the style");

  map.fire("style.load");
  assert.equal(map.getLayer(layer.id), layer);
  assert.equal(map.beforeId, "overview-borders");
  layer.applyDiff({ add: [light("a", "road", 0, 0), light("b", "building", 1, 1)] });
  layer.render(asGl(gl), renderInput);
  assert.equal(gl.uploads.length, 1);

  // Context lost and restored: the rebuilt style has no custom layers, the
  // old GPU objects are gone, and `load` does not fire again.
  map.layers.clear();
  gl.alive.clear();
  gl.draws = 0;
  map.fire("webglcontextrestored");
  assert.equal(map.getLayer(layer.id), undefined, "the style is not ready yet");
  map.fire("style.load");
  assert.equal(map.getLayer(layer.id), layer, "added back once the style loads");
  assert.equal(layer.size, 2, "lights survive without new tile data");

  layer.render(asGl(gl), renderInput);
  assert.equal(gl.uploads.length, 2, "lights are re-uploaded to the new context");
  assert.equal(gl.uploads[1], 2 * FLOATS);
  assert.ok(gl.draws > 0, "and drawn");
});

test("re-adding does not duplicate the layer, leak GPU objects, or show it mid-pick", () => {
  const gl = fakeGl(),
    map = fakeMap(gl),
    layer = createLightsLayer();
  let picking = false;
  keepLightsLayerAttached(asMap(map), layer, { hidden: () => picking });
  map.fire("style.load");
  assert.equal(map.visibility[layer.id], undefined);
  const live = gl.alive.size;

  let added = 0;
  const addLayer = map.addLayer;
  map.addLayer = (...args) => (added++, addLayer(...args));
  map.fire("style.load");
  assert.equal(added, 0, "already attached");

  // Worker restart: the style is rebuilt but the GL context stays alive.
  map.layers.clear();
  picking = true;
  map.fire("style.load");
  assert.equal(added, 1);
  assert.equal(gl.alive.size, live, "the previous program and buffer are freed");
  assert.equal(map.visibility[layer.id], "none", "stays hidden while picking");
});
