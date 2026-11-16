import { clamp, destination } from "./flight-math.ts";
import type { FlightLocation, Position } from "./types.ts";

export function seededRandom(number: number, salt = 0): number {
  let value = Math.imul(number, 374761393) ^ Math.imul(salt, 668265263);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967296;
}
export function smoothStep(value: number): number {
  value = clamp(value, 0, 1);
  return value * value * (3 - 2 * value);
}
export function bankAt(time: number, seed: number, reducedMotion = false): number {
  if (reducedMotion) return 0;
  const segment = Math.floor(time / 125),
    local = time % 125;
  const start = 18 + seededRandom(segment, seed) * 14,
    duration = 38 + seededRandom(segment, seed + 1) * 14;
  if (local < start || local > start + duration) return 0;
  const progress = (local - start) / duration,
    direction = seededRandom(segment, seed + 2) > 0.5 ? 1 : -1;
  return (
    direction *
    (4 + seededRandom(segment, seed + 3) * 3) *
    smoothStep(progress / 0.3) *
    smoothStep((1 - progress) / 0.3)
  );
}

export class FlightState {
  speed: number;
  reducedMotion: boolean;
  seed: number;
  location!: FlightLocation;
  position!: Position;
  heading = 0;
  time = 0;
  bank = 0;
  paused = false;

  constructor(
    location: FlightLocation,
    {
      speed,
      reducedMotion = false,
      seed = Math.floor(Math.random() * 100000),
    }: { speed: number; reducedMotion?: boolean; seed?: number },
  ) {
    this.speed = speed;
    this.reducedMotion = reducedMotion;
    this.seed = seed;
    this.start(location);
  }
  start(location: FlightLocation): void {
    this.location = location;
    this.position = { lat: location.lat, lon: location.lon };
    this.heading = location.heading;
    this.time = 0;
    this.bank = 0;
    this.paused = false;
  }
  advance(dt: number): void {
    this.time += dt;
    this.bank = bankAt(this.time, this.seed, this.reducedMotion);
    this.heading =
      (this.heading +
        ((Math.tan((this.bank * Math.PI) / 180) * 9.80665) /
          this.speed /
          (Math.PI / 180)) *
          dt +
        360) %
      360;
    if (this.position.lat > 84.5) this.heading = 180;
    if (this.position.lat < -84.5) this.heading = 0;
    this.position = destination(this.position, this.heading, this.speed * dt);
  }
  setHeading(heading: number): void {
    this.heading = heading;
    this.location = { ...this.location, heading };
  }
}
