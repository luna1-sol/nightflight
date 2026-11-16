import { expect, test } from "@playwright/test";
import {
  DATE_LINE,
  TOKYO,
  brightGroundPixels,
  expectLightsOnScreen,
  trackErrors,
  useDisplay,
  waitForLights,
} from "./helpers.ts";

test("the map loads and the city lights are drawn", async ({ page }) => {
  const errors = trackErrors(page);
  await useDisplay(page);
  await page.goto(TOKYO);
  await waitForLights(page);
  await expectLightsOnScreen(page);
  // Bloom needs render-to-texture; without it the lights are still drawn.
  await expect(page.locator("#map")).toHaveAttribute("data-bloom", /^(on|unavailable)$/);
  expect(errors).toEqual([]);
});

test("lights come back after the WebGL context is lost and restored", async ({ page }) => {
  const errors = trackErrors(page);
  await useDisplay(page);
  await page.goto(TOKYO);
  await waitForLights(page);
  await expectLightsOnScreen(page);

  const events = await page.evaluate(async () => {
    const canvas = document.querySelector<HTMLCanvasElement>("#map canvas")!;
    const gl = canvas.getContext("webgl2")!;
    const lose = gl.getExtension("WEBGL_lose_context")!;
    const seen: string[] = [];
    canvas.addEventListener("webglcontextlost", () => seen.push("lost"));
    canvas.addEventListener("webglcontextrestored", () => seen.push("restored"));
    lose.loseContext();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    lose.restoreContext();
    await new Promise((resolve) => setTimeout(resolve, 500));
    return seen;
  });
  expect(events).toEqual(["lost", "restored"]);
  // The style is rebuilt without custom layers; the lights must return anyway.
  await expectLightsOnScreen(page);
  expect(Number(await page.locator("#map").getAttribute("data-lights"))).toBeGreaterThan(500);
  expect(errors).toEqual([]);
});

test("flying across the date line keeps the lights", async ({ page }) => {
  const errors = trackErrors(page);
  await useDisplay(page);
  await page.goto(DATE_LINE);
  await waitForLights(page, 50);
  // At 235 m/s the aircraft passes 180° within about five seconds.
  await page.waitForTimeout(8000);
  await expect
    .poll(async () => Number(await page.locator("#map").getAttribute("data-lights")))
    .toBeGreaterThan(50);
  await expect.poll(() => brightGroundPixels(page, 60), { timeout: 30_000 }).toBeGreaterThan(20);
  expect(errors).toEqual([]);
});
