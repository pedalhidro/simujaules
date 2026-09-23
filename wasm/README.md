# wasm/ — the native engine, compiled for the browser

`src/lib.rs` `include!`s `../backend/src/main.rs` **verbatim** and adds a small
C ABI (`alloc` / `run` / `out_*` / `release`, no wasm-bindgen). The result is
the Localhost/Cloud engine running inside the page's Web Workers:

| file (repo root) | target | toolchain | runs in | memory |
|---|---|---|---|---|
| `engine32.wasm` | `wasm32-unknown-unknown` | stable | every browser | ≤ 4 GiB |
| `engine64.wasm` | `wasm64-unknown-unknown` (Memory64) | nightly + `build-std` | Chrome ≥ 133, Firefox ≥ 143 | ≤ 16 GiB |

`wasm-worker.js` (repo root) loads `energy-worker.js` and serves two jobs on
the module — density-pool slices and plain single-source fields — speaking the
JS worker's message protocol; everything else, and any wasm failure, runs on
the JS engine. `app.js` decides the engine per job (`wasmEngineFor`,
`densityEngine`, `singleEngine`) and compiles each module once.

## Build

```sh
rustup target add wasm32-unknown-unknown                              # once
rustup toolchain install nightly --profile minimal --component rust-src  # once (engine64)
./build.sh            # writes ../engine32.wasm and ../engine64.wasm
node test-wasm.mjs    # parity vs energy-worker.js, both modules
```

**Rebuild and commit both `.wasm` files whenever `backend/src/main.rs`
changes** — the browser otherwise keeps serving the old engine. The deploy
itself stays build-free: `deploy.sh` just ships the committed modules.

`engine64.wasm` is linked with `--max-memory` (16 GiB): Firefox otherwise
re-allocates a Memory64 memory on every grow, which measured quadratic
(256 MiB grown in 1 MiB steps took 24 s; with the declared maximum, 3 ms).

## Measured speed (v80 study, 4-core laptop)

Best-vs-best wall time, both engines in dedicated Web Workers, SP DTMs
(σ30-smoothed), JS worker time ÷ wasm time:

| job | Chrome 151 | Firefox 155 |
|---|---|---|
| density, 8 directions (1 worker / 3-worker pool) | 1.95–2.9× | 2.1–2.4× |
| density, 16 directions | 1.4–1.8× | 1.95–2.1× |
| single-source + passes, 8 / 16 directions | 1.4–1.5× / 1.3× | 1.5× / 1.3–1.5× |

The wasm engine runs 12–24 % behind native Rust on one thread; Memory64 costs a
further 1–12 %. Outputs are byte-identical between the two modules and the
native binary.

Through the real app (v80, Chrome 151, Sampa Centro 8.5 M cells, 6 refs on a
3-worker pool, one background core busy): density 61 → 39 s at 16 directions
(×1.57) and 33 → 19 s at 8 (×1.77); single-source 29 → 22 s (from, ×1.31)
and 53 → 34 s (round, ×1.57). Energies identical to the JS engine; passes
differ only on exact-tie cells.
