// Display settings and automatic quality.
//
// Quality levels: 0 = full (bloom, full pixel density), 1 = no bloom,
// 2 = no bloom and pixel density 1. In "auto" mode the governor lowers the
// level one step at a time while flight runs well below the frame cap; it
// never raises it again by itself, so the picture does not flip back and forth.

export type QualityMode = "auto" | "high" | "low";

export interface DisplaySettings {
  glow: boolean;
  twinkle: boolean;
  quality: QualityMode;
}

const STORAGE_KEY = "nightflight-display";

export function defaultSettings(reducedMotion: boolean): DisplaySettings {
  return { glow: true, twinkle: !reducedMotion, quality: "auto" };
}

type StorageLike = Pick<Storage, "getItem" | "setItem">;
function browserStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function loadSettings(
  reducedMotion: boolean,
  storage: StorageLike | null = browserStorage(),
): DisplaySettings {
  const settings = defaultSettings(reducedMotion);
  try {
    const saved = JSON.parse(storage?.getItem(STORAGE_KEY) ?? "null") as
      | Partial<Record<keyof DisplaySettings, unknown>>
      | null;
    if (typeof saved?.glow === "boolean") settings.glow = saved.glow;
    if (typeof saved?.twinkle === "boolean") settings.twinkle = saved.twinkle;
    if (saved?.quality === "auto" || saved?.quality === "high" || saved?.quality === "low")
      settings.quality = saved.quality;
  } catch {}
  return settings;
}

export function saveSettings(
  settings: DisplaySettings,
  storage: StorageLike | null = browserStorage(),
): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {}
}

export const MAX_LEVEL = 2;

/** What a quality level means for rendering. */
export function effectiveDisplay(
  settings: DisplaySettings,
  autoLevel: number,
  maxPixelRatio: number,
): { level: number; bloom: boolean; pixelRatio: number } {
  const level =
    settings.quality === "auto" ? autoLevel : settings.quality === "low" ? MAX_LEVEL : 0;
  return {
    level,
    bloom: settings.glow && level < 1,
    pixelRatio: level >= 2 ? Math.min(1, maxPixelRatio) : maxPixelRatio,
  };
}

export class QualityGovernor {
  level = 0;
  /** Frame interval that counts as too slow (ms); 30 fps is ~33 ms. */
  slowMs: number;
  /** Frames averaged before deciding. */
  window: number;
  /** Time to let a change settle before judging again (ms). */
  holdMs: number;
  private samples: number[] = [];
  private holdUntil = 0;

  constructor({
    slowMs = 1000 / 22,
    window = 90,
    holdMs = 5000,
  }: { slowMs?: number; window?: number; holdMs?: number } = {}) {
    this.slowMs = slowMs;
    this.window = window;
    this.holdMs = holdMs;
  }

  /**
   * Records the time between two drawn frames while flying. Returns true when
   * the level went down. Long gaps (a hidden tab, a stall) are ignored.
   */
  sample(now: number, intervalMs: number): boolean {
    if (this.level >= MAX_LEVEL || now < this.holdUntil) return false;
    if (!(intervalMs > 0) || intervalMs > 250) return false;
    this.samples.push(intervalMs);
    if (this.samples.length < this.window) return false;
    const average = this.samples.reduce((sum, ms) => sum + ms, 0) / this.samples.length;
    this.samples = [];
    if (average <= this.slowMs) return false;
    this.level++;
    this.holdUntil = now + this.holdMs;
    return true;
  }

  reset(now = 0): void {
    this.level = 0;
    this.samples = [];
    this.holdUntil = now + this.holdMs;
  }
}
