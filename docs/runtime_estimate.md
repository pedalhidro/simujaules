# Runtime estimate: accuracy investigation and model

*Research report — 2026-06-19. Companion to the v14 estimate fix.*

## Abstract

The app shows a pre-flight compute-time estimate (`≈ X s`) before a density
run. Users reported it reading **~3× lower** than the actual time, specifically
on the 135 M-cell `sampa_geral` DEM at energy budgets 200–300 with many
reference points (10–1024) **using the native Rust backend**.

A controlled benchmark of *estimate-vs-actual* across three DEMs, seven budgets,
two modes, and both engines found the old estimate had **no consistent global
bias (geomean 1.00) but enormous variance (0.62–3.98×)**, driven by three
independent structural flaws. The dominant one for the reported scenario was
that the **backend estimate ignored the server's memory-bounded slice cap**:
it assumed parallelism scaled with cores, but each rayon slice needs ~5 GB of
full-grid scratch, so only 1–2 slices fit on a 135 M-cell DEM regardless of
core count. Combined with a native-speedup constant that was ~2× too low, this
produced the reported 3× under-estimate (measured: **3.63×**).

The fix replaces the calibration probe with a **settled-cell-capped** probe
(bounded wall time on any DEM; always anchored at an unsaturated point), makes
the backend estimate **replicate the slice cap** (`/health` now reports the
memory budget), and adds a per-engine **online correction** that learns
actual/predicted from completed runs. Post-fix, the **first-run** estimate is
within **±20%** with no systematic bias, and it converges to **~1%** within a
run or two via the online correction (§7 covers first-run vs steady-state).

## 1. Background

`estimateRunTime()` (`app.js`) predicts the wall-clock of a compute before it
runs. Density mode is the expensive case: one budget-limited Dijkstra per
reference point over the DEM grid, accumulating a "passes" (betweenness-like)
field. Cost is dominated by the number of **explored cells**, which grows with
the energy budget until it saturates the grid.

The estimate is calibrated per-DEM by a one-shot **probe** worker at DEM load,
because per-cell throughput and the budget→explored relationship are
terrain-dependent and can't be hardcoded. The probe runs a few short searches
and the estimate scales from them. This report is about why that scaling was
wrong and how it was corrected.

Three engines/paths exist:

- **Browser worker pool** — `min(cores−1, K, memCap)` workers, each a JS
  Dijkstra. Default.
- **Native Rust backend** — `rayon` across reference points, split into
  memory-bounded **slices**. Opt-in.
- (Single-point and graph modes exist but are not the perf-critical density
  path this report targets.)

## 2. Methodology

### 2.1 Experimental design

We measured the **ratio = actual / estimate** (target 1.0) over a factorial-ish
sweep, deliberately spanning DEM size and budget because those were the
suspected bias axes:

| Factor | Levels |
|---|---|
| DEM | `sampa_geral` (135.0 M cells, 14913×9055), `sampa_centro` (8.46 M, 3731×2267), `sampa_aguapreta` (0.55 M, 975×568) |
| Energy budget `eMax` | 50, 150, 300, 600, 0 (= full grid); plus 200/250/300 on geral |
| Mode | `from`, `round` (`to` ≈ `from` — a reverse search has the same frontier size; the `round = from + to` engine parity is asserted in `test-worker-pool.mjs`) |
| Engine | JS (`densityField`), Rust backend (single-thread and all-cores) |
| Reference points | 1–24 random (seeded); 24 **census** points for the user scenario |

Cell size is ~4.88 m (E-W) × ~5.29 m (N-S) for all three DEMs (same source
resolution); they differ in extent, not resolution. Cost params were the
defaults: `alpha=0.008, beta=1.0, eta=0.1`.

### 2.2 Harnesses

- `densityField` was loaded **standalone in Node** (brace-matched extraction
  from `energy-worker.js`, run via `new Function`) so the same engine bytes the
  browser worker runs could be timed without browser overhead. The probe logic
  (`startCalibrationProbe` + the worker `probe` branch) was replicated exactly.
- The **Rust backend** was driven over its binary HTTP protocol
  (`POST /density`), reading `elapsed_ms` from the response and the chosen slice
  count from its stderr log. Run both single-thread (`RAYON_NUM_THREADS=1`, to
  isolate the per-ref engine factor) and all-cores (parallel speedup).
- End-to-end **headless Chrome (CDP)** drove the real app — load DEM, read the
  `#time-estimate` text, trigger a compute, read "Done in X ms" — to confirm
  the DOM wiring, not just the model math.

### 2.3 Real reference distribution

`census/points.geojson` provides 1500 population-weighted points across the
metro area. These were mapped lon/lat → grid cells via the DEM geotransform and
used as the ground-truth reference distribution for the user scenario, because
**random refs under-sample the heavy tail**: population clusters sit on urban
hills, and a hilltop ref floods *downhill* cheaply (the asymmetric cost makes
descent near-free), exploring far more cells than an average random ref. A
2-random-ref sample missed this; 24 census refs captured it (mean explored/ref
≈ 22.0 M at budget 250).

### 2.4 Test machine

17.2 GB RAM, 10 logical cores (4 performance). The backend's auto-detected
memory budget here is ≈14.2 GB (`RAM − 3 GB` reserve). Absolute timings are
machine-specific; the *ratios* and the *model structure* are not.

## 3. Findings: the bias structure

The old estimate's ratio across 27 measured (DEM × budget × mode) cells:
**geomean 1.00, min 0.62, max 3.98**. No global bias, but a ~6.4× spread.
Representative cells:

| Regime | Cell | ratio (act/est) | Direction |
|---|---|---|---|
| Small DEM, low budget | aguapreta @50 | **3.84** | under-estimate |
| Medium DEM, probe budget | centro @150 | **0.65** | over-estimate |
| Big DEM, full grid | geral @0 | 1.19 | mild under |
| Big DEM, mid budget (browser) | geral @250 (census) | 0.99 | accurate |
| **Big DEM, mid budget (backend)** | geral @250 (census) | **3.63** | **under (the report)** |

Two observations pinned the diagnosis:

1. **The browser path was already accurate on geral@250 (0.99).** So the user's
   3× could not be the browser density model — it had to be the **backend**.
   The user later confirmed they were using the Rust backend.
2. **The small-DEM 3.84× and the medium-DEM 0.65× were the same root cause**
   seen from two sides: the probe's fixed energy budget (150) *saturated* small
   grids, so the budget→explored extrapolation was anchored at a meaningless
   point (see §4.1).

## 4. Root-cause analysis

### 4.1 Browser: probe-budget saturation (the up-to-3.8× small-DEM error)

The old probe ran 2 central refs at a **fixed budget of 150** and recorded
`E0 = explored cells/ref`. The estimate scaled `explored(eMax) =
E0·(eMax/150)^2.1`, capped at `N`.

On `aguapreta` (0.55 M cells), budget 150 with `alpha=0.008` reaches ~18.7 km of
flat-equivalent distance — far larger than the ~5 km DEM — so the probe
**saturated**: `E0 = 99.9% of N`. The estimate then extrapolated *downward* to
budget 50 with the steep `^2.1` law from a saturated anchor, predicting 0.058 M
explored when the true value was 0.21 M → **3.7× too few cells → 3.8× too fast
an estimate**. On `centro` (E0 = 80.7%, near-saturated) the same anchor made the
probe budget itself over-predict (central refs explored more than random refs),
giving 0.65× at budget 150.

**Lesson:** the explored law must be anchored at an **unsaturated** point. A
fixed energy budget can't guarantee that across DEM sizes.

### 4.2 Backend: the missing slice cap (the reported 3×)

The backend splits `refs` into concurrent rayon **slices**, but caps the slice
count to a **memory budget** so high ref counts on huge DEMs don't OOM
(`backend/src/main.rs`):

```
per_slice   = (round ? 55 : 37) · N        // bytes: 17 scratch + 20 acc (+ round extra)
mem_cap     = floor(mem_budget / per_slice)
n_slices    = min(refs, cores, mem_cap)
```

On `sampa_geral` (135 M cells), `per_slice = 37 · 135 M ≈ 5.0 GB`. With a
14.2 GB budget, `mem_cap = 2` → **2 slices** in `from` mode (1 in `round`,
`55·135M ≈ 7.4 GB`), **regardless of the 10 cores**.

The old estimate used `effPar = min(refs, cores, 8)` — i.e. it assumed **8-way**
parallelism. So it divided the work by 8 when reality divided it by 2 → **4×
too optimistic** on parallelism alone (8× in round mode).

### 4.3 Backend: native speedup is not constant

Single-thread Rust-vs-JS per-ref speedup, measured:

| DEM / budget regime | speedup (JS ms / Rust ms) |
|---|---|
| Small DEM, cache-fitting frontiers | ~2.0–2.7 (geomean ~2.35) |
| Large frontiers (geral, big budgets) | ~1.3 (both memory-bandwidth-bound) |

The old constant `NATIVE_SPEEDUP = 1.25` was too low everywhere; but more
importantly, **no single constant is right**, because on huge frontiers both
engines saturate memory bandwidth and converge. Furthermore, when 2 slices run
concurrently on a bandwidth-bound frontier they **contend** — each ref slows
~1.7× — so the entangled factor `native_speedup × slice_contention` is
scale- and server-dependent and cannot be predicted a priori.

**Net effect for the reported case** (geral, budget 250, 24 refs, backend). A
back-of-envelope using idealized constants —
`(1/8 · 1/1.25) / (1/2 · 1/2.35) ≈ 0.47` → estimate ≈ 0.47× actual →
**actual ≈ 2.1× estimate**. The *measured* ratio was larger still, **3.63×**,
because this simplified formula uses the small-DEM native speedup (2.35) and
ignores slice contention; on geral's bandwidth-bound frontier the native edge
shrinks toward ~1.3 and the 2 concurrent slices contend (~1.7× each). That
extra ~1.7× the structural formula can't capture is exactly the entanglement
that motivates the **online correction** (§5.4) rather than a fixed constant.

### 4.4 What roughness proxies showed

A DEM "roughness index" was considered as a way to predict the explored law
without probing. Sampling 0.1% of cells:

| DEM | std(elevation) | mean local slope | flat-fraction (<2%) |
|---|---|---|---|
| aguapreta | 125.1 m | 0.55 | 24.9% |
| centro | 121.8 m | 0.135 | 49.1% |
| geral | 136.8 m | 0.135 | 27.8% |

**Global elevation std is non-discriminating** (all three ~120–137 m). Local
slope / flat-fraction discriminate, but the quantity the estimate actually needs
— this terrain's *reach-vs-budget* law — is measured **directly** by the probe
(see §5.1), which subsumes any scalar roughness proxy. So roughness was *not*
adopted in the model; the cell-capped probe is the better instrument.

## 5. The corrected model

### 5.1 Cell-capped probe (responsiveness + unsaturated anchor)

The probe (`startCalibrationProbe` → worker `probe` branch) now runs
`PROBE_REFS = 3` spread refs in **one unbudgeted search each, stopped after
`maxSettled` settled cells** (`densityField` gained an optional `maxSettled`
cap; zero-cost on normal runs — one short-circuited compare per pop when 0).

```
maxSettled = min(PROBE_MAX_SETTLED=1,000,000, max(50k, floor(0.4·N)))
```

Capping by **cell count** (not energy) bounds the probe's wall time on *any*
DEM — the responsiveness target (≤3 s hard, ≤~1 s ideal) — and the `0.4·N`
ceiling keeps it **unsaturated** (always below the full grid), which is what
fixes §4.1. The probe reports, averaged over its refs:

- `Estar` — cells explored (= the cap),
- `bStar` — the energy budget reached at that cell count (the energy of the
  last settled cell; varies with local relief),
- `perRefProbe` — search + passes-walk ms (minus the one-time scratch alloc),
- `allocMsN` — the one-time full-grid scratch allocation.

### 5.2 Scaling laws

```
explored(eMax, alpha) = min(N, Estar · (eMax·alpha_probe / (bStar·alpha))^EXPLORE_EXP)
perRef(explored)      = perRefProbe · (explored / Estar)^RATE_EXP
```

with `EXPLORE_EXP = 2.1` (area ∝ reach², reach ∝ eMax/alpha; ~2.1 on real
terrain) and `RATE_EXP = 1.1` (mild super-linearity from cache rate-degradation
as the frontier outgrows cache). Anchoring at `(bStar, Estar)` instead of a
fixed budget is the key change.

### 5.3 Engine branches

A single predictor `predictComputeMs(cal, opts, applyCorr)` serves both the live
estimate and the correction update (so they can't drift):

- **Browser:** `allocMsN + (refs / poolN) · perRef · dijk`, with `poolN` from the
  shared `densityPoolSize()` and `dijk = 2` for round.
- **Backend:** replicates the slice cap —

```
per_slice   = (round ? 55 : 37) · N
mem_cap     = floor(mem_budget_bytes / per_slice)        // from /health
slices      = min(refs, cores, mem_cap)
contention  = 1 + BW_CONTENTION·(slices − 1)             // BW_CONTENTION = 0.2
ms          = (refs / slices) · (perRef / NATIVE_SPEEDUP) · contention · dijk
```

with nominal `NATIVE_SPEEDUP = 1.6`. `/health` now returns `mem_budget_bytes`;
`BACKEND_BYTES_PER_CELL{,_ROUND}` (37/55) mirror `backend/src/main.rs`'s
`per_slice` and must be kept in sync.

### 5.4 Online correction (the ±20% guarantee)

Because the backend's `native_speedup × contention` factor is genuinely
server- and scale-dependent (§4.3), it is **learned, not guessed**. At run
start, `state.lastRun` snapshots the config; in `computeDone`, for single
(non-compare) density runs:

```
ratio       = clamp(actual_ms / predicted_raw, 0.2, 5)
corr_engine = clamp(0.5·corr_engine + 0.5·ratio, 0.2, 5)   // EMA, per engine
```

`corrBrowser` / `corrBackend` multiply future estimates. This converges to the
machine's and server's reality within a run or two, covering whatever residual
the structural model leaves.

## 6. Validation

### 6.1 The reported scenario (geral, budget 250, 24 census refs, backend)

| | value |
|---|---|
| Actual backend compute | 76.0 s (2 slices — as the model now predicts) |
| **Old estimate** | 20.9 s → **3.63× under** |
| **New estimate (first run)** | 82.6 s → **0.92** (estimate 8.7% over actual) |
| After online correction (run 1→3) | 0.96 → 0.98 → **0.99** |

### 6.2 Browser path

- geral @250 (census): actual 202.7 s, estimate 220.4 s → **0.92**.
- aguapreta @50: **3.84× → ~1.0** (saturation fixed).
- Across the matrix, the cell-capped model holds the spread inside ~±25% where
  the old model spanned 0.62–3.98 (the remaining low-budget / saturation-edge
  cells are then cleaned by online correction).

### 6.3 Probe responsiveness

| DEM | probe wall time |
|---|---|
| geral (135 M) | ~1.1 s (≈1.5 s cold-cache) |
| centro (8.46 M) | ~1.7 s |
| aguapreta (0.55 M) | ~0.2 s |

All within the 3 s hard limit; the big DEM is near the ~1 s ideal.

### 6.4 Regression & end-to-end

- `node test-worker-pool.mjs` — density **bit-identical** (`max|Δ| = 0`;
  `maxSettled=0` does not touch the normal path); energy within `1e-3`
  tolerance (it is not bit-identical — f32 grouping). PASS.
- `node backend/test-backend.mjs` — **backend matches JS worker** (the `/health`
  change is parity-safe). PASS.
- Headless CDP — probe 632 ms on a 1.5 M synthetic DEM, estimate budget-monotonic
  (50 < 150 < 300 < full), a real compute completed (217 ms actual vs 187 ms
  estimate = within ±20%), correction applied live, **zero exceptions**.

## 7. Limitations & future work

- **First-estimate vs steady-state.** The first estimate is within ±~20%; the
  ±~1% accuracy depends on the online correction, which needs one completed run
  in a similar regime. A per-engine *scalar* correction assumes the model's
  *shape* is right and only the magnitude drifts; a large change in regime
  (e.g. budget 250 → 600) re-converges over a run or two rather than instantly.
- **Backend HTTP transfer** (the ~0.5–1.6 GB request/response on a huge DEM) is
  folded into the wall-clock the app reports and absorbed by the correction;
  it is not modeled explicitly. On a *remote* backend this term would be larger
  and is the next candidate to model.
- **Fixed exponents.** `EXPLORE_EXP` and `RATE_EXP` are terrain-averaged
  constants, not per-DEM fits — a deliberate choice: fitting an exponent from
  the narrow budget range an unsaturated probe can afford is noisy and
  extrapolates badly (a two-budget fit predicted 69 M explored vs 22 M actual).
  The fixed exponent + measured coefficient + online correction is more robust.
- **`beta`/`eta` changes** after the probe aren't reflected in the explored law
  (it knows only `alpha` + budget); second-order, not re-probed.
- **Round-trip leg-vs-total budget** (`Orçamento aplica-se a`) is correctly *not*
  a factor in the estimate: both modes bound each leg's Dijkstra by `eMax`
  (a leg can never exceed the total), so exploration cost is identical. Total
  mode only adds a cheap post-search filter (`forward + backward ≤ eMax`) on
  which round trips are *retained* (`energy-worker.js`), not on how many cells
  are explored — so the two read the same time, as they should.

## 8. Network-graph and interpolation phases (v16)

The v14 model above covers raster density. Two later-found gaps, both on the
network/vector path:

### 8.1 Graph mode was estimated with the raster model

"Follow the vectors" routes on the polyline graph (`graph-engine.js`), where a
Dijkstra is ∝ the graph's **edges**, not the DEM's cells. The estimate applied
the raster per-ref model (cost ∝ 135 M cells) → **~1000× over** (e.g. ~4.7 h
predicted for a run that takes ~5 s). Fix: a graph branch,
`perRef ≈ edges × GRAPH_MS_PER_EDGE × refs`, with the edge count from the built
graph (or the polyline segment count before it's built), online-corrected by
`corrGraph`.

### 8.2 Interpolation is a separate, often-dominant phase

The IDW fill (off-network cells, 8-direction ray search to `maxDist`) fills the
*whole* grid while the compute touches only network cells/edges — so on a
network-constrained run it's frequently the *larger* cost (~6–7× the compute on
a big DEM). The old term was a fixed `0.3 × full-grid-Dijkstra` fudge that
ignored `maxDist` entirely. Fix:
`interpMs ≈ INTERP_MS_PER_CELL · N · maxDist / poolN` (+ smoothing), with
`poolN = 1` for graph-mode interp (single worker) and the banded interp-pool
size for raster-constrained interp; online-corrected by `corrInterp`.

### 8.3 Phases are corrected independently

The estimate is now `compute_phase + interp_phase`, each with its own EMA
correction. This also fixes a regression from §5.4's single combined
correction: it compared actual (compute + interp) against a compute-only
prediction, inflating the compute correction so subsequent *plain* runs then
over-estimated. The density completion path times the two phases separately and
feeds each to its own factor; the compute factor keys by engine
(`corrBrowser` / `corrBackend` / `corrGraph`). Finally, the
Interpolate / Compute-on-graph / Constrain-to-network toggles (and
max-distance / smoothing) are now wired to re-run the estimate — they weren't
before, so changing them appeared to do nothing.

## 9. Reproducibility

**Regression / parity tests** — checked in and runnable now; must pass before
shipping engine or estimate changes:

```sh
node test-worker-pool.mjs
cd backend && cargo build --release && node test-backend.mjs
```

**The §2.1 factorial-sweep benchmarks** that produced this report's
measurements are *not* checked in (they depend on raw `.f32` extracts of the
DEMs in `/tmp`). To reproduce: extract each DEM's pixel band to a raw
`Float32Array`, load `densityField` standalone (brace-matched from
`energy-worker.js`, via `new Function`), run the cell-capped probe to build a
calibration, then compare `predictComputeMs` against measured `densityField`
(browser) and `POST /density` `elapsed_ms` (backend) over the factor sweep. The
census points map to grid cells via each DEM's `ModelTiepoint` origin and
`ModelPixelScale`.

## Appendix: constants

| Constant | Value | Where | Meaning |
|---|---|---|---|
| `EXPLORE_EXP` | 2.1 | app.js | explored ∝ reach^EXPLORE_EXP |
| `RATE_EXP` | 1.1 | app.js | perRef ∝ explored^RATE_EXP (cache degradation) |
| `NATIVE_SPEEDUP` | 1.6 | app.js | nominal native per-ref speedup (online-corrected) |
| `BW_CONTENTION` | 0.2 | app.js | per-extra-slice bandwidth penalty |
| `BACKEND_BYTES_PER_CELL` | 37 / 55 (round) | app.js ↔ main.rs | per-slice scratch+acc bytes/cell |
| `PROBE_MAX_SETTLED` | 1,000,000 | app.js | probe cell cap (also ≤ 0.4·N) |
| `PROBE_REFS` | 3 | app.js | spread probe refs |
| `GRAPH_MS_PER_EDGE` | 5e-5 | app.js | graph-mode per-edge cost (online-corrected) |
| `INTERP_MS_PER_CELL` | 5e-6 | app.js | IDW fill per cell per maxDist unit (online-corrected) |
| `INTERP_SMOOTH_MS_PER_CELL` | 5e-6 | app.js | smoothing per cell per pass |

See also `performance-formula.md` for the general compute-time model relating
time to reference count, budget, threads, and memory.
