import * as maplibre from "maplibre-gl";
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import { CONFIG } from "./config.ts";
import {
  clamp,
  normalizeLocation,
  locationFromHash,
  locationHash,
} from "./flight-math.ts";
import { flightCamera, VIEW_LIMITS } from "./view-math.ts";
import { FlightState } from "./flight-state.ts";
import { ViewControls } from "./view-controls.ts";
import { SkyRenderer } from "./sky-renderer.ts";
import { LightingController } from "./lighting-controller.ts";
import { PlacePicker } from "./place-picker.ts";
import { createNightStyle } from "./night-style.ts";
import {
  createLightsLayer,
  keepLightsLayerAttached,
  type LightsLayer,
} from "./night-lights-layer.ts";
import type { LocationInput } from "./flight-math.ts";
import type { FlightLocation, Frame } from "./types.ts";

const MAP_HANDLERS = [
  "dragPan",
  "dragRotate",
  "scrollZoom",
  "boxZoom",
  "keyboard",
  "doubleClickZoom",
  "touchZoomRotate",
  "touchPitch",
] as const;
const LAMP_COLORS: Record<string, [number, number, number]> = {
  "night-warm": [246, 180, 93],
  "night-amber": [255, 201, 125],
  "night-white": [232, 234, 216],
};

function initialLocation(): FlightLocation {
  const shared = locationFromHash(window.location.hash);
  if (shared) return shared;
  try {
    const saved = normalizeLocation(
      JSON.parse(localStorage.getItem("nightflight-location") ?? "null"),
    );
    if (saved) return saved;
  } catch {}
  return normalizeLocation(CONFIG.defaultLocation) ?? { ...CONFIG.defaultLocation };
}
function lampImage(color: readonly number[]) {
  const size = 16,
    data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const distance = Math.hypot(x - 7.5, y - 7.5) / 2,
        alpha = Math.min(
          1,
          Math.exp((-distance * distance) / 1.05) +
            Math.exp((-distance * distance) / 4.5) * 0.12,
        ),
        index = (y * size + x) * 4;
      data[index] = color[0];
      data[index + 1] = color[1];
      data[index + 2] = color[2];
      data[index + 3] = Math.round(alpha * 255);
    }
  return { width: size, height: size, data };
}

const ELEMENT_IDS = [
  "sky",
  "map",
  "notice",
  "hud",
  "choose-place",
  "place-name",
  "pause",
  "reset-view",
  "fullscreen",
  "flight-status",
] as const;
type AppElements = Record<(typeof ELEMENT_IDS)[number], HTMLElement> & {
  sky: HTMLCanvasElement;
};

class NightflightApp {
  elements: AppElements;
  reducedMotion: boolean;
  flight: FlightState;
  map: maplibre.Map | null = null;
  ready = false;
  mapFailed = false;
  dirty = true;
  idle = 0;
  previous = performance.now();
  lastFrame = 0;
  noticeTimer: ReturnType<typeof setTimeout> | undefined;
  transientTimer: ReturnType<typeof setTimeout> | undefined;
  sky: SkyRenderer;
  view: ViewControls;
  lightsLayer: LightsLayer;
  lighting: LightingController;
  picker: PlacePicker;
  width = 0;
  height = 0;

  constructor() {
    this.elements = Object.fromEntries(
      ELEMENT_IDS.map((id) => {
        const element = document.getElementById(id);
        if (!element) throw new Error(`Missing #${id}`);
        return [id, element];
      }),
    ) as AppElements;
    this.reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.flight = new FlightState(initialLocation(), {
      speed: CONFIG.speed,
      reducedMotion: this.reducedMotion,
    });
    this.sky = new SkyRenderer(this.elements.sky);
    this.view = new ViewControls(this.elements.sky, {
      reducedMotion: this.reducedMotion,
      onChange: (input) => {
        if (input) this.lighting.markViewChanged(performance.now());
        this.dirty = true;
        this.wake();
      },
    });
    this.lightsLayer = createLightsLayer({
      origin: () => this.flight.position,
      twinkle: !this.reducedMotion,
    });
    this.lighting = new LightingController({
      lights: this.lightsLayer,
      getMap: () => this.map,
      getFrame: () => this.frame(),
      isDragging: () => this.view.isDragging,
    });
    this.picker = new PlacePicker({
      maplibre,
      canvas: this.elements.sky,
      searchEndpoint: CONFIG.searchEndpoint,
      getMap: () => this.map,
      getFlight: () => this.flight,
      onChoose: (place) => this.startFlight(place),
      onHeadingChange: (heading) => {
        this.flight.setHeading(heading);
        this.saveLocation();
        this.dirty = true;
      },
      onActivity: () => this.wake(),
      onClose: () => {
        this.dirty = true;
        this.elements.sky.focus({ preventScroll: true });
      },
      onPickingChange: (picking) => {
        if (picking) this.sky.clear();
        else this.applyCamera();
        this.dirty = true;
      },
    });
    this.resize();
    this.bindEvents();
    this.updateLabel();
  }
  start(): void {
    this.initializeMap();
    requestAnimationFrame((now) => this.tick(now));
  }
  frame(): Frame {
    return {
      position: this.flight.position,
      heading: this.flight.heading,
      time: this.flight.time,
      bank: this.flight.bank,
      tilt: this.view.tilt,
      yaw: this.view.yaw,
      width: this.width,
      height: this.height,
    };
  }
  resize(): void {
    this.width = innerWidth;
    this.height = innerHeight;
    this.sky.resize(
      this.width,
      this.height,
      Math.min(devicePixelRatio || 1, CONFIG.pixelRatio),
    );
    this.map?.resize();
    this.dirty = true;
  }
  wake(): void {
    this.idle = 0;
    this.elements.hud.classList.remove("idle");
    this.elements["choose-place"].classList.remove("idle");
  }
  showNotice(message: string, error = false): void {
    clearTimeout(this.transientTimer);
    const notice = this.elements.notice;
    notice.replaceChildren(document.createTextNode(message));
    if (error) {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = "Retry";
      retry.addEventListener("click", () => window.location.reload());
      const offline = document.createElement("a");
      offline.href = "./offline.html?v=1.1.3-7dab4e25";
      offline.textContent = "Offline flight";
      notice.append(
        document.createTextNode(" "),
        retry,
        document.createTextNode(" · "),
        offline,
      );
    }
    notice.hidden = false;
  }
  showTransient(message: string): void {
    this.showNotice(message);
    this.transientTimer = setTimeout(() => {
      if (this.ready) this.elements.notice.hidden = true;
    }, 2600);
  }
  initializeMap(): void {
    maplibre.setWorkerUrl(new URL(maplibreWorkerUrl, location.href).href);
    maplibre.setWorkerCount(2);
    try {
      const location = this.flight.location;
      this.map = new maplibre.Map({
        container: "map",
        style: createNightStyle(CONFIG.vectorSource, CONFIG.glyphsURL),
        center: [location.lon, location.lat],
        zoom: 11,
        pitch: 66,
        bearing: this.flight.heading - 90,
        minPitch: 0,
        maxPitch: 90 - VIEW_LIMITS.minTilt,
        minZoom: 0,
        maxZoom: 18,
        attributionControl: false,
        interactive: true,
        fadeDuration: 0,
        pixelRatio: Math.min(devicePixelRatio || 1, CONFIG.pixelRatio),
        maxTileCacheSize: 100,
        renderWorldCopies: true,
        canvasContextAttributes: {
          antialias: false,
          powerPreference: "high-performance",
        },
      });
      const map = this.map;
      map.setMissingStyleImageResolver((id) => {
        const color = LAMP_COLORS[id];
        if (color && !map.hasImage(id))
          map.addImage(id, lampImage(color), { pixelRatio: 2 });
      });
      this.map.setVerticalFieldOfView(60);
      this.map.setCenterClampedToGround(false);
      for (const handler of MAP_HANDLERS) this.map[handler]?.disable();
      this.applyCamera();
      this.map.on("sourcedata", (event) => {
        if (event.sourceId === "world" && event.sourceDataType === "content")
          this.lighting.markDataChanged(performance.now());
      });
      keepLightsLayerAttached(this.map, this.lightsLayer, {
        beforeId: "overview-borders",
        hidden: () => this.picker.isPicking,
      });
      this.map.on("load", () => {
        this.ready = true;
        this.elements.map.dataset.state = this.mapFailed ? "error" : "ready";
        clearTimeout(this.noticeTimer);
        if (!this.mapFailed) this.elements.notice.hidden = true;
        this.dirty = true;
      });
      this.map.on("error", () => {
        if (!this.ready) {
          this.mapFailed = true;
          this.elements.map.dataset.state = "error";
          this.showNotice(
            "Map data could not load. Check your connection and retry.",
            true,
          );
        }
      });
      this.map.on("click", (event) => this.picker.pickPoint(event.lngLat));
      this.noticeTimer = setTimeout(() => {
        if (!this.ready)
          this.showNotice(
            "The map is taking a while to load. You can still choose a place.",
            true,
          );
      }, 18000);
    } catch (error) {
      this.elements.map.dataset.state = "error";
      this.showNotice("This browser could not start the world map.", true);
      console.error(error);
    }
  }
  applyCamera(): void {
    if (!this.map || this.picker.isPicking) return;
    const options = flightCamera({
      position: this.flight.position,
      heading: this.flight.heading,
      yaw: this.view.yaw,
      tilt: this.view.tilt,
      altitude: CONFIG.altitude,
      height: this.height,
      roll: this.flight.bank * 0.5,
    });
    if (
      [options.zoom, ...options.center, options.elevation].every(
        Number.isFinite,
      )
    )
      this.map.jumpTo(options);
  }
  updateLabel(): void {
    const location = this.flight.location;
    this.elements["place-name"].textContent = location.name;
    document.title = `${location.name} · Nightflight`;
    this.picker.setHeading(location.heading);
  }
  saveLocation(): void {
    try {
      localStorage.setItem(
        "nightflight-location",
        JSON.stringify(this.flight.location),
      );
    } catch {}
    try {
      history.replaceState(null, "", locationHash(this.flight.location));
    } catch {}
  }
  startFlight(value: LocationInput, preserveHeading = false): void {
    const location = normalizeLocation({
      ...value,
      heading: preserveHeading ? value.heading : this.picker.heading,
    });
    if (!location) {
      document.getElementById("search-status")!.textContent =
        "Use a latitude between −85 and 85, and longitude between −180 and 180.";
      return;
    }
    this.flight.start(location);
    this.view.reset();
    this.sky.reset();
    this.lighting.reset(performance.now());
    this.dirty = true;
    this.picker.finishPicking();
    this.picker.close();
    this.updatePauseButton();
    this.elements["flight-status"].textContent = `Flying over ${location.name}`;
    this.updateLabel();
    this.saveLocation();
    this.applyCamera();
    this.wake();
  }
  updatePauseButton(): void {
    const paused = this.flight.paused;
    this.elements.pause.textContent = paused ? "▶" : "Ⅱ";
    this.elements.pause.setAttribute("aria-label", paused ? "Resume" : "Pause");
    this.elements.pause.setAttribute("aria-pressed", String(paused));
  }
  togglePause(): void {
    this.flight.paused = !this.flight.paused;
    this.updatePauseButton();
    this.elements["flight-status"].textContent = this.flight.paused
      ? "Paused"
      : "Cruising";
    this.dirty = true;
    this.wake();
  }
  async fullscreen(): Promise<void> {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      this.showTransient("Fullscreen is unavailable in this browser.");
    }
  }
  bindEvents(): void {
    this.elements["choose-place"].onclick = () => this.picker.open();
    this.elements.pause.onclick = () => this.togglePause();
    this.elements["reset-view"].onclick = () => this.view.reset();
    this.elements.fullscreen.onclick = () => this.fullscreen();
    if (!document.documentElement.requestFullscreen)
      this.elements.fullscreen.hidden = true;
    document.addEventListener("fullscreenchange", () =>
      this.elements.fullscreen.setAttribute(
        "aria-label",
        document.fullscreenElement ? "Exit fullscreen" : "Fullscreen",
      ),
    );
    addEventListener("resize", () => this.resize());
    addEventListener("pointermove", () => this.wake());
    addEventListener("pointerdown", () => this.wake());
    addEventListener("keydown", (event) => this.handleKey(event));
    document.addEventListener("visibilitychange", () => {
      this.previous = performance.now();
      this.dirty = true;
    });
    addEventListener("hashchange", () => {
      const value = locationFromHash(window.location.hash);
      if (value) {
        this.picker.setHeading(value.heading);
        this.startFlight(value, true);
      }
    });
  }
  handleKey(event: KeyboardEvent): void {
    if (this.picker.isOpen) return;
    if (event.code === "Escape" && this.picker.isPicking) {
      this.picker.cancelPicking(false);
      return;
    }
    if (
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLSelectElement ||
      event.target instanceof HTMLButtonElement
    )
      return;
    if (
      [
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "Space",
        "Home",
      ].includes(event.code)
    )
      event.preventDefault();
    const directions: Record<string, [number, number]> = {
      ArrowUp: [0, 60],
      ArrowDown: [0, -60],
      ArrowLeft: [60, 0],
      ArrowRight: [-60, 0],
    };
    const direction = directions[event.code];
    if (direction) this.view.move(...direction);
    if (event.repeat) return;
    if (event.code === "Space" && !this.picker.isPicking) this.togglePause();
    if (event.code === "Home") this.view.reset();
    if (event.code === "KeyL") this.picker.open();
    if (
      event.code === "KeyF" &&
      typeof document.documentElement.requestFullscreen === "function"
    )
      this.fullscreen();
  }
  tick(now: number): void {
    requestAnimationFrame((next) => this.tick(next));
    if (now - this.lastFrame < 1000 / CONFIG.frameRate - 1) return;
    this.lastFrame = now;
    const dt = clamp((now - this.previous) / 1000, 0, 0.08);
    this.previous = now;
    this.idle += dt;
    const picking = this.picker.isPicking,
      modal = this.picker.isOpen,
      hidden = document.hidden;
    if (this.idle > 4 && !modal && !picking) {
      this.elements.hud.classList.add("idle");
      this.elements["choose-place"].classList.add("idle");
    }
    const moving =
      this.ready && !this.flight.paused && !modal && !picking && !hidden;
    if (moving) {
      this.flight.advance(dt);
      this.dirty = true;
    }
    if (!picking && !modal && !hidden && this.view.update(dt))
      this.dirty = true;
    this.lighting.update(now, {
      ready: this.ready,
      blocked: picking || modal || hidden,
    });
    if (picking || !this.dirty || hidden) return;
    this.dirty = false;
    this.applyCamera();
    this.sky.draw(this.frame(), moving ? dt : 0);
  }
}

const app = new NightflightApp();
app.start();
