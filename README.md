# Asymmetric Energy Field — Web Prototype

A static-site, no-backend port of the QGIS Processing algorithm. Loads a
GeoTIFF DEM, lets you click two points on a map, and renders the
asymmetric energy field (with optional path).

## Files

- `index.html` — page shell, panel UI, map container. The little tag
  next to the title shows whether the **wasm** or **js** engine is
  active.
- `app.js` — DEM loading (via geotiff.js), map glue (Leaflet), worker
  dispatch, result rendering. At startup it probes for the wasm worker
  and falls back to the JS worker if wasm isn't available.
- `energy-worker.js` — Dijkstra in a Web Worker (pure JS). Asymmetric
  uphill/downhill cost, with optional partial recovery on descent.
  Includes a binary heap on a flat typed array for speed. Used as the
  fallback engine.
- `energy-worker-wasm.js` — same algorithm, same message API, but the
  inner loop is a Rust-compiled wasm module loaded from `wasm/pkg/`.
  Used as the default engine when `wasm/pkg/` is built.
- `wasm/` — Rust crate (`Cargo.toml`, `src/lib.rs`) that compiles to
  the wasm module. `wasm/pkg/` is the build output (gitignored).

## Running

It's a static site. From the project directory:

    python3 -m http.server 8000

Then open <http://localhost:8000>. (Workers need to be served over HTTP,
not opened from `file://`.)

For deployment, drop the static files onto any static host: GitHub
Pages, Cloudflare Pages, S3 + CloudFront, Netlify, etc. No backend, no
API keys (unless you swap in a paid basemap).

## Building the wasm engine

The wasm worker needs `wasm/pkg/` to exist. If it doesn't, the page
silently falls back to the JS engine — nothing is broken, just slower.

One-time setup (Rust toolchain + wasm-pack):

    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
    cargo install wasm-pack    # or: brew install wasm-pack

Build (re-run any time `wasm/src/lib.rs` changes):

    cd wasm
    wasm-pack build --target web --release --no-typescript --out-dir pkg

This drops `energy_wasm.js` and `energy_wasm_bg.wasm` into `wasm/pkg/`.
Reload the page and the engine tag in the title should switch from
`js` to `wasm`. There's a `wasm/build.sh` shortcut for the same
command.

The Rust source mirrors `energy-worker.js` line-for-line so the two
engines produce identical results. If you change the cost model in one,
mirror it in the other or you'll get inconsistent answers depending on
which engine is loaded.

## Prototype scope

This is intentionally minimal — it covers the energy-field algorithm in
three modes (from / to / round trip) plus optional point-to-point path
visualisation. Not yet ported:

- **Passes count** (route density). Same algorithm in the worker plus a
  subtree-accumulation pass; ~50 lines.
- **Top-N routes** with distance repulsion. Needs a Euclidean distance
  transform; either port `distance_transform_edt` (the two-pass method
  is short) or use a simple BFS-based approximation.
- **Network constraint** (rasterised line layer). Needs a way to read
  vector data — easiest is a GeoJSON drag-and-drop, then a JS line
  rasteriser, then AND with the mask.
- **Energy / distance budgets** (constrained reachability). Single-resource
  case (energy budget only) is just a cutoff in the worker; ~3 extra lines.

## Known limitations

**CRS handling is naive.** The prototype assumes the DEM is in geographic
coordinates (EPSG:4326). For a real tool you want UTM or another projected
CRS so that horizontal distances are in metres. The fix is to add
[proj4js](https://github.com/proj4js/proj4js) and parse the GeoTIFF's
GeoKeys to get the source CRS. Then convert mouse clicks (which Leaflet
gives you in lat/lon) to DEM CRS pixel coordinates, and convert pixel
extents back to lat/lon for the image overlay bounds.

For testing, you can produce a small EPSG:4326 DEM with:

    gdalwarp -t_srs EPSG:4326 -tr 0.0003 0.0003 input.tif test_dem.tif

(`-tr` sets the pixel size in degrees; ~30 m at the equator. Use a smaller
value for finer resolution.)

**No reprojection of result.** The energy field overlay is drawn in the
DEM's CRS, so on a Web Mercator basemap there will be distortion away
from the equator (negligible for most cycling-scale extents).

**Single-DEM-per-session.** Loading a new DEM doesn't clear all state
cleanly; refresh the page if results look wrong.

**Memory.** The DEM is copied each time you run the worker (since
transferred buffers can't be reused). For large DEMs that's noticeable;
either keep a single worker alive for the session and re-load only on
DEM change, or accept the copy cost.

## Performance

On a 333×333 DEM (10×10 km at 30 m), the JS engine runs a single
Dijkstra in roughly 200–400 ms on a modern laptop; round trip ~2× that.
The wasm engine typically lands at 2–4× faster on the same DEM (Rust
release build, LLVM `lto = "fat"`, `panic = "abort"`).

Where the wasm engine actually pays off is at scale: the JS engine
starts to feel sluggish around 500 k cells and is uncomfortable past
~5 M; the wasm engine extends that envelope by roughly 3–5× before you
need to think about further work (chunked dispatch, GPU compute,
hierarchical Dijkstra). For the 25 M-cell case (50×50 km at 10 m), wasm
is required to keep run time under 10 s.

A few caveats to keep in mind:

- The wasm engine doesn't emit progress updates. The bar stays at 0
  and then jumps to "done" — the runs are usually short enough that
  this isn't noticeable, but if you want a progress bar, use the JS
  engine.
- DEM upload to wasm linear memory and the result fetch are zero-copy
  (typed-array views), so there's no marshalling overhead per cell.
  The only copy is the one-shot `set()` from the worker's input buffer
  into wasm memory.
- Memory growth during Dijkstra (the internal heap) detaches any
  views into `wasm.memory.buffer` taken before the call. The worker
  re-fetches views after every wasm call so this is handled, but if
  you extend the worker, keep that gotcha in mind.
