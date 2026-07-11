# Grid-connectivity sensitivity: does the 8-move grid overestimate optimal terrain energy?

**2026-07-11 · harness: `docs/grid-sens.mjs` · verdict: yes — and terrain roughly
doubles the penalty that pure geometry predicts.**

## Question

Terrain mode routes on an 8-connected raster. Between the 8 discrete headings,
optimal paths come out jagged, so the "optimal" energies the app reports are
upper bounds on the true (continuum) optimum. How large is that bias, and what
would richer move sets buy? Compared here, all on the same terrain:

- **square lattices** with 4, 8 (the app), 16, 32, 64, 128 moves
  (Farey/Stern–Brocot heading ladders; 16 = +knight moves);
- **hexagonal lattices** with 6 and 12 moves (bilinear-resampled onto a hex
  grid at the same node spacing);
- square-**128** as the near-continuum reference (square-64 sits within
  0.2–0.9 % of it, so the ladder has converged).

## Method — and the one methodological trap

`docs/grid-sens.mjs` mirrors the app exactly where it matters: `v2Edge` (the
engine's cost), `readCost`'s folded UI-default physics (via the
`census/census-density.mjs` mirror), and the v55 σ = 10 m DEM pre-smoothing
(via the `test-dem-smoothing.mjs` mirror). Before any comparison it runs the
REAL `energy-worker.js` in a sandbox and asserts its own 8-neighbor field is
bit-identical (`max|Δ| = 0`, zero finite-mismatches — checked on every run).

**The trap: naive long moves are not a jaggedness fix.** A knight move costed
from its endpoints' Δh alone *skips the relief under it* — on a DEM every long
edge silently flattens the terrain it crosses, and with climb at
β ≈ 0.76 kJ/m against flat travel at ≈ 0.014 kJ/m, skipping a single 1 m bump
fakes more saving than 50 m of route straightening. So all long moves here are
**profile-integrated** (bilinear height samples every ~1 cell, `v2Edge` summed
per sub-segment): same terrain sampling as the unit grid, richer headings
only. The naive variants are reported separately to size the artifact. Edge
costs stay O(1)-local either way (a fixed ≤ 2·max(|dr|,|dc|) samples per
edge), so profile integration is compatible with the engine's
no-path-history invariant.

**Setup.** Central São Paulo crop of the deployed IGC 5 m DTM
(`sampa_centro.tif`, 900×900 px ≈ 4.4×4.8 km, smoothed σ = 10 m per the v55
auto rule), 4 spread sources; a 30 m emulation (anti-aliased 6× decimation,
no further smoothing — matching how a coarse source is actually used) with 6
sources; and a flat-terrain control (heights constant). Statistics over all
target cells ≥ 800 m from the source (0.3–13 M targets per condition).
Overestimate = `E_mode / E_sq128 − 1`.

## Results

### Overestimate vs the near-continuum optimum (median / mean / p90)

| move set | 5 m DTM (smoothed) | 30 m emulation | flat control (median) | lattice theory max |
|---|---|---|---|---|
| square-4 | **31.0 % / 47.6 % / 102 %** | 27.8 % / 33.7 % / 61 % | 32.0 % | 41.4 % ✓(41.3) |
| hex-6 | 18.1 % / 29.3 % / 63 % | 14.1 % / 16.8 % / 32 % | 11.3 % | 15.5 % ✓(16.2) |
| **square-8 (the app)** | **12.7 % / 21.3 % / 47 %** | **8.1 % / 9.7 % / 18 %** | **5.7 %** | 8.2 % ✓(9.2) |
| hex-12 | 7.9 % / 12.9 % / 28 % | 3.8 % / 4.7 % / 9.8 % | 2.5 % | 3.5 % ✓(4.2) |
| square-16 | 5.8 % / 9.0 % / 19 % | 2.7 % / 3.2 % / 5.9 % | 1.2 % | 2.8 % ✓ |
| square-32 | 2.1 % / 3.1 % / 6.6 % | 0.9 % / 1.0 % / 1.8 % | 0.25 % | 0.7 % ✓ |
| square-64 | 0.6 % / 0.9 % / 2.0 % | 0.14 % / 0.2 % / 0.5 % | 0.05 % | — |

(The flat control reproduces each lattice's theoretical worst case — ✓ values
are the observed maxima — which is what makes the terrain numbers credible.)

### The direct question: 8 vs 16

| | 5 m DTM | 30 m emulation | flat |
|---|---|---|---|
| E8/E16 − 1, median | **6.9 %** | 3.9 % | 3.8 % |
| E8/E16 − 1, mean / p90 | 10.6 % / 22.6 % | 4.2 % / 6.0 % | 3.9 % / 7.0 % |
| E8/E32 − 1, median | 10.4 % | 5.7 % | 5.1 % |

### Naive endpoint-Δh long edges (the artifact, isolated)

| | 5 m | 30 m |
|---|---|---|
| square-16 naive, median vs continuum | +5.1 % (vs +5.8 % true) | **−1.3 %** (vs +2.7 % true) |
| square-32 naive, median vs continuum | −0.2 % (vs +2.1 % true) | **−8.5 %** (vs +0.9 % true) |

At 30 m pixels a naive 16/32-neighborhood **under**estimates — its 60–90 m
edges flatten whole hillocks. Where a naive ladder happens to land near zero
(sq32-naive at 5 m) it is two large errors cancelling, not accuracy.

### Reach within an energy budget (drives the accessibility KPIs)

Area reachable within the median of each source's own E8 field:

| | square-4 | hex-6 | square-8 | hex-12 | square-16 | square-32 | continuum |
|---|---|---|---|---|---|---|---|
| 5 m | −21 % | −7.6 % | baseline | +7.2 % | +10.7 % | +16.1 % | **+19.0 %** |
| 30 m | −23 % | −9.7 % | baseline | +6.0 % | +9.6 % | +13.2 % | **+14.9 %** |

### Direction dependence

On flat terrain the E8/E16 gap peaks at 22.5–30° off-axis exactly as octile
theory predicts (0.8 % → 6.9 % → 1.0 % across the fold). On real terrain the
direction profile is nearly FLAT (5.7–7.8 % medians across all headings, 5 m).
The dominant mechanism is not distance inflation but **height oscillation**:
a jagged path zigzags across the contour line it should follow, and the
asymmetric cost (climb charged at β, descent refunded at ε·β with
ε ≤ 1 − 0.13) taxes every oscillation. That's also why terrain roughly
doubles the flat-geometry penalty (5.7 % → 12.7 % median at 5 m) and why the
bias is larger on the fine DTM (more contour detail to oscillate around).

## What this means for the app

1. **Confirmed and quantified.** Terrain-mode "optimal" energies read ~13 %
   (median; 21 % mean, 47 % p90) above the free-terrain optimum on the
   deployed 5 m DTM at route scale, ~8 % median at 30 m. Field-wide, budget
   reach (the 300 kJ-KPI counting) undercounts accessible area by ~15–19 %.
   The bias is one-sided (grid results are upper bounds), so KPIs computed on
   the 8-grid are conservative floors.
2. **A 16-move upgrade recovers ≈ ⅔ of the bias** (12.7 → 5.8 % median at
   5 m; 8.1 → 2.7 % at 30 m) — but ONLY with profile-integrated knight moves.
   Measured harness cost: ~2.5–3× the 8-move relax work (16 edges, the 8 long
   ones at 3–4 height samples each); memory unchanged. 32 moves get within
   1–2 % of continuum at ~3× more again; past that is noise.
3. **The naive 16/32 implementation must be rejected outright** — at coarse
   resolution it flips the sign of the error (−1 % to −8.5 % median) by
   flattening relief, which is worse than the honest overestimate it
   replaces: it breaks the upper-bound guarantee.
4. **Hex lattices are not competitive**: hex-6 is worse than the current
   8-grid, hex-12 sits between 8 and 16 but needs a full lattice change for
   less benefit than square-16 on the existing raster.
5. **The original 8-over-4 choice is strongly validated** (square-4:
   +28–32 % median, catastrophic).
6. Adoption would touch `dijkstra()`, `densityField()`, the Rust port (all
   bit-parity surfaces), portals, passes semantics, and the runtime
   estimator — a real work order, not a knob. Interim honest framing:
   terrain-mode energies are grid-native upper bounds; network/graph mode is
   unaffected (real street geometry, no free-terrain jaggedness); absolute
   rider accuracy remains carried by per-rider calibration
   (`docs/energy-journal-2026-07-06-workorder.md`).

## Reproduce

```sh
cd docs
curl -O https://simujaules.pedalhidrografi.co/dem/sampa_centro.tif   # 34 MB
(cd ../census && npm install)                                        # geotiff
node grid-sens.mjs --sources 4 --crop 500,1200,900,900               # 5 m ladder (~3 min)
node grid-sens.mjs --sources 6 --crop 500,1200,1500,1500 --decimate 6  # 30 m (~1 min)
node grid-sens.mjs --sources 2 --crop 700,1300,700,700 --flat        # flat control
```

Every run self-validates its 8-neighbor engine against `energy-worker.js`
(bit-identical) before reporting. Not shipped (`deploy.sh` stages an explicit
file list; `docs/` never deploys).
