import test from "node:test";
import assert from "node:assert/strict";
import { LightingController } from "../src/lighting-controller.ts";
import type { Frame, LightRequest } from "../src/types.ts";
import { asMap, emptyResponse } from "./fixtures.ts";

const restoreWorker = (original: typeof Worker | undefined) => {
  if (original === undefined) delete (globalThis as { Worker?: unknown }).Worker;
  else globalThis.Worker = original;
};

test("cruising refreshes lights without tile events, within the update budget", async () => {
  const originalWorker = globalThis.Worker as typeof Worker | undefined;
  const requests: LightRequest[] = [];
  globalThis.Worker = class {
    postMessage(message: LightRequest) {
      requests.push(message);
    }
  } as unknown as typeof Worker;
  try {
    const frame: Frame = {
      position: { lat: 0, lon: 179.999 },
      heading: 90,
      time: 0,
      bank: 0,
      tilt: 24,
      yaw: 0,
      width: 1200,
      height: 800,
    };
    const map = {
      querySourceFeatures: () => [],
      getCenter: () => ({ lng: frame.position.lon, lat: 0 }),
    };
    const controller = new LightingController({
      getMap: () => asMap(map),
      getFrame: () => frame,
      isDragging: () => false,
    });
    await controller.update(1000, { ready: true, blocked: false });
    controller.receive(emptyResponse(0));
    assert.equal(requests.length, 1);
    frame.position = { lat: 0, lon: -179.998 };
    await controller.update(2000, { ready: true, blocked: false });
    assert.equal(requests.length, 1);
    await controller.update(4000, { ready: true, blocked: false });
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].view!.position, frame.position);
    controller.receive(emptyResponse(0));
    await controller.update(7000, { ready: true, blocked: false });
    assert.equal(
      requests.length,
      2,
      "stationary views avoid repeated geometry scans",
    );
    frame.bank = 2;
    await controller.update(7100, { ready: true, blocked: false });
    assert.equal(requests.length, 3);
  } finally {
    restoreWorker(originalWorker);
  }
});

test("tiles that arrive while looking around are lit within 250 ms, even mid-drag", async () => {
  const originalWorker = globalThis.Worker as typeof Worker | undefined;
  const requests: LightRequest[] = [];
  globalThis.Worker = class {
    postMessage(message: LightRequest) {
      requests.push(message);
    }
  } as unknown as typeof Worker;
  try {
    const frame: Frame = {
      position: { lat: 35, lon: 139 },
      heading: 90,
      time: 0,
      bank: 0,
      tilt: 24,
      yaw: 0,
      width: 1200,
      height: 800,
    };
    const map = {
      querySourceFeatures: () => [],
      getCenter: () => ({ lng: 139, lat: 35 }),
    };
    let dragging = false;
    const controller = new LightingController({
      getMap: () => asMap(map),
      getFrame: () => frame,
      isDragging: () => dragging,
    });
    await controller.update(1000, { ready: true, blocked: false });
    controller.receive(emptyResponse(0));
    assert.equal(requests.length, 1);

    dragging = true;
    controller.markViewChanged(1100);
    await controller.update(1500, { ready: true, blocked: false });
    assert.equal(requests.length, 1, "plain dragging keeps its 700 ms pace");

    controller.markDataChanged(1600);
    await controller.update(1650, { ready: true, blocked: false });
    assert.equal(requests.length, 2, "new tiles are lit right away");
    controller.receive(emptyResponse(0));

    dragging = false;
    controller.markDataChanged(9000);
    await controller.update(9300, { ready: true, blocked: false });
    assert.equal(requests.length, 3, "cruising refresh after the 3 s pace");
    controller.receive(emptyResponse(0));
    controller.markDataChanged(9400);
    await controller.update(9700, { ready: true, blocked: false });
    assert.equal(requests.length, 3, "no fast path without recent interaction");
  } finally {
    restoreWorker(originalWorker);
  }
});
