import { expect, test } from "@playwright/test";
import { TOKYO, trackErrors, useDisplay, waitForLights } from "./helpers.ts";

test("display settings apply at once and are remembered", async ({ page }) => {
  const errors = trackErrors(page);
  await useDisplay(page);
  await page.goto(TOKYO);
  await waitForLights(page);
  const map = page.locator("#map");

  await page.getByRole("button", { name: "Display settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Display" });
  await expect(dialog).toBeVisible();

  await dialog.getByLabel(/Glow/).uncheck();
  await expect(map).toHaveAttribute("data-bloom", "off");

  await dialog.getByLabel(/Quality/).selectOption("low");
  await expect(map).toHaveAttribute("data-quality", "2");
  const ratio = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>("#map canvas")!;
    return canvas.width / canvas.clientWidth;
  });
  expect(ratio).toBeCloseTo(1, 1);

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  await page.reload();
  await waitForLights(page);
  await expect(map).toHaveAttribute("data-bloom", "off");
  await expect(map).toHaveAttribute("data-quality", "2");
  expect(errors).toEqual([]);
});
