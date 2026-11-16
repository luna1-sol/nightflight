import { expect, type Page } from "@playwright/test";
import { PNG } from "pngjs";

export const TOKYO = "/#lat=35.6812&lon=139.7671&heading=90&name=Tokyo";
// Taveuni, Fiji: the 180° meridian crosses the island, 1 km east of here.
export const DATE_LINE = "/#lat=-16.82&lon=179.99&heading=90&name=Taveuni";

/** Fixes display settings before the app starts, so auto quality cannot vary a run. */
export async function useDisplay(
  page: Page,
  settings: { glow?: boolean; twinkle?: boolean; quality?: "auto" | "high" | "low" } = {},
): Promise<void> {
  const value = JSON.stringify({ glow: true, twinkle: false, quality: "high", ...settings });
  await page.addInitScript((saved) => {
    if (!sessionStorage.getItem("e2e-display-set")) {
      localStorage.setItem("nightflight-display", saved);
      sessionStorage.setItem("e2e-display-set", "1");
    }
  }, value);
}

/** Collects uncaught page errors; checked at the end of each test. */
export function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  return errors;
}

export async function waitForLights(page: Page, minimum = 500): Promise<void> {
  const map = page.locator("#map");
  await expect(map).toHaveAttribute("data-state", "ready", { timeout: 60_000 });
  await expect
    .poll(async () => Number(await map.getAttribute("data-lights")), { timeout: 60_000 })
    .toBeGreaterThan(minimum);
}

/** Pixels brighter than `threshold` (0–255 luminance) in the ground half of the screen. */
export async function brightGroundPixels(page: Page, threshold = 90): Promise<number> {
  const viewport = page.viewportSize()!;
  const shot = PNG.sync.read(
    await page.screenshot({
      clip: {
        x: 0,
        y: Math.round(viewport.height * 0.35),
        width: viewport.width,
        height: Math.round(viewport.height * 0.6),
      },
    }),
  );
  let bright = 0;
  for (let i = 0; i < shot.data.length; i += 4) {
    const luminance =
      0.2126 * shot.data[i] + 0.7152 * shot.data[i + 1] + 0.0722 * shot.data[i + 2];
    if (luminance > threshold) bright++;
  }
  return bright;
}

/** Waits until the city lights are visibly drawn on screen. */
export async function expectLightsOnScreen(page: Page, minimum = 400): Promise<void> {
  await expect.poll(() => brightGroundPixels(page), { timeout: 45_000 }).toBeGreaterThan(minimum);
}
