# Simujoules (sampasimu)

Static, build-step-free PWA that computes asymmetric-cost cycling energy
fields over DEMs (Dijkstra variants on an 8-connected grid), plus an
optional native Rust backend. No package.json, no bundler — `index.html`
loads `app.js` directly and libraries come from CDNs with SRI hashes.

## Layout

- `app.js` — all UI: DEM/GeoPackage loading, Leaflet map, compute dispatch,
  rendering, i18n (PT/EN `STRINGS` table + `t()`), bundle export/import.
- `energy-worker.js` — the compute engine (Web Worker): Dijkstra with
  passes count, A* top-N routes, multi-ref density, layered-DP max-cost
  path, IDW network fill. Pure JS on typed arrays.
- `backend/` — optional native density server (Rust + rayon, see its
  README). OFF by default; the app's "Use native backend" checkbox lives in
  the density panel and falls back to browser workers on any failure.
- `sw.js` — service worker (precache + runtime cache). `index.html`,
  `manifest.webmanifest`, `icons/` are the PWA shell.
- `deploy.sh` — stages and rsyncs to `gs://telhas/simujoules` (GCS + Cloud
  CDN). Only explicitly listed files ship; backend/ and tests never deploy.
- `test-worker-pool.mjs` — run with `node`; self-contained worker
  regression test (invariants + pooled-density ≡ single-run equivalence).
- `backend/test-backend.mjs` — starts the release binary and compares its
  output against `energy-worker.js`. (`test-features.js` / `test-worker.js`
  are legacy, depend on a missing `/tmp/dem.bin`, and assert nothing.)

## Compute architecture

- Regular runs (from/to/round, top-N, maximize): ONE worker per compute.
- Multi-reference density: a POOL of workers sized by the shared
  `densityPoolSize()` helper — `min(K, cores−1, memCap)`, where memCap
  budgets each worker (~38 B/cell, ~55 round) against `navigator.deviceMemory`
  (the spec caps it at 8 GB). A `#max-workers` input overrides this (clamped
  by K) for users on big-RAM machines deviceMemory can't see. Each worker
  gets `densityPartial: true` and returns raw accumulators (density,
  energySum, energyCount) that `app.js` merges and normalises. On a 135 M-cell
  DEM this is 1 worker (two won't fit 16 GB) — the honest ceiling. The
  optional network IDW fill runs AFTER the merge as a separate
  `kind: "interp"` worker message — never per-slice.
- `densityPoolSize()` is shared by the runner AND `estimateRunTime()` — they
  must not drift.
- `estimateRunTime()` is calibrated per-DEM: `startCalibrationProbe()` runs a
  `kind: "probe"` worker at DEM load. The probe does PROBE_REFS spread-ref
  searches CAPPED by settled-cell count (`maxSettled`), NOT by energy budget —
  this bounds the probe to ≤~1.5 s on any DEM (responsiveness target) AND
  anchors at an UNSATURATED point (`Estar` cells at budget `bStar`,
  `perRefProbe` ms). Anchoring unsaturated is load-bearing: the old fixed-budget
  probe saturated small DEMs (E0=N) and under-estimated up to 3.8×. The estimate
  scales from the anchor: `explored = min(N, Estar·(eMax·αprobe/(bStar·α))^EXPLORE_EXP)`,
  `perRef = perRefProbe·(explored/Estar)^RATE_EXP`, then ÷ pool size (browser)
  or the backend slice model. `predictComputeMs()` is the single predictor
  shared by the live estimate AND the online correction (must not drift).
  Probe is generation-guarded (`state.calibrationGen`, bumped per DEM load) and
  skipped while a compute runs.
- The backend estimate must replicate the backend's MEMORY-bounded slice cap
  (`min(refs, cores, mem_budget/per_slice)`, per_slice = 37·N or 55·N round),
  NOT `min(refs, cores)` — on a huge DEM only 1-2 slices fit, so assuming
  cores-many parallelism under-estimates ~3-8×. `/health` reports
  `mem_budget_bytes` for this; `BACKEND_BYTES_PER_CELL{,_ROUND}` mirror
  `backend/src/main.rs`'s `per_slice` (keep in sync). `NATIVE_SPEEDUP` is a
  nominal constant (native vs JS converge toward bandwidth-bound on huge
  frontiers); the per-engine online correction (`corrBrowser`/`corrBackend`,
  EMA of actual/predicted from completed computes, snapshotted in
  `state.lastRun` at run start and applied in `computeDone`) absorbs the
  residual scale/server-dependence — that's what guarantees ±20% in steady
  state. `maxSettled` in `densityField` is probe-only (0 = normal path,
  zero-cost) — don't let it leak into a real run's cost.
- Every run captures `state.computeGen`; `cancelActiveCompute()` bumps it
  and terminates `state.workers`. It must be called before anything that
  changes the grid a result renders against (DEM load, network load/clear).
  Worker callbacks drop messages whose generation doesn't match.

## Invariants — easy to break, hard to notice

- `backend/src/main.rs` is a PORT of `energy-worker.js` `dijkstra()`
  (cost model, f32 energy storage, settled-flag handling, passes
  accumulation, density normalisation). Any change to one must land in the
  other; `node backend/test-backend.mjs` enforces energy bit-parity.
  Backend passes may differ from JS only on EXACT f64 cost ties (radix heap
  vs binary heap tie order) — both trees are valid optima.
- BRIDGE PORTAL EDGES (OSM bridges/tunnels, group 1d) are relaxed ALONGSIDE
  the 8-connected grid edges in `dijkstra`, `densityField` and the Rust
  `dijkstra_tree`: a directed shortcut between a bridge's two abutment cells at
  the flat-deck cost (`alpha*deckLenM + beta*dh`, downhill-clamped; `reverse`
  uses the opposite direction's cost). The cells UNDER a deck are never
  touched, so over- and under-bridge routes coexist on the 2.5-D grid. Portal
  costs are derived from the same shared inputs (deck length, endpoint heights
  widened f32→f64, params) in JS (`buildPortalAdj`) and Rust (`build_portals`),
  so they stay bit-parity — `test-backend.mjs` has `+portals` cases. Per-cell
  portal iteration order (JS Map vs Rust HashMap) must match insertion order so
  exact-tie passes agree. App-side, `buildPortals()` packs `state.bridges` into
  portalU/V/lenM, threaded via `baseMsg` (CLONED, never transferred — shared
  across the density pool) and appended to the backend Blob (`nPortals`). A*
  top-N, the max-cost DP path, AND maximize mode do NOT use portals (admissible
  heuristic; and a long deck cost would invert against the single-grid-edge
  `maxEdgeCost` to a clamped-0 free shortcut). The OSM bridge pull is refused on
  a projected DEM (`isGeographic` guard) — lon/lat would map to garbage cells.
- GRAPH MODE bridges are SEPARATE from the raster portals: graph mode is
  portal-blind. Instead, the OSM streets pull captures per-way `{deck, layer}`
  into `state.networkLinesMeta` (parallel to `networkLines`, null for .gpkg),
  threaded into `graphBuild` as `opts.lineMeta`. `graph-engine.js` then (a)
  suppresses a crossing junction when a deck crosses a way at a different
  `layer` (overpass), and (b) flattens deck edges' profiles to a straight line
  between the line's ground-endpoint elevations (arc-length interpolated). So
  `state.bridges` (the 1d pull) must NOT invalidate the cached graph, and
  `state.bridgesToken` is NOT in `computeNetworkGraphToken`.
- The backend bounds concurrent rayon slices by a memory budget
  (auto-detected, or `SIMU_MAX_MEM_GB` / `--max-mem-gb` / `RAYON_NUM_THREADS`)
  so high ref counts on huge DEMs don't OOM — fewer slices just run more refs
  serially (output identical). Its `Scratch.passes` is f32 (parity-safe:
  exact integers widen to the f64 `Acc`); do NOT make `Acc` f32 (breaks the
  `maxD < 1e-15` parity test).
- Multi-reference density does NOT go through `dijkstra()`: it uses the
  dedicated `densityField()` engine (one reused scratch set, targeted
  reset/accumulate over only the explored cells, and an exact monotone
  RADIX heap matching the backend's). It is the perf-critical path on
  huge DEMs — keep its cost model identical to `dijkstra()`. Its radix
  heap shares the backend's exact-except-on-f64-ties behaviour, so density
  passes match the backend (not the binary-heap single-point modes) on
  ties. The from/to single-point modes still use `dijkstra()` (binary
  heap); only density was switched. `densityField`'s `density` and `passes`
  are Float32 (memory), but `energySum` stays Float64 (energy is a large
  summed value — f32 there diverges ~1e-3 between pooled/single and breaks
  the energy tolerance); the `app.js` pool merge accumulators stay Float64.
- In the worker, `E` is Float32Array but heap priorities are f64: the
  `settled` byte array (not `g > E[idx]`) filters stale heap entries, and
  settled neighbours are never relaxed. Both guards exist because of the
  f32/f64 precision mismatch — removing either corrupts passes counts.
- `sw.js`: bump `VERSION` (with a changelog line) on every deploy that
  changes app behaviour; keep `PRECACHE_URLS` in sync with what
  `index.html`/`deploy.sh` actually reference — `cache.addAll` is atomic,
  one 404 blocks the SW install for every user.
- The changelog lives in THREE places that must move together with every
  release: `CHANGELOG.md`, the collapsed `<details id="changelog">` in the
  help modal (`index.html`), and the `sw.js` version-history comment.
  Update all three whenever you ship user-visible changes — don't let
  them drift.
- Every version bump (a new `VERSION` + the changelog trio) ships as its own
  git commit — always commit when pushing a new version. Author the release
  commit as Claude (the assistant) and credit the user as a contributor, e.g.
  `git commit --author="Claude <noreply@anthropic.com>"` with a trailer
  `Co-Authored-By: Danilo Lessa Bernardineli <danilo.lessa@gmail.com>`.
- CDN `<script>` tags in `index.html` carry SRI `integrity` +
  `crossorigin="anonymous"`. The crossorigin attribute is ALSO what makes
  responses non-opaque so `sw.js` can runtime-cache them for offline use —
  pin new lib versions with a fresh sha384 hash, don't drop the attributes.
- User-derived strings (error messages, bundle metadata) must go through
  `escapeHtml()` before any `status.innerHTML` interpolation.
- UI text goes through the `STRINGS` table / `data-i18n`; never hardcode
  display text in JS (it clobbers the PT translation).

## Testing & verification

```sh
node test-worker-pool.mjs                  # worker regression suite
cd backend && cargo build --release && node test-backend.mjs
```

There is no CI; run both before committing engine changes. Style knob
changes (colormap, ranges, gamma, blend) re-render cached arrays and must
never trigger a recompute.
