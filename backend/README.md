# simujoules-backend

Optional native compute backend for the Simujoules density mode. **Off by
default** — the app is fully functional without it (density runs use an
in-browser worker pool). Enable it per-session with the *Use native backend*
checkbox inside the density panel; the app falls back to the browser workers
automatically if the server isn't reachable.

Why it exists: each reference point's Dijkstra is independent, so the density
field parallelises across cores. Native code is ~2–4× faster per Dijkstra
than the JS worker, and rayon uses *all* cores (the browser pool leaves one
for the UI and caps itself by memory on very large DEMs). Expect roughly
3–10× over the in-browser pool depending on DEM size and core count.

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

Then tick **Use native backend** in the app's density panel (the URL field
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

- `POST /density` — `[u32 json_len][json params][f32 height×N][u8 mask×N][u8 network×N?]`
  → `[u32 json_len][json {elapsed_ms, refs}][f64 passes×N][f32 energy×N]`
- `GET /health` — `{"ok":true,"version":…,"cores":…}`

The cost model and passes/density math are a port of `energy-worker.js`
(`dijkstra()` with `wantPasses`); keep the two in sync. `test-backend.mjs`
in this directory checks the server's output against the JS worker.
Energies match bit-for-bit (the f32/f64 round trips mirror the JS
Float32Array exactly). Passes can differ from the JS worker only where two
paths have EXACTLY equal f64 cost — the radix heap pops ties in a different
order, and either optimal tree is valid.

```sh
cargo build --release
node test-backend.mjs          # starts the binary, compares vs energy-worker.js
```

Note: the optional network-interpolation (IDW fill) step still runs in the
browser worker after the backend returns — it's visualisation-only and cheap.
