# Scope — an iOS app driven by the Rust backend (2026-09-20)

Feasibility scoping for a native iOS app whose compute engine is the existing
Rust backend (`backend/src/main.rs`). Nothing here has been built; this note
records what the codebase already gives us, what has to change, three viable
architectures, a phased plan, and the hard limits (memory, above all).

**Verdict: feasible.** The Rust compute core has no platform blockers — the
crate already type-checks for `aarch64-apple-ios` unmodified
(`cargo check --release --target aarch64-apple-ios` passes on the current
tree; the only noise is the `target-cpu=native` flag, see §3.2). The work is
(a) a small, mechanical crate split so the compute is a library and the HTTP
server is one consumer of it, (b) an iOS shell around it, and (c) deciding how
much of the browser-only functionality (routes, smoothing, GeoTIFF I/O,
rendering) the iOS app re-implements versus leaves to the web app.

---

## 1. What the Rust backend already provides (and what it doesn't)

`main.rs` is a single-file crate, ~1 750 lines, with a clean internal split:

| Layer | Items | iOS-usable as is? |
|---|---|---|
| Pure compute | `Cost`, `Params`, `Grid`, `Moves`/`build_moves`, `long_edge_cost`/`build_long_table`, `build_portals`, `RadixHeap`, `Scratch`, `dijkstra_tree`, `subtree_passes{,_f64}`, `stamp_long_passes_*`, `Acc`, `compute_density`, `compute_single` | **Yes** — std + rayon + serde only |
| Wire framing | `parse_grid_request`, `respond_binary`, gzip helpers, CORS, `MAX_BODY` | Not needed in-process (keep for the server build) |
| Host probing | `detect_total_mem_bytes` (reads `/proc/meminfo`, else **spawns `sysctl`**), `density_mem_budget_bytes` (env var `SIMU_MAX_MEM_GB`) | **No** — iOS forbids spawning processes and has no `/proc`; must become caller-supplied |
| Server | `main()`, `tiny_http` loop, `/health` idle clock | Optional (Option D below reuses it) |

It serves exactly two computations, both bit-parity with `energy-worker.js`
(`backend/test-backend.mjs` enforces it):

- **`compute_density`** — K-reference density: passes + mean energy fields,
  optional pairwise accessibility matrix, memory-bounded rayon slices.
- **`compute_single`** — from/to/round single-source energy field + optional
  f64 passes.

Both accept the full v57+ feature set: `nDirs` 4–128 with profile-integrated
long moves, bridge portal edges, a network mask, energy budgets (leg/total).

**What it does NOT do** — and therefore what an iOS app must either port,
drop, or delegate to the web app (CLAUDE.md: "the backend produces no
routes"):

| Browser-only capability | Where it lives | iOS options |
|---|---|---|
| Destination path (from → to polyline) | `energy-worker.js` `dijkstra()` parent walk | **Cheap:** expose `Scratch.parents` from `compute_single` and walk it in Rust — the tree is already built |
| Top-N alternative routes (A\*, penalisation) | `energy-worker.js` | Port later or drop (v1: drop) |
| Maximize mode, layered-DP max-cost path | `energy-worker.js` | Drop (research feature) |
| Post-hoc max-density segments (`maxseg`) | `energy-worker.js` | Drop |
| Graph mode (OSM vector graph) | `graph-engine.js` | Drop (needs the OSM pull too) |
| IDW network fill (`kind: "interp"`) | `energy-worker.js` | Port later (embarrassingly parallel, small) |
| String pulling | `energy-worker.js` | Drop for v1 |
| Calibration probe / run-time estimate | `energy-worker.js` + `app.js` | Replace with a simpler on-device estimate (single engine, known cores) |
| **DEM pre-smoothing** `smoothHeightsInPlace` (σ 30 m auto) | `app.js`, mirrored in `test-dem-smoothing.mjs` | **Must port** — heights must be smoothed before any engine sees them; a Rust port is a new hand-kept mirror and needs a byte-identity test (§3.4) |
| **Physics folding** `readCost` (`G_SP = 9.7864`) | `app.js`, mirrored in `census/census-density.mjs` | **Must port** — the Rust engine receives the derived bundle; the iOS app has to derive it. Adds one more `9.7864` hit to the grep list |
| GeoTIFF read (geotiff.js) / write | `app.js`, `census/census-density.mjs` | Port to Rust (`tiff` crate) or Swift; see §4 |
| GeoPackage network (sql.js) | `app.js` | Drop for v1 (rasterised mask could be imported from a bundle's `network.tif`) |
| OSM / FlatGeobuf pulls (streets, water, bridges), census sampler | `app.js` | Drop for v1; FGB-by-Range in Swift is feasible later |
| Rendering (colormaps, relief, Leaflet overlays) | `app.js` | Re-implement on MapKit (§4) |
| Bundle export/import (`.zip` + `metadata.jsonld`) | `app.js` (JSZip) | Import first (interoperability with the web app), export second |
| i18n (PT/EN `STRINGS`) | `app.js` | Standard iOS `Localizable.strings`; reuse the PT/EN copy |

The web app's own estimate of the split: `mcp/lib.mjs` is already a headless
driver of the engine "with no network / bridges / impassable layers" — the
iOS v1 surface is essentially that same subset, driven through Rust instead
of the JS worker.

---

## 2. Three architectures

### Option D — WKWebView shell + in-process Rust HTTP server (fastest to a working app)

Bundle the static site (`index.html`, `app.js`, `energy-worker.js`, …) inside
the app, serve it from a local scheme handler or the same loopback server, and
run the **existing `tiny_http` server** on a background thread bound to
`127.0.0.1:8077`. The web app's *Localhost* compute source then works
**unchanged**: `/health`, `/density`, `/single` byte-for-byte as today, with
app.js's automatic browser-worker fallback intact.

- **JS changes:** none required. Optional: default the compute source to
  Localhost when running under the shell, and hide the Cloud option.
- **Rust changes:** the memory-budget fix (§3.3) and the cargo-config fix
  (§3.2) only. Even the crate split is optional here.
- **Everything else** (top-N, maximize, graph mode, smoothing, GeoTIFF, OSM
  pulls, rendering, export) keeps working because it's still the web app —
  but the JS-side features run inside WKWebView's content process, which has
  its own (lower) memory ceiling than the app process. Density/single go
  native; the rest is exactly as on iOS Safari.
- **Gotchas:** WKWebView from `file://` can't spawn workers, so the app must
  be served over the loopback server or a `WKURLSchemeHandler` (custom
  scheme; `sw.js` won't register there — offline is inherent anyway). CDN
  `<script>` tags need bundling (keep the SRI attributes; vendor the files
  and rewrite the `src`, or let them load from the network on first run).
  The DEM crosses loopback HTTP as a few-hundred-MB copy per run — acceptable
  (it's what the desktop does). App Store guideline 4.2 ("minimum
  functionality") is a review risk for web wrappers; the native compute
  engine plus offline DEM handling is the defensible answer.
- **Effort:** weeks, not months. Mostly Xcode plumbing + a `cargo` build
  script producing an `.xcframework`.

### Option A — native SwiftUI app on an embedded Rust library (the "real" iOS app)

Split the crate into `simujoules-core` (lib: everything in the "pure compute"
row plus DEM I/O and smoothing) and the server binary. Expose the core to
Swift with **UniFFI** (typed Swift API, no hand-written C headers) or a small
C ABI; build `aarch64-apple-ios` + `aarch64-apple-ios-sim` and package an
`.xcframework`. The UI is SwiftUI + MapKit: load a DEM, tap source/refs, run,
overlay the field, read energy at a tap, import/export bundles.

- **Zero-copy in-process:** heights/mask stay in Rust-owned buffers; Swift
  only receives the rendered field (or a colour-mapped RGBA tile) — no wire
  framing, no gzip, no loopback copies.
- **API sketch** (UniFFI):
  ```
  load_dem(bytes, smooth_sigma_m) -> DemHandle        // GeoTIFF decode + smoothing, in Rust
  derive_cost(physics) -> Cost                         // readCost port
  compute_single(dem, params, src, want_passes, want_path, dst) -> SingleResult { energy, passes?, path? }
  compute_density(dem, params, refs, want_matrix, mem_budget_bytes) -> DensityResult
  energy_at(result, r, c) -> f32
  render_tile(result, style, z, x, y) -> Rgba          // optional: colormap in Rust, MKTileOverlay in Swift
  ```
  `want_path`/`dst` is the one new engine feature: walk `parents` from
  `dst` back to `src` after `dijkstra_tree` — a ~30-line addition, no parity
  risk to the fields (`test-backend.mjs` should still get a `+path` case
  compared against the JS worker's `path`).
- **Effort:** months. The engine is the easy part; DEM I/O, MapKit rendering,
  bundle interop and the UI are the bulk.

### Option B — thin remote client (no on-device compute)

A native app that speaks the existing HTTP protocol to a Mac on the LAN
(`cargo run --release -- 0.0.0.0:8077`) or to the cloud VM via the
orchestrator (`POST /cloud/start` → `dataUrl` → `/density`). Zero Rust
changes. This is the **only** way a phone drives the 135 M-cell São Paulo
DTM (§5). Concerns: uploading hundreds of MB from a phone per run; the
orchestrator pins the firewall to the caller's `/32` from `X-Forwarded-For`,
which is fragile behind mobile CGNAT (the phone's public IP can change
between `/cloud/start` and `/density`); the bearer token belongs in the
Keychain. Best delivered as the *remote* mode of Option A, not as its own
app.

### Recommendation

**Start with D as a spike (1–2 weeks) to prove the toolchain and get a
usable app**, then build A on the same `.xcframework`, keeping B as A's
"remote compute" setting for DEMs that don't fit on the device. D and A share
the crate split, the memory-budget API and the build script, so nothing from
the spike is thrown away.

---

## 3. Required repository changes (all options)

### 3.1 Crate split: `lib.rs` + `main.rs`

Move the pure-compute rows of §1 into `backend/src/lib.rs` (crate
`simujoules-core`, `crate-type = ["lib", "staticlib"]`); `main.rs` keeps
`tiny_http`, gzip, CORS, the request parser and `/health`. Pure code motion —
no behaviour change — verified by `node backend/test-backend.mjs` still
passing bit-parity afterwards. Feature-gate the server deps so the iOS
build doesn't pull `tiny_http`/`flate2`:

```toml
[features]
default = ["server"]
server  = ["dep:tiny_http", "dep:flate2"]
```

### 3.2 `.cargo/config.toml`: scope `target-cpu=native` to the host

Today `[build] rustflags = ["-C", "target-cpu=native"]` applies to **every**
target, which is why the iOS check spews "not a recognized feature for this
target" warnings (harmless on `check`, but it will mis-tune or break a real
cross build). Move it under the host triple:

```toml
[target.x86_64-unknown-linux-gnu]
rustflags = ["-C", "target-cpu=native"]
[target.aarch64-apple-darwin]
rustflags = ["-C", "target-cpu=native"]
```

The file's own comment already anticipates this ("remove this if you ever
distribute binaries").

### 3.3 Memory budget becomes an input

`density_mem_budget_bytes()` reads `SIMU_MAX_MEM_GB`, `/proc/meminfo`, or
**spawns `sysctl`** — the spawn is illegal on iOS and the env var is
meaningless there. Make `compute_density` take `mem_budget_bytes: u64` as a
parameter (the server passes what it computes today; the iOS shell passes
`os_proc_available_memory()` minus a reserve). This is the one change that
touches compute code, and it's a signature change only — the slice-count
formula `min(refs, cores, budget / per_slice)` stays, so the app-side
`predictComputeMs` mirror (`BACKEND_BYTES_PER_CELL{,_ROUND}`) is unaffected.

Also `rayon::current_num_threads()`: on iOS let the caller set the pool size
(`ThreadPoolBuilder`) — default to performance cores only, see §5.

### 3.4 New mirrors and the tests that pin them

The iOS app must produce the same numbers as the web app for the same inputs,
so every JS-side step that "decides a number" and moves to Rust becomes a new
hand-kept mirror in the CLAUDE.md sense:

| JS origin | Rust port | Pin with |
|---|---|---|
| `smoothHeightsInPlace` (app.js; mirror `test-dem-smoothing.mjs`) | `core::smooth_heights_in_place` | extend `test-dem-smoothing.mjs` to also run the Rust binary (like `test-backend.mjs`) and assert byte-identical output — note the mirror's sequential per-axis order and mask normalisation must be reproduced op-for-op |
| `readCost` (app.js; mirrors in `census/census-density.mjs`, `test-energy-v2.mjs`) | `core::derive_cost` — a **new `9.7864` hit** | `test-energy-v2.mjs` `beta ≈ m·g/keff` assertion extended to the Rust output; add the file to CLAUDE.md's "grep 9.7864" list |
| `dijkstra()` parent walk → `path` | `compute_single(..., want_path)` | `+path` cases in `test-backend.mjs` vs the JS worker's `path` (exact-tie caveat as for passes) |
| GeoTIFF read (`loadDem` in `census/census-density.mjs`, app-identical) | `core::load_geotiff` via the `tiff` crate | compare decoded `height`/`mask`/`dxM`/`dyM`/`ImageDescription` tag against `loadDem` on the `dem/` examples and an app-exported `dem.tif` (the `simujaules:demSmoothSigmaM=` tag must round-trip so the auto-smoothing guard keeps working) |

Nothing in this list touches `energy-worker.js`; the JS engine stays the
reference implementation.

### 3.5 Build/packaging

- `rustup target add aarch64-apple-ios aarch64-apple-ios-sim`
  (+ `x86_64-apple-ios` only if Intel simulators matter).
- A `backend/build-ios.sh`: `cargo build --release --no-default-features
  --lib --target …` per target, `lipo` the simulator slices, `xcodebuild
  -create-xcframework`. UniFFI's `uniffi-bindgen` generates the Swift.
- The `ios/` Xcode project lives alongside `backend/` and `mcp/` as dev
  tooling: **never deployed by `deploy.sh`**, never in `sw.js`'s precache.
- No `VERSION` bump or changelog entry is owed for any of this until a
  user-visible web-app change ships (e.g. the Option D "default to Localhost
  under the shell" tweak).

---

## 4. Phased plan (Option A track; D is Phase 0)

**Phase 0 — toolchain spike (Option D).** Crate split (§3.1), config
(§3.2), memory input (§3.3), `.xcframework`, WKWebView shell serving the
bundled site over loopback, the existing server thread inside the app. Exit
criterion: the unchanged web app computes a density run on-device via
Localhost on an iPhone and on the simulator, and `test-backend.mjs` still
passes on desktop. This alone is a shippable TestFlight build.

**Phase 1 — native core surface.** UniFFI bindings; `load_geotiff`,
`smooth_heights_in_place`, `derive_cost` in Rust with their mirror tests
(§3.4); `compute_single` gains `want_path`. Swift can now go DEM → field →
path without JS.

**Phase 2 — SwiftUI app, single-source.** Document picker / Files import of
a GeoTIFF or an app bundle `.zip` (read `dem.tif` + `metadata.jsonld`
params), MapKit base map, tap source/destination, run, render the energy
field as an `MKOverlay` (colormap in Rust or Swift — the web app's colormap
tables are plain arrays and can be copied), energy-at-tap readout, PT/EN.
Parameters panel limited to the physics inputs + eMax + nDirs + smoothing.

**Phase 3 — density + refs + export.** Multi-ref placement (tap; Sobol/Halton
sampling is a small port from app.js), density run with the on-device memory
budget, passes/density rendering, accessibility matrix KPIs, bundle export
writing the same `energy.tif`/`passes.tif`/`metadata.jsonld` the web app
writes (so QGIS and the web app import it).

**Phase 4 — remote mode (Option B inside A).** Same request the web app
builds, sent to a user-entered URL (LAN Mac) or the orchestrator; Keychain
token; per-run "device vs remote" recommendation from the cell count and
`os_proc_available_memory()`.

**Deferred / probably never on iOS:** graph mode, top-N, maximize, maxseg,
string pulling, OSM/FGB pulls, census sampler, GeoPackage networks. Each is
a self-contained JS module and can be ported one at a time if wanted; none
is needed to make the Rust engine "the driver".

---

## 5. Hard limits and risks

**Memory is the binding constraint, not CPU.** Per concurrent density slice
the engine holds 37 B/cell (55 round; +1 B/cell `parent_long` and the shared
long-edge tables at nDirs > 8), plus the DEM (4 B height + 1 B mask), plus
outputs (8 B f64 passes + 4 B f32 energy):

| DEM | cells | one slice (from/to) | fits on device? |
|---|---|---|---|
| Neighbourhood, 5 m | 1 M | ~55 MB | Easily; several slices |
| City sector, 5 m | 10 M | ~0.55 GB | Yes on 6–8 GB phones, 1–3 slices |
| São Paulo DTM, 5 m | 135 M | ~5 GB + 0.7 GB DEM | **No** — remote only (the desktop needs ~16 GB for 2 slices) |

iOS foreground apps are jetsam-killed well below physical RAM (roughly half
to two-thirds on recent iPhones; iPads with 8–16 GB do better). The app must
read `os_proc_available_memory()` at run time and refuse or route to remote
above the budget rather than let the OS kill it mid-run. Also: iOS has no
swap, and a backgrounded app is suspended — a long density run must keep the
app in the foreground (`UIApplication.isIdleTimerDisabled`) or accept
cancellation; there is no background-compute entitlement for this workload.

**CPU.** rayon works on iOS; A-series chips have 2 performance + 4
efficiency cores, and the engine is memory-bandwidth-bound at saturation
(backend README), so expect ~2–3× from parallel slices, not 6×, and thermal
throttling on multi-minute runs. Pinning the pool to the P-cores may be
faster than using all six. No numbers are claimed here — measure in Phase 0
with the same 1 M-cell fixture the backend README used.

**Float parity.** The engine's bit-parity with the JS worker rests on
`js_hypot`/`js_round` (V8-exact) and f32↔f64 round-trips, none of which is
ISA-dependent; ARM64 FMA contraction is not enabled by rustc by default, so
results should match x86 bit-for-bit. Verify in Phase 0 by running
`test-backend.mjs`'s fixtures through the iOS library (simulator build) and
comparing checksums — cheap, and it turns the parity claim into a test.

**Toolchain.** UniFFI, cross-compiling rayon and the `tiff` crate for iOS
are all routine in 2026; the risk is Xcode-side (signing, xcframework
layout), not Rust-side. No `unsafe`, no C dependencies in the current
crate, which is what made the target check pass first try.

**Product.** The PWA already installs on iOS Safari and runs the JS worker
pool, so the native app's entire justification is "bigger DEMs, faster, and
not subject to WebKit's per-tab memory cap". If that isn't compelling for the
intended users, Option B (remote) added to the existing PWA is a much smaller
project than any of the above.

---

## 6. Summary of decisions to make

1. Which track: D-then-A (recommended), A directly, or just B?
2. Whether the iOS v1 surface is the `mcp/lib.mjs` subset (single + density,
   no network/bridges/graph) — recommended — or must include a network mask
   (then bundle `network.tif` import comes forward to Phase 2).
3. DEM I/O in Rust (recommended: one decoder for both platforms, testable
   from node) or in Swift (ImageIO can't read f32 GeoTIFF; it would be
   libtiff/GDAL, far heavier).
4. Whether path extraction (`want_path`) also lands in the server's `/single`
   for the web app — free once it exists, but the web app currently gets its
   path from the JS worker and would need a decoder change to use it.
