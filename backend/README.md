# simujoules-backend

Optional native compute backend for Simujoules. **Off by default** — the app
is fully functional without it (compute runs use an in-browser worker pool).
Enable it per-session with the *Use native backend* checkbox (a top-level
compute option in the parameters panel); the app falls back to the browser
workers automatically if the server isn't reachable.

It accelerates two kinds of run:

- **Multi-reference density** (`POST /density`) — one Dijkstra per reference
  point, parallelised across cores.
- **Single-source energy field** (`POST /single`) — one Dijkstra (two for
  round trip) from a single source, returning the raw energy field + optional
  passes.

Top-N routes, the destination path, and "maximize" stay browser-only — the
backend produces no routes.

Why it exists: each Dijkstra is independent, so density parallelises across
cores. Native code is ~2–4× faster per Dijkstra than the JS worker, and rayon
uses *all* cores (the browser pool leaves one for the UI and caps itself by
memory on very large DEMs). Expect roughly 3–10× over the in-browser pool for
density depending on DEM size and core count.

Performance notes (measured on a 1 M-cell DEM, 10 cores):

- refs are split into per-thread slices, each reusing ONE set of grid-sized
  scratch buffers across its refs (no per-ref allocation), and round mode
  `rayon::join`s the forward/backward runs — ~1.3× at high K, ~2× for
  few-ref round runs;
- the priority queue is a **radix heap** on the raw f64 bits — exact minima
  (no quantisation), ~10–15% per Dijkstra over a binary heap;
- request/response rasters move via single memcpys (`bytemuck`), and
  `.cargo/config.toml` builds with `target-cpu=native` (remove it if you
  distribute binaries);
- at full core saturation the workload is memory-bandwidth-bound, so
  further queue/ALU tuning has little headroom.

## Run

```sh
cd backend
cargo run --release            # binds 127.0.0.1:8077
cargo run --release -- 0.0.0.0:9000   # custom bind address
```

Then tick **Use native backend** in the app's parameters panel (the URL field
defaults to `http://127.0.0.1:8077`).

### Memory at scale

Each concurrent rayon slice holds full-grid scratch + accumulator buffers
(~5 GB on a 135 M-cell DEM). With many reference points the server would
otherwise spawn one slice per core and exhaust RAM, so it **caps concurrent
slices to fit a memory budget** — fewer slices just process more refs
serially (slower, but it completes instead of OOM-crashing; output is
identical). On startup it logs the detected budget and, per request, the
chosen slice count.

The budget is detected from the OS (`/proc/meminfo` `MemAvailable` on Linux,
`sysctl hw.memsize` on macOS, minus a ~3 GB working-set reserve). Override it
when you know better:

```sh
SIMU_MAX_MEM_GB=48 cargo run --release      # or: --release -- --max-mem-gb 48
RAYON_NUM_THREADS=4 cargo run --release     # also bounds parallelism directly
```

## Protocol

Little-endian binary framing, see `src/main.rs` header comment:

- `POST /density` — `[u32 json_len][json params][f32 height×N][u8 mask×N][u8 network×N?][portals?]`
  → `[u32 json_len][json {elapsed_ms, refs}][f64 passes×N][f32 energy×N]`
- `POST /single` — same request framing (driven by `src` + `want_passes`
  instead of `ref_points`; `maximize` is rejected with a 400 — browser-only)
  → `[u32 json_len][json {elapsed_ms, passes}][f32 energy×N][f64 passes×N?]`
- `GET /health` — `{"ok":true,"version":…,"cores":…,"mem_budget_bytes":…}`

The cost model and passes/density math are a port of `energy-worker.js`
(`dijkstra()` with `wantPasses`, and the from/to/round single-source branch);
keep the two in sync. `test-backend.mjs` in this directory checks both
endpoints against the JS worker.
Energies match bit-for-bit (the f32/f64 round trips mirror the JS
Float32Array exactly). Passes can differ from the JS worker only where two
paths have EXACTLY equal f64 cost — the radix heap pops ties in a different
order, and either optimal tree is valid. `/single` passes are accumulated and
shipped as f64 because the JS single-source branch returns a Float64Array
(counts exceed 2^24 on big DEMs, where f32 would round); density's internal
passes stay f32, matching the JS `densityField`'s Float32Array.

```sh
cargo build --release
node test-backend.mjs          # starts the binary, compares vs energy-worker.js
```

Note: the optional network-interpolation (IDW fill) step still runs in the
browser worker after the backend returns — it's visualisation-only and cheap.
