// Draws the generated city lights straight from a GPU buffer as a MapLibre
// custom layer. A GeoJSON source would first re-tile every light change on
// MapLibre's workers, so lights in a newly viewed direction appeared up to
// ~1.6 s late even though the data already existed. Here every light in the
// buffer is drawn on every frame, wherever the camera points.
//
// Lights are accumulated additively and given a bloom (light-bloom.ts).
// Distant lights dim and warm as if seen through air, and twinkle a little,
// more so near the horizon. Without render-to-texture support the lights are
// drawn straight onto the map instead.
import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MapLibreMap,
} from "maplibre-gl";
import { compileProgram, uniforms } from "./gl-utils.ts";
import { LightBloom, type BloomSettings } from "./light-bloom.ts";
import { SPRITE_FLOATS, type SkyScene } from "./sky-renderer.ts";
import type { LightDiff, LightFeature, Position } from "./types.ts";

// Per kind: how far the soft near glow reaches (in core radii) and its opacity.
// The wide glow comes from the bloom.
const KINDS = {
  building: { glow: 2.6, glowOpacity: 0.2 },
  road: { glow: 2.2, glowOpacity: 0.14 },
} as const;
export const BLOOM: BloomSettings = {
  strength: 1.1,
  exposure: 1,
  // The ground's average light level at the default view in dense cities
  // (Tokyo, Paris), so that view keeps its look.
  adaptTarget: 0.03,
  adaptStrength: 0.7,
  adaptMs: 600,
};
export const SKYGLOW = 0.8;

export const FLOATS = 9; // x, y, r, g, b, radius, opacity, born (ms), seed
// New lights fade in, so a tile of extra detail arriving mid-flight brightens
// gradually instead of popping in as a visible square.
export const FADE_IN_MS = 600;
const WORLD = 1; // mercator units
const EARTH_CIRCUMFERENCE = 40075016.68557849;

const VERTEX = `#version 300 es
in vec2 a_pos;
in vec3 a_color;
in vec2 a_size;
in float a_born;
in float a_seed;
uniform mat4 u_matrix;
uniform float u_now;
uniform float u_ratio;
uniform float u_glow;
uniform vec2 u_origin;
uniform float u_metres;
uniform float u_twinkle;
out vec3 v_color;
out float v_intensity;
out float v_radius;
out float v_size;
void main() {
  gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
  // Ground distance from the aircraft; positions are mercator offsets.
  float metres = length(a_pos - u_origin) * u_metres;
  // Aerial perspective: blue scatters out first, so far lights dim and warm.
  float far = smoothstep(15000.0, 110000.0, metres);
  vec3 extinction = mix(vec3(1.0), vec3(1.0, 0.8, 0.62), far);
  float t = u_now * 0.001, s = a_seed * 6.2831853;
  float wobble = 0.6 * sin(t * (1.1 + 1.9 * a_seed) + s) +
                 0.4 * sin(t * (3.3 + 4.1 * fract(a_seed * 7.0)) + 3.0 * s);
  float twinkle = 1.0 + u_twinkle * (0.03 + 0.14 * far) * wobble;
  float fade = clamp((u_now - a_born) / ${FADE_IN_MS.toFixed(1)}, 0.0, 1.0);
  v_color = a_color * extinction;
  v_intensity = a_size.y * fade * twinkle * mix(1.0, 0.6, far);
  v_radius = a_size.x * u_ratio;
  v_size = 2.0 * v_radius * u_glow + 2.0;
  gl_PointSize = v_size;
}`;
const FRAGMENT = `#version 300 es
precision highp float; // must match the vertex shader for shared uniforms
uniform float u_glow;
uniform float u_glow_opacity;
in vec3 v_color;
in float v_intensity;
in float v_radius;
in float v_size;
out vec4 color;
void main() {
  float d = length((gl_PointCoord - 0.5) * v_size) / v_radius; // core radii
  float aa = 1.0 / max(v_radius, 0.01);
  float core = 1.0 - smoothstep(1.0 - max(0.18, aa), 1.0, d);
  float glow = u_glow_opacity * (1.0 - smoothstep(0.0, 1.0, d / u_glow));
  float alpha = v_intensity * (core + glow * (1.0 - core));
  color = vec4(v_color * alpha, alpha);
}`;

// Sky sprites (stars, aircraft, meteors) are already in CSS pixels.
const SKY_VERTEX = `#version 300 es
in vec2 a_xy;
in float a_radius;
in vec4 a_color;
uniform vec2 u_css;
uniform float u_scale;
out vec4 v_color;
out float v_radius;
out float v_size;
void main() {
  gl_Position = vec4(a_xy.x / u_css.x * 2.0 - 1.0, 1.0 - a_xy.y / u_css.y * 2.0, 0.0, 1.0);
  v_color = a_color;
  v_radius = max(a_radius * u_scale, 0.5);
  v_size = 2.0 * v_radius * 3.0 + 2.0;
  gl_PointSize = v_size;
}`;
const SKY_FRAGMENT = `#version 300 es
precision highp float;
uniform vec3 u_horizon;
uniform float u_scale;
uniform float u_buffer_height;
in vec4 v_color;
in float v_radius;
in float v_size;
out vec4 color;
void main() {
  // Nothing in the sky shows below the horizon.
  vec2 css = vec2(gl_FragCoord.x, u_buffer_height - gl_FragCoord.y) / u_scale;
  if (dot(u_horizon.xy, css) + u_horizon.z > 0.0) discard;
  float d = length((gl_PointCoord - 0.5) * v_size) / v_radius;
  float core = 1.0 - smoothstep(0.6, 1.0, d);
  float glow = 0.25 * (1.0 - smoothstep(0.0, 1.0, d / 3.0));
  float alpha = v_color.a * (core + glow * (1.0 - core));
  color = vec4(v_color.rgb * alpha, alpha);
}`;

const colorCache = new Map<string, [number, number, number]>();
function rgb(hex: string): [number, number, number] {
  let value = colorCache.get(hex);
  if (!value) {
    const n = parseInt(String(hex).slice(1, 7), 16) || 0;
    value = [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
    colorCache.set(hex, value);
  }
  return value;
}
/** Stable value in [0, 1) per light id, so each light twinkles its own way. */
function seedOf(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}
const mercatorX = (lon: number): number => (lon + 180) / 360;
const mercatorY = (lat: number): number => {
  const phi = (Math.max(-85, Math.min(85, lat)) * Math.PI) / 180;
  return (1 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / Math.PI) / 2;
};
const wrapped = (dx: number): number => dx - Math.round(dx / WORLD) * WORLD;

/** Packs lights into [buildings..., roads...] relative to `center` (mercator). */
export function packLights(
  features: Iterable<LightFeature>,
  center: readonly [number, number],
  born: ReadonlyMap<string, number> = new Map(),
): { data: Float32Array; buildings: number; roads: number } {
  const buildings: LightFeature[] = [],
    roads: LightFeature[] = [];
  for (const feature of features)
    (feature.properties.kind === "road" ? roads : buildings).push(feature);
  const data = new Float32Array((buildings.length + roads.length) * FLOATS);
  let i = 0;
  for (const feature of [...buildings, ...roads]) {
    const [lon, lat] = feature.geometry.coordinates,
      p = feature.properties,
      color = rgb(p.color);
    data[i++] = wrapped(mercatorX(lon) - center[0]); // across the date line
    data[i++] = mercatorY(lat) - center[1];
    data[i++] = color[0];
    data[i++] = color[1];
    data[i++] = color[2];
    data[i++] = p.radius;
    data[i++] = p.opacity;
    data[i++] = born.get(feature.id) ?? -1e9;
    data[i++] = seedOf(feature.id);
  }
  return { data, buildings: buildings.length, roads: roads.length };
}

function multiply(a: ArrayLike<number>, b: ArrayLike<number>): Float64Array {
  const out = new Float64Array(16);
  for (let col = 0; col < 4; col++)
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[col * 4 + k];
      out[col * 4 + row] = sum;
    }
  return out;
}

// MapLibre rebuilds the style from a snapshot after a WebGL context loss (and
// after its workers restart). Custom layers are not part of that snapshot and
// `load` does not fire again, so add the layer whenever a style finishes
// loading. The layer keeps its lights, so they return without new tile data.
export function keepLightsLayerAttached(
  map: Pick<MapLibreMap, "on" | "getLayer" | "addLayer" | "setLayoutProperty">,
  layer: CustomLayerInterface,
  {
    beforeId,
    hidden = () => false,
  }: { beforeId?: string; hidden?: () => boolean } = {},
): void {
  map.on("style.load", () => {
    if (map.getLayer(layer.id)) return;
    map.addLayer(layer, beforeId);
    if (hidden()) map.setLayoutProperty(layer.id, "visibility", "none");
  });
}

export interface LightsOptions {
  /** Bloom and skyglow; off draws the lights directly (cheaper). */
  bloom: boolean;
  twinkle: boolean;
}

export interface LightsLayer extends CustomLayerInterface {
  readonly size: number;
  /** "on", "off" (by setting) or "unavailable" (the GPU cannot do it). */
  readonly bloomState: "on" | "off" | "unavailable";
  applyDiff(diff: Partial<LightDiff>): void;
  clear(): void;
  bornAt(key: string): number | undefined;
  configure(options: Partial<LightsOptions>): void;
}

const ATTRIBUTES = ["a_pos", "a_color", "a_size", "a_born", "a_seed"] as const;
const UNIFORMS = [
  "u_matrix",
  "u_now",
  "u_ratio",
  "u_glow",
  "u_glow_opacity",
  "u_origin",
  "u_metres",
  "u_twinkle",
] as const;

const SKY_UNIFORMS = ["u_css", "u_scale", "u_horizon", "u_buffer_height"] as const;

interface GpuState {
  gl: WebGL2RenderingContext;
  program: WebGLProgram;
  buffer: WebGLBuffer;
  vao: WebGLVertexArrayObject | null;
  uniforms: Record<(typeof UNIFORMS)[number], WebGLUniformLocation | null>;
  skyProgram: WebGLProgram;
  skyBuffer: WebGLBuffer;
  skyVao: WebGLVertexArrayObject | null;
  skyUniforms: Record<(typeof SKY_UNIFORMS)[number], WebGLUniformLocation | null>;
  bloom: LightBloom | null;
}

export function createLightsLayer({
  id = "night-lights",
  now = () => performance.now(),
  origin = () => null,
  sky = () => null,
  twinkle = true,
  bloom: bloomEnabled = true,
}: {
  id?: string;
  now?: () => number;
  /** The aircraft position; lights dim and twinkle with distance from it. */
  origin?: () => Position | null;
  /** Stars, aircraft and meteors to draw above the horizon. */
  sky?: () => SkyScene | null;
  twinkle?: boolean;
  bloom?: boolean;
} = {}): LightsLayer {
  const features = new Map<string, LightFeature>(),
    born = new Map<string, number>();
  let map: MapLibreMap | null = null,
    gpu: GpuState | null = null,
    packed: ReturnType<typeof packLights> | null = null,
    center: [number, number] = [0.5, 0.5],
    dirty = true,
    fadingUntil = 0,
    lastRender = -1,
    adaptUntil = 0,
    lastMatrix: Float32Array | null = null;
  const epochStart = now();
  const changed = () => {
    dirty = true;
    map?.triggerRepaint();
  };

  function release(gl: WebGL2RenderingContext): void {
    if (!gpu) return;
    // isProgram/isBuffer are false for objects that died with a lost context.
    if (gl.isProgram(gpu.program)) gl.deleteProgram(gpu.program);
    if (gl.isBuffer(gpu.buffer)) gl.deleteBuffer(gpu.buffer);
    if (gpu.vao) gl.deleteVertexArray(gpu.vao);
    if (gl.isProgram(gpu.skyProgram)) gl.deleteProgram(gpu.skyProgram);
    if (gl.isBuffer(gpu.skyBuffer)) gl.deleteBuffer(gpu.skyBuffer);
    if (gpu.skyVao) gl.deleteVertexArray(gpu.skyVao);
    gpu.bloom?.dispose();
    gpu = null;
  }

  function drawSky(state: GpuState, scene: SkyScene | null): void {
    if (!scene || !scene.count || !scene.width) return;
    const { gl, skyUniforms: u } = state,
      scale = gl.drawingBufferWidth / scene.width;
    gl.useProgram(state.skyProgram);
    gl.bindVertexArray(state.skyVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, state.skyBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      scene.sprites.subarray(0, scene.count * SPRITE_FLOATS),
      gl.STREAM_DRAW,
    );
    gl.uniform2f(u.u_css, scene.width, scene.height);
    gl.uniform1f(u.u_scale, scale);
    gl.uniform1f(u.u_buffer_height, gl.drawingBufferHeight);
    gl.uniform3f(u.u_horizon, ...scene.horizon);
    gl.drawArrays(gl.POINTS, 0, scene.count);
    gl.bindVertexArray(null);
  }

  function drawPoints(state: GpuState, matrix: Float32Array, t: number): void {
    const { gl, uniforms: u } = state;
    if (!packed) return;
    gl.useProgram(state.program);
    gl.bindVertexArray(state.vao);
    gl.uniformMatrix4fv(u.u_matrix, false, matrix);
    gl.uniform1f(u.u_now, t);
    gl.uniform1f(u.u_ratio, map!.getPixelRatio());
    gl.uniform1f(u.u_twinkle, twinkle ? 1 : 0);
    const position = origin(),
      lat = position?.lat ?? 0;
    gl.uniform2f(
      u.u_origin,
      position ? wrapped(mercatorX(position.lon) - center[0]) : 0,
      position ? mercatorY(position.lat) - center[1] : 0,
    );
    gl.uniform1f(
      u.u_metres,
      EARTH_CIRCUMFERENCE * Math.cos((lat * Math.PI) / 180),
    );
    for (const kind of ["building", "road"] as const) {
      const first = kind === "road" ? packed.buildings : 0,
        count = kind === "road" ? packed.roads : packed.buildings;
      if (!count) continue;
      gl.uniform1f(u.u_glow, KINDS[kind].glow);
      gl.uniform1f(u.u_glow_opacity, KINDS[kind].glowOpacity);
      gl.drawArrays(gl.POINTS, first, count);
    }
    gl.bindVertexArray(null);
  }

  return {
    id,
    type: "custom",
    renderingMode: "2d",
    get size() {
      return features.size;
    },
    applyDiff({ add = [], remove = [] }) {
      // Times are kept relative to the layer's start so float32 stays exact.
      const t = now() - epochStart;
      for (const key of remove) {
        features.delete(key);
        born.delete(key);
      }
      for (const feature of add) {
        // A light whose id already exists is an update, not a new light.
        if (!features.has(feature.id)) born.set(feature.id, t);
        features.set(feature.id, feature);
      }
      if (add.length) fadingUntil = t + FADE_IN_MS;
      if (add.length || remove.length) changed();
    },
    clear() {
      features.clear();
      born.clear();
      changed();
    },
    bornAt(key) {
      return born.get(key);
    },
    get bloomState() {
      if (!bloomEnabled) return "off";
      return gpu && !gpu.bloom ? "unavailable" : "on";
    },
    configure(options) {
      if (options.twinkle !== undefined) twinkle = options.twinkle;
      if (options.bloom !== undefined) bloomEnabled = options.bloom;
      map?.triggerRepaint();
    },
    onAdd(m, gl) {
      map = m;
      // A re-add may follow a teardown that never called onRemove.
      release(gl);
      const program = compileProgram(gl, VERTEX, FRAGMENT),
        buffer = gl.createBuffer(),
        vao = gl.createVertexArray();
      if (!buffer) throw new Error("Could not create a buffer");
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      const stride = FLOATS * 4,
        layout: Record<(typeof ATTRIBUTES)[number], [size: number, offset: number]> = {
          a_pos: [2, 0],
          a_color: [3, 8],
          a_size: [2, 20],
          a_born: [1, 28],
          a_seed: [1, 32],
        };
      for (const name of ATTRIBUTES) {
        const location = gl.getAttribLocation(program, name);
        if (location < 0) continue;
        gl.enableVertexAttribArray(location);
        gl.vertexAttribPointer(location, layout[name][0], gl.FLOAT, false, stride, layout[name][1]);
      }
      gl.bindVertexArray(null);
      const skyProgram = compileProgram(gl, SKY_VERTEX, SKY_FRAGMENT),
        skyBuffer = gl.createBuffer(),
        skyVao = gl.createVertexArray();
      if (!skyBuffer) throw new Error("Could not create a buffer");
      gl.bindVertexArray(skyVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, skyBuffer);
      const skyStride = SPRITE_FLOATS * 4;
      for (const [name, size, offset] of [
        ["a_xy", 2, 0],
        ["a_radius", 1, 8],
        ["a_color", 4, 12],
      ] as const) {
        const location = gl.getAttribLocation(skyProgram, name);
        if (location < 0) continue;
        gl.enableVertexAttribArray(location);
        gl.vertexAttribPointer(location, size, gl.FLOAT, false, skyStride, offset);
      }
      gl.bindVertexArray(null);
      let bloom: LightBloom | null = null;
      try {
        bloom = new LightBloom(gl);
      } catch (error) {
        console.warn("Light bloom unavailable; drawing lights directly.", error);
      }
      gpu = {
        gl,
        program,
        buffer,
        vao,
        uniforms: uniforms(gl, program, UNIFORMS),
        skyProgram,
        skyBuffer,
        skyVao,
        skyUniforms: uniforms(gl, skyProgram, SKY_UNIFORMS),
        bloom,
      };
      dirty = true;
    },
    onRemove(_m, gl) {
      release(gl);
      map = null;
    },
    render(gl: WebGL2RenderingContext, options: CustomRenderMethodInput) {
      if (!gpu || !map) return;
      const mapCenter = map.getCenter();
      if (dirty) {
        // Positions are stored relative to a nearby centre so float32 keeps
        // metre-level precision; the matrix adds the centre back in float64.
        center = [mercatorX(mapCenter.lng), mercatorY(mapCenter.lat)];
        packed = packLights(features.values(), center, born);
        gl.bindBuffer(gl.ARRAY_BUFFER, gpu.buffer);
        gl.bufferData(gl.ARRAY_BUFFER, packed.data, gl.DYNAMIC_DRAW);
        dirty = false;
      }
      const scene = sky(),
        hasLights = !!packed && packed.data.length > 0;
      if (!hasLights && !scene?.count) return;
      const worldSize =
        (map as { transform?: { worldSize?: number } }).transform?.worldSize ??
        512 * 2 ** map.getZoom();
      let cx = center[0];
      cx += Math.round(mercatorX(mapCenter.lng) - cx); // same world copy as the camera
      const model = new Float64Array([
        worldSize, 0, 0, 0,
        0, worldSize, 0, 0,
        0, 0, 1, 0,
        cx * worldSize, center[1] * worldSize, 0, 1,
      ]);
      const matrix = Float32Array.from(
          multiply(options.modelViewProjectionMatrix, model),
        ),
        t = now() - epochStart,
        state = gpu,
        draw = () => {
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE); // light adds up
          drawSky(state, scene);
          if (hasLights) drawPoints(state, matrix, t);
        };
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.STENCIL_TEST);
      gl.disable(gl.SCISSOR_TEST);
      const bloom = bloomEnabled ? gpu.bloom : null;
      if (bloom) {
        const output = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null,
          viewport = gl.getParameter(gl.VIEWPORT) as Int32Array;
        try {
          bloom.begin(gl.drawingBufferWidth, gl.drawingBufferHeight);
          draw();
          bloom.finish(
            output,
            viewport,
            BLOOM,
            scene && { ...scene, strength: SKYGLOW },
            lastRender < 0 ? 16 : t - lastRender,
          );
        } catch (error) {
          // E.g. out of GPU memory for the targets: keep drawing, without bloom.
          console.warn("Light bloom failed; drawing lights directly.", error);
          bloom.dispose();
          gpu.bloom = null;
          gl.bindFramebuffer(gl.FRAMEBUFFER, output);
          gl.viewport(viewport[0], viewport[1], viewport[2], viewport[3]);
          draw();
        }
      } else draw();
      // Keep drawing while lights fade in or the eyes adapt to a new view,
      // even when paused.
      if (!lastMatrix || lastMatrix.some((v, i) => v !== matrix[i]))
        adaptUntil = t + BLOOM.adaptMs * 4;
      lastMatrix = matrix;
      lastRender = t;
      if (t < fadingUntil || (bloom && t < adaptUntil)) map.triggerRepaint();
    },
  };
}
