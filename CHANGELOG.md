# Changelog

Versions track the service-worker `VERSION` in `sw.js` (bumped on every
deploy that changes app behaviour). Keep this file, the collapsed Changelog
section in the help modal (`index.html`), and the `sw.js` version-history
comment in sync — update all three with every release.

Backfill note: v1–v11 entries were reconstructed from the `sw.js` version
history and git log on 2026-06-12; v4–v10 shipped between 2026-05-08 and
2026-05-13 without individually recorded dates.

## v14 — 2026-06-19 (unreleased)

### Fixes

- Compute-time estimate is now accurate to ~±20% with no systematic bias
  (was up to ~3× low). Two independent errors were found by benchmarking
  estimate-vs-actual across DEMs (sampa_geral/centro/aguapreta), budgets,
  modes, and engines:
  - **Backend density on a large DEM under-estimated ~3×.** The estimate
    assumed parallelism scaled with cores (`min(refs, cores, 8)`), but the
    backend caps concurrent rayon slices to a *memory* budget — each slice
    holds full-grid scratch (~5 GB on the 135 M-cell DEM), so only 1-2 fit
    regardless of core count. It also used a native-speedup constant ~2× too
    low. The backend estimate now replicates the slice cap
    (`min(refs, cores, mem_budget / per_slice)`) — `GET /health` reports
    `mem_budget_bytes` — plus a bandwidth-contention term and a corrected
    nominal speedup.
  - **Small DEMs under-estimated up to ~3.8× at low budgets.** The probe ran
    at a fixed energy budget that *saturated* small grids (explored = the
    whole DEM), so the budget→explored extrapolation was anchored at a
    meaningless point. The calibration probe now caps by settled-cell count
    instead — bounding its wall time to ≤~1.5 s on any DEM (the responsiveness
    target) while always anchoring at an unsaturated point, with the explored
    and per-ref laws scaled from there.
  - An **online correction** now learns actual/predicted per engine from each
    completed compute (EMA), so the estimate converges to this machine and
    server's reality within a run or two — covering the residual the
    inherently server-dependent backend factor can't be predicted a priori.

## v13 — 2026-06-18 (unreleased)

### Features

- "Follow the vectors" network-graph mode (new `graph-engine.js`). When a
  vector network is loaded, the optional *Compute on network graph* toggle
  routes on the real polyline graph instead of the rasterised mask, so
  passes/paths trace the vectors with no staircase, corner-cutting, or
  width-fattening. The network is planarised with a selectable junction mode
  — *also at crossings* (splits segments at intersections so at-grade
  crossings route) or *only shared endpoints* (connects solely where lines
  share a vertex, preserving bridges/overpasses). Edge costs reuse the exact
  asymmetric energy model, sampled along the true geometry over the DEM
  (bit-parity with the grid step asserted in `test-graph-engine.mjs`). All
  compute modes are supported (from/to, round, top-N routes, maximize,
  multi-reference density), results render as a colored-vector overlay, and
  style-knob changes recolor without recomputing. JS-only — the Rust backend
  is untouched.

## v12 — 2026-06-12 (unreleased)

### Performance

- Multi-reference density runs split across a worker pool
  (`min(cores − 1, K, memory cap)`) — near-linear speedup, merged on the
  main thread. Combined with Dijkstra heap optimisations (hole-sifting,
  zero-allocation pops, flat-index neighbour deltas): ~10× on typical
  8-core density runs, bit-identical outputs.
- Optional native Rust backend (`backend/`, **off by default**): density
  runs on all cores via rayon, radix-heap Dijkstra, scratch-buffer reuse,
  ~7× over the sequential JS path; automatic fallback to browser workers.
- Compute-time estimate is now budget- and engine-aware. It was assuming a
  full-grid Dijkstra at a fixed rate, so changing the energy budget didn't
  move it at all (off by ~3-18× on huge DEMs). A one-shot calibration probe
  at DEM load now learns this terrain's real per-cell rate and
  budget→explored relationship; the live estimate scales with the budget
  (explored ∝ (eMax/alpha)²), divides by the density worker-pool size, and
  reflects the native backend when enabled. Shows "estimating…" until the
  probe lands.
- Density compute engine rewritten (`densityField` in `energy-worker.js`):
  one reused scratch set with targeted reset/accumulate over only the
  explored cells (an energy budget makes that a small fraction of the
  grid), and an exact monotone **radix heap** matching the native
  backend's queue. On the 135 M-cell `sampa_geral` DEM (5 refs, budget
  150) this brings the in-browser density run to within ~15-20% of the
  native Rust backend's compute time — both are memory-bandwidth-bound at
  that size, so the residual is the JS-vs-native floor. Like the backend,
  the radix heap settles in exact cost order except on genuine f64 cost
  ties (either equal-cost parent is a valid optimum); the browser density
  field now matches the backend's tie behaviour rather than the old binary
  heap's.
- Density scales to large workloads without crashing. Browser: density
  workers are leaner (passes + density f32, energySum stays f64), and the
  pool memory cap now budgets against `navigator.deviceMemory` with an
  accurate per-worker estimate — so medium DEMs parallelise where they
  couldn't before. A 135 M-cell DEM still runs single-threaded on 16 GB
  (two workers can't fit; `deviceMemory` caps at 8 GB so we can't detect
  bigger machines) — an optional "Max compute workers" override lets users
  who know they have the RAM force parallelism. Backend: it no longer
  OOM-crashes at high ref counts — concurrent rayon slices are capped to a
  memory budget (auto-detected, or `SIMU_MAX_MEM_GB` / `--max-mem-gb` /
  `RAYON_NUM_THREADS`); fewer slices just run more refs serially. Scratch
  `passes` is f32 (parity-safe).

### Features

- Quasi-Monte-Carlo sampling option (Sobol / Halton) for "Place random"
  reference placement; sequences continue across clicks.
- Round-trip budget mode: energy budget can cap each leg (old behaviour,
  default) or the round-trip total ("Budget applies to" select).
- Round-mode passes are filtered: only completable (in-budget, displayed)
  destinations count as trajectory endpoints.
- "Energy color" passes blend mode: corridor hue from the energy field's
  colormap, opacity from the passes intensity (min/max/γ shape the alpha).
- Optional vector-network rendering: black lines at a configurable ground
  width (default 4 m, zoom-compensated) with an opacity slider,
  canvas-rendered, 2 M-vertex safety cap. Layers stack deterministically
  via dedicated panes (default relief < energy < network < passes <
  routes), user-reorderable via the "Layer stacking order" modal
  (persisted per device).
- "Constrain compute to network" toggle — keep a network loaded (and
  drawn) without restricting the search graph.
- Basemap selector: OSM, Carto minimalist dark/light (no labels), or
  solid black / white / gray with no tiles.
- "Export rendered images": zips the displayed energy/passes PNGs with
  world files (.pgw/.prj) — styled layers drop into QGIS georeferenced.
- "Pull streets from OSM": queries Overpass for highway=* over the
  current map view ∩ DEM extent and rasterises the ways as the network —
  no .gpkg needed.
- "Compare with unconstrained": with a constraining network, Compute runs
  both scenarios in parallel and a selector switches the energy layer
  between constrained / unconstrained / difference (the energy cost of
  the network).
- Changelog section in the help modal (collapsed by default).
- SEO/LLM metadata: meta description, canonical URL, Open Graph/Twitter
  cards, schema.org WebApplication JSON-LD, noscript summary, llms.txt,
  sitemap.xml; lang attribute fixed to pt-BR (matches default content).
  deploy.sh ships llms.txt, sitemap.xml and CHANGELOG.md.

- Network interpolation is much faster: an integer chamfer prefilter
  skips cells provably beyond any ray's reach (~4× on networks smaller
  than the DEM), and the fill runs banded across the worker pool
  (~×cores). Outputs stay bit-identical. Smoothing runs as a single
  post-merge pass.
- Scenario comparison extended: passes are computed for both scenarios
  (signed difference shows corridors the network creates), and the
  comparison also works in multi-reference density mode (two sequential
  runs splitting the progress bar, browser pool or native backend). The
  selector now switches energy AND passes together. In "difference" mode
  the passes layer overlays both scenarios — constrained light red,
  unconstrained light green, additively blended (overlap sums to a soft
  yellow, coincident corridors brighten). The channels share one scale by
  default; a green-channel sub-panel (min/max/γ/mean filter, blank =
  inherit red) lets each be tuned independently. The energy difference is analysed on network cells and then
  interpolated across the grid like the constrained field (when interp is
  on).

### Fixes

- PWA manifest restored (deleted in the v11 commit; broke deploys, blocked
  every future service-worker install, and PWA install).
- Service worker: synchronous `Response.clone()` (intermittent cache-write
  failures), `event.waitUntil` on background cache writes, 5xx navigation
  fallback to the cached shell, maskable icons precached.
- CDN libraries get SRI hashes + `crossorigin` — also makes them
  runtime-cacheable, fixing offline mode.
- GeoPackage parser handles ISO Z/M geometry types (1002 etc.) — 3-D
  .gpkg files no longer rasterise to an empty network.
- Stale-result race fixed: loading a DEM/network mid-compute cancels
  in-flight workers (generation counter) instead of rendering old arrays
  onto the new grid.
- Worker crash/load failure now surfaces an error instead of leaving the
  UI stuck on "Computing…".
- User-derived strings escaped before status-bar HTML interpolation.
- Native-backend runs: liveness ticker (elapsed time) while the server
  computes; errors after a successful response surface instead of
  silently recomputing in the browser; response parsed zero-copy (the
  backend 8-byte-aligns its payload); the post-merge network
  interpolation phase shows status + progress (it previously looked like
  a hang on large DEMs).
- Density mode + constraining network: Compute used to abort silently —
  the compute-time network re-snap treated the (always-null in density
  mode) src point as a snap failure and returned before dispatching any
  work. src/dst are now only re-snapped when set; density reference
  points get their own re-snap onto the network (markers follow), and
  "Place random" samples are snapped to the network at placement time.
- Network snap no longer dead-ends: clicks snap to the nearest network
  cell grid-wide (expanding-ring search) instead of being rejected beyond
  the snap-radius input — on sparse networks every click used to fail,
  leaving Compute permanently disabled. Networks that rasterise to 0 cells
  (CRS/geometry mismatch) are rejected loudly instead of silently bricking
  clicks; the GeoPackage geometry column name is now read from
  gpkg_geometry_columns instead of being hardcoded to "geom".
- Bundle-before-DEM order now works: a bundle loaded without (or against
  the wrong) DEM is held as pending — rasters included — and re-applied
  automatically when a DEM with matching dimensions is loaded. Previously
  the DEM load wiped the restored src/dst/ref points and the bundle's
  rasters were lost.
- Density-mode map clicks no longer silently set src/dst when placement
  is "random"; "Refresh style" button no longer loses its PT translation;
  deploy.sh staging-dir leak and GNU-cp portability fixed.

## v11 — 2026-05-13

- Wasm engine removed — JS worker is the only compute engine.
- Fix layered-DP backtrack direction bug (spurious `backtrack_fail`).
- Fix ReferenceError on `autoMax`/`passesMax` in result metadata.

## v8–v10 — 2026-05

- Reverse-optimisation toggle (maximize energy): edge costs inverted
  against a precomputed `MAX_EDGE_COST`.
- Length-constrained max-cost path via layered DP (exactly L edges,
  memory-capped).
- DP failures (unreachable, memory cap) surfaced in the UI via warning
  messages.

## v4–v7 — 2026-05

- DEM relief layer: cmocean.phase elevation × slope hillshade.
- Locate-me button; mobile drawer refinements.
- OOM fixes for 100 M-cell DEMs: reservoir-sampled percentiles,
  stride-downsampled relief canvas, slope buffer dropped after render.
- Same OOM fix applied to the energy/passes renderer; skip relief on
  non-geographic DEMs; harden localStorage for iOS private browsing.

## v1–v3 — 2026-05-08

- First public shell: GeoTIFF DEM loading (geotiff.js 3.x), asymmetric-cost
  8-connected Dijkstra energy fields (α/β/η model), passes count, top-N
  routes with repulsion modes, multi-reference density, vector-network
  constraint (.gpkg via sql.js), GDAL-style IDW fill, bundle export
  (georeferenced GeoTIFFs + JSON-LD metadata), PT/EN i18n, FABDEM viewport
  loader, PWA shell with offline precache.
