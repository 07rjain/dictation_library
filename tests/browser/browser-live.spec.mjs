import { expect, test } from "@playwright/test";

test("rotates real MediaRecorder windows and emits independently decodable audio", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(() => globalThis.runRecorderIntegration());

  expect(result.summary.durationMs).toBeGreaterThan(2_000);
  expect(result.summary.windowCount).toBeGreaterThanOrEqual(2);
  expect(result.decoded.length).toBe(result.summary.windowCount);
  expect(result.decoded.map((window) => window.sequence)).toEqual(
    Array.from({ length: result.decoded.length }, (_, index) => index),
  );
  for (const window of result.decoded) {
    expect(window.bytes).toBeGreaterThan(0);
    expect(window.duration).toBeGreaterThan(0.1);
    expect(window.channels).toBeGreaterThan(0);
  }
  // The continuously running oscillator spans the first rotation boundary. Independently
  // decodable adjacent windows prove the recorder did not emit headerless MediaRecorder slices.
  expect(result.decoded[0].duration + result.decoded[1].duration).toBeGreaterThan(1.5);
});
