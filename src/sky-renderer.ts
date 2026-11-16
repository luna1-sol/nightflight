// Works out what the night sky shows for a frame: stars, distant aircraft
// and the occasional meteor, as glowing sprites in screen pixels. The lights
// layer draws them on the GPU together with the city lights, so they share
// the bloom, and clips them to the sky above the horizon line.
import { clamp } from "./flight-math.ts";
import { seededRandom } from "./flight-state.ts";
import { horizonLine, meteorPath, type Meteor } from "./view-math.ts";
import type { Frame } from "./types.ts";
const RAD = Math.PI / 180,
  TAU = Math.PI * 2;

/** x, y (CSS px), radius (CSS px), r, g, b, alpha */
export const SPRITE_FLOATS = 7;
const MAX_SPRITES = 1024;

export interface SkyScene {
  sprites: Float32Array;
  count: number;
  /** A·x + B·y + C ≤ 0 is sky, in CSS pixels. */
  horizon: [number, number, number];
  width: number;
  height: number;
}

interface Star {
  az: number;
  elevation: number;
  brightness: number;
}
interface ActiveMeteor extends Meteor {
  t: number;
}

const colorCache = new Map<string, [number, number, number]>();
function rgb(hex: string): [number, number, number] {
  let value = colorCache.get(hex);
  if (!value) {
    const n = parseInt(hex.slice(1, 7), 16);
    value = [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
    colorCache.set(hex, value);
  }
  return value;
}

export class SkyRenderer {
  stars: Star[];
  meteor: ActiveMeteor | null = null;
  nextMeteor = 5;
  width = 0;
  height = 0;
  private sprites = new Float32Array(MAX_SPRITES * SPRITE_FLOATS);
  private count = 0;

  constructor() {
    this.stars = Array.from({ length: 550 }, (_, index) => ({
      az: seededRandom(index, 1) * TAU,
      elevation: Math.asin(seededRandom(index, 2)),
      brightness: seededRandom(index, 3),
    }));
    this.reset();
  }
  reset(): void {
    this.meteor = null;
    this.nextMeteor = 5;
  }
  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }
  project(
    az: number,
    elevation: number,
    frame: Frame,
  ): { x: number; y: number } | null {
    if (elevation <= 0.035) return null;
    const bearing = (frame.heading - 90 + frame.yaw) * RAD,
      tilt = frame.tilt * RAD,
      ce = Math.cos(elevation);
    const east = Math.sin(az) * ce,
      north = Math.cos(az) * ce,
      up = Math.sin(elevation);
    const right = east * Math.cos(bearing) - north * Math.sin(bearing),
      forward = east * Math.sin(bearing) + north * Math.cos(bearing);
    const depth = forward * Math.cos(tilt) - up * Math.sin(tilt);
    if (depth <= 0.01) return null;
    const focal = this.height / (2 * Math.tan(30 * RAD)),
      x = (right * focal) / depth,
      y = ((-up * Math.cos(tilt) - forward * Math.sin(tilt)) * focal) / depth,
      roll = -frame.bank * 0.5 * RAD;
    return {
      x: this.width / 2 + x * Math.cos(roll) - y * Math.sin(roll),
      y: this.height / 2 + x * Math.sin(roll) + y * Math.cos(roll),
    };
  }
  private sprite(
    x: number,
    y: number,
    radius: number,
    color: string,
    alpha: number,
  ): void {
    if (
      this.count >= MAX_SPRITES ||
      x < -10 ||
      x > this.width + 10 ||
      y < -10 ||
      y > this.height + 10
    )
      return;
    const [r, g, b] = rgb(color),
      data = this.sprites;
    let i = this.count++ * SPRITE_FLOATS;
    data[i++] = x;
    data[i++] = y;
    data[i++] = radius;
    data[i++] = r;
    data[i++] = g;
    data[i++] = b;
    data[i] = alpha;
  }
  private addStars(frame: Frame): void {
    for (const star of this.stars) {
      const point = this.project(star.az, star.elevation, frame);
      if (!point) continue;
      const bright = star.brightness > 0.96;
      this.sprite(
        point.x,
        point.y,
        bright ? 0.9 : 0.6,
        "#d1dce7",
        0.2 + star.brightness * 0.5,
      );
    }
  }
  private addAircraft(frame: Frame): void {
    for (let index = 0; index < 3; index++) {
      const along = 22000 - ((frame.time + index * 71) % 250) * 170,
        outward = 14000 + index * 8000,
        bearing = (frame.heading - 90) * RAD;
      const east = Math.sin(bearing) * outward + Math.cos(bearing) * along,
        north = Math.cos(bearing) * outward - Math.sin(bearing) * along;
      const point = this.project(
        Math.atan2(east, north),
        Math.atan2(2400 + index * 1800, Math.hypot(east, north)),
        frame,
      );
      if (!point) continue;
      this.sprite(point.x, point.y, 0.7, "#e4e3d7", 0.6);
      this.sprite(point.x - 1.2, point.y, 0.5, "#ef6354", 0.65);
      if ((frame.time + index * 0.43) % 1.4 < 0.09)
        this.sprite(point.x, point.y, 1.4, "#eff6ff", 0.9);
    }
  }
  private addMeteor(frame: Frame, dt: number): void {
    this.nextMeteor -= dt;
    if (this.nextMeteor <= 0) {
      this.meteor = {
        az:
          (frame.heading - 90 + frame.yaw) * RAD + (Math.random() - 0.5) * 0.6,
        elevation: clamp(
          -frame.tilt * RAD + 0.2 + Math.random() * 0.3,
          0.15,
          1.3,
        ),
        va: (Math.random() < 0.5 ? -1 : 1) * 0.35,
        t: 0,
      };
      this.nextMeteor = 18 + Math.random() * 23;
    }
    const meteor = this.meteor;
    if (!meteor) return;
    meteor.t += dt;
    if (meteor.t > 1.05) {
      this.meteor = null;
      return;
    }
    const head = meteorPath(meteor, meteor.t),
      tail = meteorPath(meteor, Math.max(0, meteor.t - 0.14));
    const a = this.project(head.az, head.elevation, frame),
      b = this.project(tail.az, tail.elevation, frame);
    if (!a || !b) return;
    // A streak of overlapping dots, fading in from the tail to the head.
    const fade = Math.sin((meteor.t / 1.05) * Math.PI),
      steps = Math.min(120, Math.max(2, Math.ceil(Math.hypot(a.x - b.x, a.y - b.y) / 1.2)));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      this.sprite(
        b.x + (a.x - b.x) * t,
        b.y + (a.y - b.y) * t,
        0.55,
        "#e3efff",
        fade * t * 0.55,
      );
    }
  }
  /** Advances meteors by `dt` and lays out this frame's sky. */
  update(frame: Frame, dt: number): SkyScene {
    this.count = 0;
    this.addStars(frame);
    this.addAircraft(frame);
    this.addMeteor(frame, dt);
    return this.scene(frame);
  }
  scene(frame: Frame): SkyScene {
    return {
      sprites: this.sprites,
      count: this.count,
      horizon: horizonLine(this.width, this.height, frame.tilt, frame.bank * 0.5),
      width: this.width,
      height: this.height,
    };
  }
}
