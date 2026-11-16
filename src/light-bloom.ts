// Bloom for the city lights: they are drawn additively into an offscreen
// (half-float where supported) texture, blurred through a chain of smaller
// textures (dual-filter Kawase), and composited onto the map with a soft
// tone curve. Overlapping lights add up like real light instead of stacking
// opaque discs, and dense districts glow without clipping to flat white.
import { compileProgram, FULLSCREEN_VERTEX, uniforms } from "./gl-utils.ts";

const LEVELS = 5; // 1/2 … 1/32 of the screen

const DOWN = `#version 300 es
precision mediump float;
uniform sampler2D u_src;
uniform vec2 u_texel;
in vec2 v_uv;
out vec4 color;
void main() {
  vec4 sum = texture(u_src, v_uv) * 4.0;
  sum += texture(u_src, v_uv - u_texel);
  sum += texture(u_src, v_uv + u_texel);
  sum += texture(u_src, v_uv + vec2(u_texel.x, -u_texel.y));
  sum += texture(u_src, v_uv - vec2(u_texel.x, -u_texel.y));
  color = sum / 8.0;
}`;

const UP = `#version 300 es
precision mediump float;
uniform sampler2D u_src;
uniform vec2 u_texel;
uniform float u_weight;
in vec2 v_uv;
out vec4 color;
void main() {
  vec2 h = u_texel;
  vec4 sum = texture(u_src, v_uv + vec2(-2.0 * h.x, 0.0));
  sum += texture(u_src, v_uv + vec2(-h.x, h.y)) * 2.0;
  sum += texture(u_src, v_uv + vec2(0.0, 2.0 * h.y));
  sum += texture(u_src, v_uv + vec2(h.x, h.y)) * 2.0;
  sum += texture(u_src, v_uv + vec2(2.0 * h.x, 0.0));
  sum += texture(u_src, v_uv + vec2(h.x, -h.y)) * 2.0;
  sum += texture(u_src, v_uv + vec2(0.0, -2.0 * h.y));
  sum += texture(u_src, v_uv + vec2(-h.x, -h.y)) * 2.0;
  color = sum / 12.0 * u_weight;
}`;

// Eye adaptation: the average brightness of the lights (from the smallest
// blur level), eased over time into a 1×1 texture the composite reads.
const ADAPT = `#version 300 es
precision highp float;
uniform sampler2D u_src;
uniform sampler2D u_prev;
uniform float u_blend;
uniform vec3 u_horizon;   // A·x + B·y + C <= 0 is sky (CSS px); all zero = no sky
uniform vec2 u_css;
in vec2 v_uv;
out vec4 color;
void main() {
  // Only the ground counts: the black sky would make a view with a bright
  // horizon look dark on average and be brightened instead.
  float sum = 0.0, count = 0.0;
  for (int y = 0; y < 8; y++)
    for (int x = 0; x < 12; x++) {
      vec2 uv = (vec2(float(x), float(y)) + 0.5) / vec2(12.0, 8.0);
      vec2 css = vec2(uv.x, 1.0 - uv.y) * u_css;
      if (dot(u_horizon.xy, css) + u_horizon.z < 0.0) continue;
      sum += dot(texture(u_src, uv).rgb, vec3(0.2126, 0.7152, 0.0722));
      count += 1.0;
    }
  float before = texture(u_prev, vec2(0.5)).r;
  if (count < 1.0) {
    color = vec4(before, 0.0, 0.0, 1.0); // looking at the sky: keep adapting to the last ground
    return;
  }
  float now = sum / count;
  color = vec4(u_blend >= 1.0 ? now : mix(before, now, u_blend), 0.0, 0.0, 1.0);
}`;

const COMPOSITE = `#version 300 es
precision highp float;
uniform sampler2D u_light;
uniform sampler2D u_bloom;
uniform sampler2D u_wide;
uniform float u_strength;
uniform float u_exposure;
uniform vec3 u_horizon;   // A·x + B·y + C <= 0 is sky (CSS px, y down)
uniform vec2 u_css;       // viewport size in CSS px
uniform float u_glow;     // skyglow strength (0 = off)
uniform float u_glow_height;
uniform sampler2D u_adapted;
uniform vec3 u_auto;       // target brightness, strength (0 = off), unused
in vec2 v_uv;
out vec4 color;
// Linear below the knee, so single lights keep their designed brightness;
// above it, brightness rolls off smoothly instead of clipping.
vec3 knee(vec3 c) {
  const float k = 0.72;
  vec3 over = max(c - k, 0.0);
  return min(c, vec3(k)) + (1.0 - k) * (1.0 - exp(-over / (1.0 - k)));
}
float noise(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}
void main() {
  vec3 light = texture(u_light, v_uv).rgb;
  vec3 bloom = texture(u_bloom, v_uv).rgb;
  vec3 c = light + bloom * u_strength;
  // Skyglow: city light scattered by the air over the horizon. Look
  // straight "down" from this pixel through the widest blur and keep the
  // brightest city light found, weakened by how far below it is, so bright
  // districts raise a warm dome. The map's lit ground ends somewhat below
  // the geometric horizon, hence the search instead of a single sample.
  // It fades out below the horizon so nearby streets do not smear upwards.
  if (u_glow > 0.0) {
    vec2 css = vec2(v_uv.x, 1.0 - v_uv.y) * u_css;
    float d = dot(u_horizon.xy, css) + u_horizon.z;
    float fade = 1.0 - smoothstep(0.0, 0.12 * u_css.y, d);
    if (fade > 0.0) {
      // ∫ city(below) · e^(−distance / height) along the downward normal.
      // Three taps along the horizon at each step spread it sideways too.
      const int STEPS = 10;
      float step = 0.019 * u_css.y;
      vec2 down = u_horizon.xy, side = vec2(-down.y, down.x) * 0.035 * u_css.x;
      vec3 dome = vec3(0.0);
      for (int k = 0; k < STEPS; k++) {
        float off = (float(k) + 0.5) * step;
        vec2 q = css + down * off;
        vec3 sum = vec3(0.0);
        for (int j = -1; j <= 1; j++) {
          vec2 p = q + side * float(j);
          vec2 quv = clamp(vec2(p.x / u_css.x, 1.0 - p.y / u_css.y), 0.0, 1.0);
          sum += texture(u_wide, quv).rgb;
        }
        dome += sum / 3.0 * exp(-off / u_glow_height);
      }
      dome *= step / u_glow_height;
      c += dome * vec3(1.0, 0.82, 0.62) * u_glow * fade;
    }
  }
  // Partial adaptation within limits: bright views (the dense horizon) a
  // little darker, sparse ones (looking straight down) a little brighter.
  float adapt = 1.0;
  if (u_auto.y > 0.0) {
    float seen = max(texture(u_adapted, vec2(0.5)).r, 1e-5);
    adapt = clamp(pow(u_auto.x / seen, u_auto.y), 0.7, 1.8);
  }
  c = knee(c * u_exposure * adapt);
  // Dither: the faint, wide glow would otherwise band in 8-bit output.
  c += (noise(gl_FragCoord.xy) - 0.5) / 255.0;
  color = vec4(max(c, 0.0), 0.0);
}`;

interface Target {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
  width: number;
  height: number;
}

export interface BloomSettings {
  strength: number;
  exposure: number;
  /** Average light level that gets exposure 1 under eye adaptation. */
  adaptTarget: number;
  /** 0 = off, 1 = full adaptation; between, partial. */
  adaptStrength: number;
  /** Time constant of the adaptation (ms). */
  adaptMs: number;
}

export interface Skyglow {
  horizon: readonly [number, number, number];
  width: number;
  height: number;
  strength: number;
}

export class LightBloom {
  private gl: WebGL2RenderingContext;
  private down: WebGLProgram;
  private up: WebGLProgram;
  private composite: WebGLProgram;
  private adapt: WebGLProgram;
  private adaptU: Record<
    "u_src" | "u_prev" | "u_blend" | "u_horizon" | "u_css",
    WebGLUniformLocation | null
  >;
  /** Ping-pong 1×1 targets holding the adapted brightness; null without half floats. */
  private adapted: [Target, Target] | null = null;
  private adaptedFresh = true;
  private vao: WebGLVertexArrayObject;
  private downU: Record<"u_src" | "u_texel", WebGLUniformLocation | null>;
  private upU: Record<"u_src" | "u_texel" | "u_weight", WebGLUniformLocation | null>;
  private compositeU: Record<
    | "u_light"
    | "u_bloom"
    | "u_wide"
    | "u_strength"
    | "u_exposure"
    | "u_horizon"
    | "u_css"
    | "u_glow"
    | "u_glow_height"
    | "u_adapted"
    | "u_auto",
    WebGLUniformLocation | null
  >;
  private format: { internal: number; type: number };
  private light: Target | null = null;
  private levels: Target[] = [];

  /** Throws when the context cannot render to textures; callers fall back. */
  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    const vao = gl.createVertexArray();
    if (!vao) throw new Error("No vertex array support");
    this.vao = vao;
    this.down = compileProgram(gl, FULLSCREEN_VERTEX, DOWN);
    this.up = compileProgram(gl, FULLSCREEN_VERTEX, UP);
    this.composite = compileProgram(gl, FULLSCREEN_VERTEX, COMPOSITE);
    this.adapt = compileProgram(gl, FULLSCREEN_VERTEX, ADAPT);
    this.adaptU = uniforms(gl, this.adapt, ["u_src", "u_prev", "u_blend", "u_horizon", "u_css"]);
    this.downU = uniforms(gl, this.down, ["u_src", "u_texel"]);
    this.upU = uniforms(gl, this.up, ["u_src", "u_texel", "u_weight"]);
    this.compositeU = uniforms(gl, this.composite, [
      "u_light",
      "u_bloom",
      "u_wide",
      "u_strength",
      "u_exposure",
      "u_horizon",
      "u_css",
      "u_glow",
      "u_glow_height",
      "u_adapted",
      "u_auto",
    ]);
    // Half floats keep the sum of many overlapping lights; 8-bit still works
    // but clips dense areas before the tone curve can soften them.
    const float =
      gl.getExtension("EXT_color_buffer_float") ||
      gl.getExtension("EXT_color_buffer_half_float");
    this.format = float
      ? { internal: gl.RGBA16F, type: gl.HALF_FLOAT }
      : { internal: gl.RGBA8, type: gl.UNSIGNED_BYTE };
    if (float && !this.probe()) this.format = { internal: gl.RGBA8, type: gl.UNSIGNED_BYTE };
    // Faint average light levels need more than 8 bits; without half floats
    // the exposure simply stays fixed.
    if (this.format.type === gl.HALF_FLOAT)
      this.adapted = [this.createTarget(1, 1), this.createTarget(1, 1)];
  }

  private probe(): boolean {
    try {
      this.deleteTarget(this.createTarget(4, 4));
      return true;
    } catch {
      return false;
    }
  }

  private createTarget(width: number, height: number): Target {
    const gl = this.gl,
      texture = gl.createTexture(),
      framebuffer = gl.createFramebuffer();
    if (!texture || !framebuffer) throw new Error("Could not create a render target");
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      this.format.internal,
      width,
      height,
      0,
      gl.RGBA,
      this.format.type,
      null,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteFramebuffer(framebuffer);
      gl.deleteTexture(texture);
      throw new Error("Render target incomplete: " + status);
    }
    return { texture, framebuffer, width, height };
  }

  private deleteTarget(target: Target): void {
    this.gl.deleteFramebuffer(target.framebuffer);
    this.gl.deleteTexture(target.texture);
  }

  private resize(width: number, height: number): void {
    if (this.light?.width === width && this.light.height === height) return;
    if (this.light) this.deleteTarget(this.light);
    for (const level of this.levels) this.deleteTarget(level);
    this.light = this.createTarget(width, height);
    this.levels = [];
    for (let i = 1; i <= LEVELS; i++)
      this.levels.push(
        this.createTarget(Math.max(1, width >> i), Math.max(1, height >> i)),
      );
  }

  /** Binds the full-size light texture, cleared, for additive drawing. */
  begin(width: number, height: number): void {
    const gl = this.gl;
    this.resize(width, height);
    const light = this.light!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, light.framebuffer);
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  private pass(target: Target, program: WebGLProgram, source: Target): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, target.width, target.height);
    gl.useProgram(program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, source.texture);
  }

  /** Blurs the light texture and composites it into `output` (the map's framebuffer). */
  finish(
    output: WebGLFramebuffer | null,
    viewport: Int32Array,
    { strength, exposure, adaptTarget, adaptStrength, adaptMs }: BloomSettings,
    skyglow: Skyglow | null = null,
    dtMs = 16,
  ): void {
    const gl = this.gl,
      light = this.light!,
      levels = this.levels;
    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);
    let source = light;
    for (const level of levels) {
      this.pass(level, this.down, source);
      gl.uniform1i(this.downU.u_src, 0);
      gl.uniform2f(this.downU.u_texel, 1 / source.width, 1 / source.height);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      source = level;
    }
    const adapted = this.adapted && adaptStrength > 0 ? this.adapted : null;
    if (adapted) {
      // Read last frame's value from one 1×1 target, write the eased one to the other.
      const [before, after] = adapted;
      this.pass(after, this.adapt, levels[levels.length - 1]);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, before.texture);
      gl.uniform1i(this.adaptU.u_src, 0);
      gl.uniform1i(this.adaptU.u_prev, 1);
      // Without a sky scene, every sample counts as ground.
      gl.uniform3f(this.adaptU.u_horizon, ...(skyglow?.horizon ?? [0, 0, 1]));
      gl.uniform2f(this.adaptU.u_css, skyglow?.width ?? 1, skyglow?.height ?? 1);
      gl.uniform1f(
        this.adaptU.u_blend,
        this.adaptedFresh ? 1 : 1 - Math.exp(-Math.min(Math.max(dtMs, 0), 250) / adaptMs),
      );
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      this.adapted = [after, before];
      this.adaptedFresh = false;
    }
    // Walk back up, adding each blurrier level onto the sharper one above it.
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    for (let i = levels.length - 1; i > 0; i--) {
      this.pass(levels[i - 1], this.up, levels[i]);
      gl.uniform1i(this.upU.u_src, 0);
      gl.uniform2f(this.upU.u_texel, 1 / levels[i].width, 1 / levels[i].height);
      gl.uniform1f(this.upU.u_weight, 1);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, output);
    gl.viewport(viewport[0], viewport[1], viewport[2], viewport[3]);
    gl.useProgram(this.composite);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, light.texture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, levels[0].texture);
    gl.activeTexture(gl.TEXTURE2);
    // 1/16 size, holding its own and the blurrier level: broad but not blocky.
    gl.bindTexture(gl.TEXTURE_2D, levels[Math.min(3, levels.length - 1)].texture);
    const u = this.compositeU;
    gl.uniform1i(u.u_light, 0);
    gl.uniform1i(u.u_bloom, 1);
    gl.uniform1i(u.u_wide, 2);
    gl.uniform1f(u.u_strength, strength / levels.length);
    gl.uniform1f(u.u_exposure, exposure);
    gl.uniform1f(u.u_glow, skyglow?.strength ?? 0);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, adapted ? this.adapted![0].texture : null); // the newest
    gl.uniform1i(u.u_adapted, 3);
    gl.uniform3f(u.u_auto, adaptTarget, adapted ? adaptStrength : 0, 0);
    if (skyglow) {
      gl.uniform3f(u.u_horizon, ...skyglow.horizon);
      gl.uniform2f(u.u_css, skyglow.width, skyglow.height);
      gl.uniform1f(u.u_glow_height, Math.max(1, skyglow.height * 0.07));
    }
    gl.blendFunc(gl.ONE, gl.ONE); // light adds onto the dark map
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindVertexArray(null);
  }

  dispose(): void {
    const gl = this.gl;
    if (this.light) this.deleteTarget(this.light);
    for (const level of this.levels) this.deleteTarget(level);
    this.light = null;
    this.levels = [];
    gl.deleteProgram(this.down);
    gl.deleteProgram(this.up);
    gl.deleteProgram(this.composite);
    gl.deleteProgram(this.adapt);
    if (this.adapted) for (const target of this.adapted) this.deleteTarget(target);
    this.adapted = null;
    gl.deleteVertexArray(this.vao);
  }
}
