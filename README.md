# Nightflight

An endless night flight over **real places**, with glowing streets, a draggable view, stars, and occasional aircraft and meteors. Based on Night Freeway's points-of-light concept.

## Choose a place

Click the place name at the top left (or press **L**). You can:

- Search for a city, neighborhood, landmark, or address, then choose a result.
- Enter **latitude, longitude**, such as `35.6812, 139.7671`.
- Choose on the map: pan/zoom, click a starting point, then select **Fly here**.
- Try a preset, choose a flight direction, or copy a link to the current location.

The aircraft cruises at 9,000 metres and 235 m/s, with gentle occasional banks. Movement follows geographic coordinates and handles the international date line. The map covers latitudes **85° south to 85° north**. Oceans, deserts, and other places without mapped streets will naturally have few lights.

The geography is actual OpenStreetMap roads, buildings, rivers, parks, and coastlines. Roads render as separated world-anchored light points rather than continuous strokes. Building/neighborhood lights use stable mixes of warm amber, soft yellow, white, and occasional cool light, with varied sizes and brightness; generated neighborhood points stay inside mapped urban polygons and out of polygon holes. The night lighting is an artistic style, not live satellite imagery, measured illumination, real-time weather, or live aircraft tracking. Terrain is flat; elevation is not simulated.

## Controls

| Control | Action |
| --- | --- |
| Mouse or one-finger drag | Look up, down, or sideways |
| Arrow keys | Adjust the view |
| Home or double-click | Reset the view |
| Space | Pause / resume |
| L | Choose a place |
| F | Fullscreen |

Dragging uses reduced sensitivity and a short, non-overshooting ease, with safe upward/downward limits. Camera transforms are computed from the aircraft position without inheriting elevation from previous views. The view stays interactive while paused. Flight pauses while the place picker is open. Reduced-motion preferences disable automatic banking. The controls fade while idle; source attribution remains visible.

## Development

The source is TypeScript under `src/`, built with [Vite](https://vite.dev/). Node.js 24 or later is needed.

```
npm install
npm run dev        # local server with hot reload
npm test           # unit tests (Node runs the .ts files directly)
npm run typecheck  # strict type check of src/
npm run build      # production build into dist/
npm run preview    # serve dist/ locally
```

Opening the world-flight page directly with `file://` is not supported because browsers restrict JavaScript modules and workers. `offline.html` is the original self-contained procedural version and can be opened directly.

## Hosting

`npm run build` writes a **static site** to `dist/`: no server application or secret API keys. All built paths are relative, so it can be served from any static web server, at the domain root or under a subdirectory. Opening it with `file://` does not work.

GitHub Actions (`.github/workflows/ci.yml`) runs the tests and the build on every push to `master` and on pull requests. It does not publish anything.

The bottom-right label shows the release from `package.json`, the commit, and whether you are in world or offline mode. To make a new release, change `version` in `package.json`. The build stamps the label and the Content-Security-Policy hashes for the inline `<script>`/`<style>` blocks into the built pages, and every asset file name carries a content hash. MapLibre is built as its own file, so it stays cached across app releases.

Both pages declare a Content-Security-Policy `<meta>` tag (removed only while `npm run dev` is running, because hot reload needs it gone). If you point `src/config.ts` at different tile, glyph, or search providers, add their origins to `connect-src` in `index.html`.

## Data and dependencies

- [MapLibre GL JS 6.16.0](https://maplibre.org/): pinned to an exact version in `package.json`. Its BSD-3-Clause license is published with the site as `MAPLIBRE-LICENSE.txt`.
- [OpenFreeMap](https://openfreemap.org/quick_start/): public vector tiles and map-picker label glyphs, built from OpenStreetMap/OpenMapTiles. Map attribution stays visible.
- [Photon](https://github.com/komoot/photon): public place search. Queries are sent only when Search is pressed; no autocomplete or background geocoding. Results are cached for the session and requests are limited to one per 1.2 seconds. The public service has reasonable-use limits and no availability guarantee; use your own Photon instance for high traffic.

World flights require an internet connection for map data and search. Coordinate entry and map picking do not depend on the search service. If map loading fails, an error links to the offline flight. Service URLs and flight/performance settings are editable in `src/config.ts`.

Rendering uses MapLibre's GPU tile batching, a 30 fps animation cap, 1.25 maximum pixel density, two map workers plus a dedicated lighting worker, and a bounded tile cache. Road/building light points are capped at 12,000. Raw tile geometry is collected in short, yielding batches, transferred to the lighting worker, and refreshed at most every three seconds during normal flight, with a faster refresh after a view change settles. Stable world-coordinate keys and cached points prevent reshuffling; coarser duplicate roads are removed when detailed tiles arrive. Light radii stay consistent while tilting. Lights are drawn additively into an offscreen texture (half-float where the GPU supports it), given a multi-level bloom, and composited with a soft tone curve, so dense districts glow instead of clipping. Distant lights dim and warm slightly, as if seen through air, and twinkle gently, more so near the horizon; twinkling is off when reduced motion is requested. Without render-to-texture support the lights are drawn directly, without bloom. The per-tile adapter targets the pinned MapLibre 6.16.0 renderer, with a public-API fallback for future upgrades. The sky overlay is separate and has no moon, cloud, rain, or fog effects. Meteor heads/tails stay above the horizon and the entire overlay is clipped to the visible sky, including during banking.

## Code structure

All modules live in `src/`. `nightflight.ts` coordinates the app and animation loop. `flight-state.ts` owns movement and banking, `view-controls.ts` handles dragging, and `sky-renderer.ts` draws the sky overlay. `place-picker.ts` owns the place UI; `place-search.ts` handles search, caching, and throttling.

`lighting-controller.ts` schedules updates, `map-lighting-source.ts` isolates the pinned MapLibre tile adapter (the only code that reads MapLibre internals; its expected shapes are declared at the top of the file), `lights-worker.ts` owns the per-flight light cache, `night-lights-layer.ts` draws the lights on the GPU, and `light-bloom.ts` adds their glow (`gl-utils.ts` holds the shared WebGL helpers). Pure geometry calculations live in `light-geometry.ts`, `place-lights.ts`, `flight-math.ts`, and `view-math.ts`. Shared types are in `types.ts`.

## Validation

Run the coordinate, share-link, geographic-motion, light-placement, camera-stability, and meteor/horizon tests with:

```
npm test
```

Browser checks cover live map loading and search, coordinate entry, map picking, share links, mouse/touch view controls, pause, mobile layout, offline errors, and deployment under a project subdirectory.

## Acknowledgements

Adapted from Night Freeway by Masayuki Hatta. The original project was inspired by the FreeWay recreation at soyokaze2000.com, FKS's original FreeWay, and Yoshihiro Sugahara's Windows port. Original project code is MIT licensed; see LICENSE. MapLibre retains its separate bundled license, and map data is credited to its providers.
