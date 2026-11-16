import type { FlightLocation } from "./types.ts";

// Public, keyless services. Change these URLs to use your own providers, and
// update connect-src in index.html's Content-Security-Policy to match.
export const CONFIG: Readonly<{
  vectorSource: string;
  glyphsURL: string;
  searchEndpoint: string;
  altitude: number;
  speed: number;
  frameRate: number;
  pixelRatio: number;
  defaultLocation: FlightLocation;
}> = Object.freeze({
  vectorSource: "https://tiles.openfreemap.org/planet",
  glyphsURL: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
  searchEndpoint: "https://photon.komoot.io/api/",
  altitude: 9000,
  speed: 235,
  frameRate: 30,
  pixelRatio: 1.25,
  defaultLocation: {
    lat: 35.6812,
    lon: 139.7671,
    heading: 90,
    name: "Tokyo, Japan",
  },
});
