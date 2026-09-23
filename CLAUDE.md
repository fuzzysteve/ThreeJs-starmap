# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

EVE Online star map pages served directly by Apache + PHP (PDO/MySQL) from a MySQL copy of the SDE. There is no build step, package manager, linter or test suite: PHP pages query the SDE and the browser loads plain ES modules. Two independent viewers live side by side:

- **Classic (Three.js/WebGL)** — `region.php`, `constellation.php` (both rendered by `viewer.js`) and `system.php` (rendered by `systemViewer.js`). The PHP emits data as plain JS globals, pre-scaled into a ~420-unit box, then loads the module. `three.module.min.js`/`three.core.min.js` are vendored from the `three` npm package's `build/` directory.
- **WebGPU fly-through system viewer** — `gpusystem.php` (page shell + CSS, no PHP logic), `gpusystem-data.php` (JSON), `gpusystem.js` (app), `gpusystem-render.js` (renderer). Params: `?system=<solarSystemID>&focus=<itemID>`.

`search.php` (JSON name search over systems/constellations/regions) is shared; `search.js` wires it into the classic pages, and `gpusystem.js` has its own client for it.

## Setup, running, checking

- DB connection: copy `db.inc.php.example` to `db.inc.php`. `db.inc.php` holds real credentials and is gitignored — never stage it.
- On this server the pages run at `https://localhost/starmap/…` (the `fuzzwork` vhost). Plain `http://localhost` hits a default vhost that serves PHP **source**, not output.
- Syntax checks (the only automated checking available):
  - `php -l <file>.php`
  - `node --check --input-type=module < gpusystem.js` (same for `gpusystem-render.js`)
- Exercise the data endpoint from the CLI: `php -r '$_GET=["system"=>"30000142"]; include "gpusystem-data.php";'` (or `$_GET=["sky"=>"1"]`).
- The repo is owned by `www-data`, so git reports "dubious ownership"; use `git -c safe.directory="$PWD" …` rather than changing global config.

### Visually testing the WebGPU viewer headlessly

Chromium works with `--enable-unsafe-webgpu --enable-features=Vulkan --use-angle=swiftshader --use-webgpu-adapter=swiftshader --ignore-certificate-errors`, but **headless screenshots do not capture the WebGPU canvas** (it comes out blank/white even when rendering works). To see frames, read the canvas texture back: before page load, patch `GPUCanvasContext.prototype.configure` to add `COPY_SRC` usage, patch `getCurrentTexture` to remember the texture, and after a `GPUQueue.submit` copy it to a `MAP_READ` buffer and turn it into a PNG. Also listen for the device's `uncapturederror` event — validation errors are otherwise silent. SwiftShader runs at ~10-20 fps.

## WebGPU viewer architecture

**Precision model (the core invariant).** Everything is in real SDE metres as float64 in JS. Every frame, positions are made camera-relative in float64 *before* being written to float32 GPU buffers; the view matrix is rotation-only. Never upload absolute system coordinates — a 10km station next to the camera would be quantised to ~1e6 m steps.

**Depth.** Reversed-Z with an infinite far plane: depth clears to `0`, compares are `greater`/`greater-equal`, near = 1 m. Anything writing depth must follow that convention.

**Passes** (`Renderer.render`, one 4x MSAA target):
0. *Nebula* (optional) — fullscreen procedural backdrop, no depth; domain-warped noise on the world-space view direction, weighted by the star catalogue's SH (`skyDensity`), palette seeded per region in `applyNebula`.
1. *Spheres* — ray-traced impostors (star, planets, moons). A camera-facing quad, or a fullscreen quad when within 3 radii, whose fragment shader intersects the ray analytically and writes `frag_depth`. Uses the miss-distance form of ray/sphere intersection because `b*b - c` cancels to garbage in f32. Surface style per `kind` in `shade()`.
2. *Meshes* — instanced triangle geometry for stations (dodecahedron), stargates (torus, axis pointed at the destination system) and asteroid-belt rocks; one draw per mesh via `firstInstance`. Geometry is built in `gpusystem.js` (`buildDodecahedron`, `buildTorus`, `buildRock`) and must be CCW-outward (back-face culling is on). `pushTri` fixes winding using the centroid, which only works for star-shaped meshes — the torus writes its own winding.
3. *Lines* — orbit rings (line-list).
4. *Markers* — screen-space sprites: LOD stand-ins, sun glow, background sky stars, plus an always-on-top overlay pipeline for selection/hover. The vertex shader divides clip by `w` itself: sky stars sit at `w≈1e20`, which breaks perspective-correct interpolation otherwise. Sphere impostor quads scale clip by `1/d` for the same reason.

**Keep these in sync when changing buffer layouts:** the WGSL `Frame` struct ↔ the float offsets written in `Renderer.setFrame` (including SH sky light at 56–64, `skyLight` 68–71, `sunRel` 72–74, `nebulaA` 76–79, `nebulaB` 80–83) ↔ the buffer size in the constructor. Likewise each WGSL instance struct ↔ `SPHERE_FLOATS`/`MARKER_FLOATS`/`MESH_FLOATS`/`LINE_FLOATS` ↔ the `put*`/`write*` writers in `gpusystem.js` (vec3 + f32 pack into 16 bytes).

**Per-frame flow** (`frame()` in `gpusystem.js`): movement/warp → collisions → `computeView` → `updateLod` → `writeSpheres`/`writeMeshes`/`writeMarkers`/`writeRings` → `setSun`/`setFrame` → `render` → `updateLabels` (DOM label pool with priority-based declutter).

**LOD rules** (constants at the top of `gpusystem.js`): a body gets real geometry once it covers `SPHERE_MIN_PX`; below `MARKER_MAX_PX` it gets a marker only if it is navigational (star, planet, gate) or, for moons/stations/belts, once it is `CHILD_MARKER_SEP_PX` apart from its parent on screen; labels use a stricter separation and are hidden behind nearer bodies; noise octaves scale with on-screen size; ring segment counts scale with projected size; belt rock fields are generated lazily (seeded by belt `itemID`) once the field spans `ROCKFIELD_MIN_PX`, then each rock is culled below `ROCK_MIN_PX`. The status bar shows live LOD counts.

**Sky light.** The background sky is the real k-space catalogue (`gpusystem-data.php?sky=1`). The same catalogue is projected into 9 L2 spherical-harmonic coefficients (`buildSkyLight`) and evaluated per normal (`skyIrradiance` in the shared WGSL) as ambient light on the night side of bodies.

**Ship model.** The optional flyable Rifter loads `models/rifter.json` + `.bin` (Deamos' CC BY 4.0 STL, converted by `tools/stl-to-mesh.py`; the attribution in `models/README.md` and the help panel must stay if the model is kept). The `MSH1` format is documented in the converter. `--axes` must be a proper rotation or the winding flips, and engine positions are hand-placed in STL coordinates because STLs have no parts. `buildRifter()` is the procedural fallback if the files can't be loaded.

**Navigation.** `flyTo` interpolates distance-to-target in log space so any trip takes a few seconds; stargate jumps (`jumpThrough`) load the destination system in-page, place the camera at the matching arrival gate (`dest.gateId`) and `pushState` the URL.

## SDE data facts this code relies on

- `mapDenormalize` positions are metres relative to the system's star; `mapSolarSystems` x/y/z are galactic metres (used only for the sky and gate directions).
- Stations and stargates have **no radius** in the SDE — they use nominal display sizes (`NOMINAL_RADIUS`) and the UI labels them as such. Asteroid belts are a single point; their `radius` is not a body size, and the rock fields are procedural.
- `mapCelestialStatistics` covers suns, planets, moons and belts only (its own `radius` column is empty). Units checked against each other: `orbitPeriod`/`rotationRate` in seconds, `surfaceGravity` m/s², `escapeVelocity` m/s, `density` kg/m³, `massDust` kg. `luminosity`, `pressure` and `age` units are unverified, so they are shown without units or omitted.
- `orbitRadius` equals the body's *current* distance from its parent, not a semi-major axis.
- The SDE has **no orbital orientation** (no inclination/node/periapsis), and the game client doesn't store one either. `clientOrbitBasis` reproduces the client's own ring construction (as reported from `SystemMapSvc.Add3DCircle` / `OrbitCircle`; client source not available here): a circle of radius |body − parent| in the XZ plane, rotated by the shortest-arc quaternion from (−1, 0, 0) to normalize(body − parent). Its tilts are a side effect of that convention, largest for bodies on the parent's +X side; checked against an in-game screenshot of Augnais, where VIII (18°) and X (15°, opposite lean) are the visibly tilted orbits. Rings are circles even though `eccentricity` exists — the client does the same. Reading `eccentricity` as a tilt was tried and doesn't match.
