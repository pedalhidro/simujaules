# Simujaules (sampasimu)

> **Simujaules** is a deliberate, affective respelling of *joules* — only the
> branding and hostname; internal code identifiers and the legacy vocab path
> keep the old `simujoules` spelling.

A static-site, build-step-free PWA that computes asymmetric-cost cycling
**energy fields** over digital elevation models (DEMs). Load a GeoTIFF DEM (or
pull FABDEM tiles for the current map view), click anchor points, and it renders
the minimum energy to ride from/to/round-trip every cell — via Dijkstra on an
8-connected grid. Everything runs client-side in Web Workers; no account, no
upload, the DEM never leaves the machine. UI in Brazilian Portuguese and
English. Originally a port of a QGIS Processing algorithm.

Live app: <https://simujaules.pedalhidrografi.co/> (PWA, works offline after
first load).

## What it computes

- **Energy field** — for every DEM cell, the minimum energy (kJ) to ride from
  (or to, or round-trip via) an anchor. The cost model (v2) is derived from
  physical inputs — total rider+bike mass (default m = 75 kg), rolling
  resistance Crr, drag area CdA, air density ρ, drivetrain efficiency k_eff,
  cruise power on the flat P_flat, a climb-grade threshold (~2%), and smoothing
  knobs — folded once into a kJ-unit coefficient bundle
  `{aRoll, aAero, β, climbThr, abRatio, ε-offset}`. Cost of moving between
  adjacent cells with height difference Δh over ground distance d:
  - uphill/flat: `aRoll·d + aAero·d + β·Δh` — the aero term is dropped at/above
    the climb threshold; `β = m·g/k_eff/1000 ≈ 0.76 kJ/m` at defaults.
  - downhill: `max(0, aRoll·d + aAero·d − ε·β·|Δh|)` with
    `ε = clamp01(min(1, abRatio·d/|Δh|) − 0.13)` — gentle grades recover most
    of the resistive cost, steep ones none.
  - The canonical derivation lives in the external *bicycling-energy-model*
    notes; `energy-worker.js`'s header + `app.js` `readCost()` are the in-repo
    reference.
- **Passes count** ("natural corridors") — for each cell, how many optimal paths
  traverse it (subtree size in the shortest-path tree). Highlights the terrain's
  natural highways. Round-trip mode counts only within-budget trajectories.
- **Top-N alternative routes** between two points, via iterative penalisation
  (per-cell / linear / quadratic repulsion) so alternatives genuinely diverge.
- **Multi-reference density** — passes counts summed over K reference points
  (clicked, or sampled pseudo-/quasi-randomly via Sobol or Halton sequences),
  normalised to a density field; magnitudes grow ~linearly with K, so compare
  runs only at matching K. Under an energy budget, cells outside it never
  settle and the field truncates at the frontier (a saturation/border bias,
  sharper on small DEMs or tight budgets); on an exact cost tie between two
  candidate paths, which one accrues the pass is a search-order artifact of
  the heap, not a physical preference. Runs on a multi-core **worker pool**
  (sized by cores + memory); an optional native Rust backend accelerates
  large runs.
- **Energy budgets** — prune the search at a maximum energy; in round-trip mode,
  cap each leg or the out-plus-back total.
- **Maximize mode** — invert the optimisation to find the most *expensive*
  routes, optionally length-constrained (layered dynamic programming).
- **Graph mode** ("follow the vectors") — compute on an OSM-derived street graph
  instead of the raster grid, honouring bridges/tunnels by layer; can run a
  full-DEM unconstrained scenario alongside it and expose the difference (the
  cost of being restricted to the network).

## Inputs and outputs

- **DEM** — georeferenced GeoTIFF (EPSG:4326 recommended), the built-in FABDEM
  viewport loader (fetches 30 m global elevation for the visible area), or one of
  the bundled São Paulo example DEMs in `dem/`.
- **Optional network constraint** — GeoPackage (`.gpkg`) line layers, rasterised
  onto the DEM grid (read in-browser via sql.js). Analysis can be confined to the
  network, with IDW interpolation for off-network cells. An OSM water mask can
  mark impassable areas (areas, sea, rivers).
- **Outputs** — a reproducible bundle (`.zip`) of georeferenced GeoTIFFs
  (`energy.tif` f32, `passes.tif` f64, `network.tif` u8), route/path GeoJSON, and
  a `metadata.jsonld` capturing every parameter (vocabulary in
  [`vocab/simujoules.jsonld`](vocab/simujoules.jsonld)). Rendered map layers
  export as PNG + world file. Everything opens directly in QGIS.

## Layout

- `index.html` — page shell, panel UI, map container, help/changelog modal.
- `app.js` — all UI: DEM/GeoPackage loading (geotiff.js, sql.js), Leaflet map,
  compute dispatch, rendering, i18n (`STRINGS` table + `t()`), bundle
  export/import.
- `energy-worker.js` — the compute engine (Web Worker): Dijkstra, A\* top-N,
  multi-ref density, layered-DP max-cost path, IDW network fill. Pure JS on typed
  arrays. **This is the reference implementation** the Rust backend must mirror.
- `graph-engine.js` — the graph-mode engine (OSM vector graph).
- `sw.js`, `manifest.webmanifest`, `icons/` — the PWA shell.
- `backend/` — optional native compute server (Rust + rayon). Off by default; see
  [backend/README.md](backend/README.md).
- `deploy.sh` — stages and rsyncs the deployable files to `gs://simujaules`.
- `test-*.mjs`, `backend/test-backend.mjs` — the node test suites (see below).
- `dem/`, `fabdem/`, `vocab/` — example DEMs, the FABDEM fetcher, and the
  export vocabulary. (The original QGIS plugins this was ported from have
  been removed — superseded by `energy-worker.js`'s v2 engine.)

## Running

It's a static site. From the project directory:

    python3 -m http.server 8000

Then open <http://localhost:8000>. (Workers need to be served over HTTP, not
opened from `file://`.) No build step, no API keys (unless you swap in a paid
basemap).

## Optional native backend

The app is fully functional without it — compute runs use the in-browser worker
pool. The optional native backend just accelerates the heaviest runs (~2–4×
faster per Dijkstra, and rayon uses all cores → roughly 3–10× for multi-reference
density). It's **off by default**:

    cd backend
    cargo run --release            # binds 127.0.0.1:8077

Then tick **Use native backend** in the app's parameters panel (URL defaults to
`http://127.0.0.1:8077`). The app falls back to the browser workers automatically
if the server isn't reachable. It accelerates `POST /density` (multi-reference)
and `POST /single` (single-source field); top-N, the destination path, and
maximize stay browser-only. Memory-budget tuning, the binary protocol, and the
`energy-worker.js` parity contract are in [backend/README.md](backend/README.md).

> The old in-page **wasm** engine was removed — native compute now lives in the
> standalone Rust server above, and the browser engine is always JS.

## Deploy

For the production target (`gs://simujaules`, served at
`https://simujaules.pedalhidrografi.co/`):

    ./deploy.sh

The script (no arguments) stages just the deployable files — skipping the Rust
source, QGIS plugins, and test harnesses — and rsyncs them with `gcloud storage`
(not `gsutil`). `simujaules.pedalhidrografi.co` is fronted by **Cloudflare**
(origin = the GCS bucket directly, NOT Google Cloud CDN), so cache invalidation
is a Cloudflare purge: set `CF_API_TOKEN` (Zone › Cache Purge) and `CF_ZONE_ID`
to enable it (skipped if unset). See the header comment in `deploy.sh` for the
Cloudflare cache-rule gotcha around `sw.js`.

For any other static host (GitHub/Cloudflare Pages, S3 + CloudFront, Netlify,
etc.) drop the same set of files manually. No backend required.

## Verification & tests

There is no CI; run these before committing engine changes:

    node test-worker-pool.mjs                 # worker regression suite
    node test-water-raster.mjs                # OSM water-mask rasterisation
    node test-graph-engine.mjs                # graph-mode engine
    cd backend && cargo build --release && node test-backend.mjs   # JS↔Rust parity

`backend/src/main.rs` is a line-for-line port of `energy-worker.js`'s cost model
and density math — `test-backend.mjs` enforces energy bit-parity (passes may
differ only on exact f64 cost ties). Likewise `test-water-raster.mjs` holds pure
mirrors of `app.js`'s OSM water-mask helpers (app.js can't be imported in node).
Keep the mirrors in sync — a change to one engine must land in the other.

Per the project convention, bump `sw.js` `VERSION` (with a changelog line in
`CHANGELOG.md`, the help modal, and the `sw.js` history comment) on every deploy
that changes app behaviour.

## Known limitations

- **CRS.** EPSG:4326 is recommended; horizontal distances are taken from the
  geographic grid. Projected DEMs render but some features (e.g. the OSM bridge
  pull) are guarded off on them, since lon/lat would map to garbage cells. To
  make a test EPSG:4326 DEM:

      gdalwarp -t_srs EPSG:4326 -tr 0.0003 0.0003 input.tif test_dem.tif

  (`-tr` is the pixel size in degrees; ~30 m near the equator.)
- **Web Mercator overlay.** The energy field is drawn in the DEM's CRS, so on a
  Web Mercator basemap there's mild distortion away from the equator (negligible
  at cycling-scale extents).
- **Memory at scale.** Very large DEMs (tens of millions of cells) are bounded by
  RAM both in the browser pool and the native backend — both cap concurrency to a
  memory budget rather than OOM-crashing (fewer parallel slices, same output).

## Performance

On a 333×333 DEM (10×10 km at 30 m) the JS engine runs a single Dijkstra in
roughly 200–400 ms on a modern laptop; round trip ~2×. The browser worker pool
parallelises multi-reference density across cores; the native backend adds
another ~2–4× per Dijkstra (Rust release, fat LTO) and saturates all cores. For
huge DEMs (e.g. the 135 M-cell case) memory, not CPU, is the ceiling — see
[backend/README.md](backend/README.md) and `docs/runtime_estimate.md` for the
slice/memory model and the in-app run-time estimator.
