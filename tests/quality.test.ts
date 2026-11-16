import test from "node:test";
import assert from "node:assert/strict";
import {
  QualityGovernor,
  defaultSettings,
  effectiveDisplay,
  loadSettings,
  saveSettings,
} from "../src/quality.ts";

const memoryStorage = () => {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
};

test("settings round-trip and ignore malformed values", () => {
  const storage = memoryStorage();
  assert.deepEqual(loadSettings(false, storage), defaultSettings(false));
  saveSettings({ glow: false, twinkle: true, quality: "low" }, storage);
  assert.deepEqual(loadSettings(false, storage), {
    glow: false,
    twinkle: true,
    quality: "low",
  });
  storage.setItem("nightflight-display", '{"glow":"yes","quality":"ultra"}');
  assert.deepEqual(loadSettings(true, storage), defaultSettings(true));
  storage.setItem("nightflight-display", "not json");
  assert.deepEqual(loadSettings(false, storage), defaultSettings(false));
});

test("reduced motion turns twinkling off by default", () => {
  assert.equal(defaultSettings(true).twinkle, false);
  assert.equal(defaultSettings(false).twinkle, true);
});

test("quality levels drop bloom first, then pixel density", () => {
  const settings = defaultSettings(false);
  assert.deepEqual(effectiveDisplay(settings, 0, 1.25), { level: 0, bloom: true, pixelRatio: 1.25 });
  assert.deepEqual(effectiveDisplay(settings, 1, 1.25), { level: 1, bloom: false, pixelRatio: 1.25 });
  assert.deepEqual(effectiveDisplay(settings, 2, 1.25), { level: 2, bloom: false, pixelRatio: 1 });
  // Fixed modes ignore the automatic level.
  assert.equal(effectiveDisplay({ ...settings, quality: "high" }, 2, 1.25).level, 0);
  assert.equal(effectiveDisplay({ ...settings, quality: "low" }, 0, 1.25).level, 2);
  // Glow off stays off at full quality.
  assert.equal(effectiveDisplay({ ...settings, glow: false }, 0, 1.25).bloom, false);
});

test("the governor steps down only after a slow window, then waits", () => {
  const governor = new QualityGovernor({ window: 10, holdMs: 1000 });
  let now = 0;
  const run = (ms: number, frames: number) => {
    let changed = 0;
    for (let i = 0; i < frames; i++) {
      now += ms;
      if (governor.sample(now, ms)) changed++;
    }
    return changed;
  };
  assert.equal(run(34, 50), 0, "30 fps is fine");
  assert.equal(governor.level, 0);
  assert.equal(run(60, 10), 1, "a slow window lowers the level");
  assert.equal(governor.level, 1);
  assert.equal(run(60, 10), 0, "held while the change settles");
  now += 1000;
  assert.equal(run(60, 10), 1);
  assert.equal(governor.level, 2);
  assert.equal(run(60, 40), 0, "never below the lowest level");
});

test("long gaps such as a hidden tab are not counted", () => {
  const governor = new QualityGovernor({ window: 5, holdMs: 0 });
  for (let i = 0; i < 20; i++) governor.sample(i * 1000, 1000);
  assert.equal(governor.level, 0);
});
