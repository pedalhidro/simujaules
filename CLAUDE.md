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
- Multi-reference density: a POOL of workers, `min(cores − 1, K, memory
  cap)`; each gets `densityPartial: true` and returns raw accumulators
  (density, energySum, energyCount) that `app.js` merges and normalises.
  The optional network IDW fill runs AFTER the merge as a separate
  `kind: "interp"` worker message — never per-slice.
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
