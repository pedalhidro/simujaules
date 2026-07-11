# Research note — move-grid connectivity bias in terrain-mode optimal energy

**Date:** 2026-07-11 · **Status:** analysis complete, no engine change shipped
**Harness:** `docs/grid-sens.mjs` (self-validating; reproduction §10)
**Cross-ref:** intended as an entry for
`../bicycling-energy-model/research/MODEL_COMPARISON_JOURNAL.md` (the journal
lives in the sibling `bicycling-energy-model` repo, not here); relates to
journal Entries 18–20 as described in §2.

## Abstract

Terrain mode routes on an 8-connected raster, so its "optimal" energies are
upper bounds on the continuum optimum: paths jag between the 8 discrete
headings. We measure that bias on a real DEM against a converged ladder of
move sets — square 4/8/16/32/64/128 (Farey heading subdivisions) and
hexagonal 6/12 — with a flat-terrain control that reproduces each lattice's
theoretical worst case. On the deployed IGC-SP 5 m DTM (v55 smoothing,
UI-default physics) the app's 8-move grid reads **+12.7 % median (+21 %
mean, +47 % p90)** above the near-continuum optimum at route scale, and
**undercounts budget-reachable area by ~19 %**; at 30 m the figures are
+8.1 % median and ~15 %. This is roughly **double** the pure octile-geometry
prediction: the dominant mechanism is not distance inflation but forced
height oscillation around contour lines under the asymmetric climb/descent
cost. A 16-move set recovers ≈ ⅔ of the bias — but only with
profile-integrated long edges; the naive endpoint-Δh generalization flattens
the relief its edges cross and flips to *under*-estimating (−1 % to −8.5 %
median at 30 m), destroying the upper-bound guarantee. Hex lattices are not
competitive. The original 8-over-4 choice is strongly validated.

## 1. Motivation and question

Suspicion (Danilo, 2026-07-11): terrain mode overestimates optimal energy
because of route jaggedness from the 8-cell move grid. Requested: a
sensitivity analysis vs a 16-cell neighborhood on a small DEM; extended to
4/64/128 and hexagonal 6/12 for completeness. The question matters because
(a) the energy field's absolute values feed the 300 kJ-initiative
accessibility KPIs (threshold counting is bias-sensitive), and (b) any fix
touches every bit-parity engine surface, so it needs quantified benefit
before a work order.

## 2. Relation to prior findings (journal Entries 18–20)

Distinct from, and additive in direction with, the known cost-model biases:

- **Entry 19** (resolution over-charge): `v2Edge`'s grade-local ε reads
  conservatively HIGH on fine DTMs (~+9 % median at 5 m vs ∫P·dt on real
  rides). That is a *cost-model* bias measured along fixed street routes.
- **This note** measures a *search-discretization* bias: even under a perfect
  edge cost, the 8-grid's optimal path is jagged, so route-optimal energies
  read high. The two mechanisms are independent and both one-sided positive
  on fine DTMs; they compound (not additively in any precise sense) toward
  conservative terrain-mode energies.
- **Entry 18 / the O(1)-locality requirement** constrains remedies: profile
  integration of long edges (§4) keeps edge costs O(1)-local (fixed ≤ 2·max
  sample count per edge), so a 16-move engine would not violate the
  no-path-history invariant.

## 3. Hypotheses (stated before the runs)

- H1: E8 > continuum optimum, with the flat-geometry octile bound (≤ 8.24 %,
  direction-peaked at 22.5°) as the naive expectation.
- H2: a 16-move set removes most of the gap.
- H3 (methodological): naive endpoint-Δh long moves are confounded — they
  also change terrain sampling, over-crediting the richer neighborhoods.

H1 held but the naive expectation was wrong in an interesting way (terrain
doubles it and erases the direction signature, §6). H2 held (≈ ⅔
recovered). H3 held strongly — at 30 m the naive ladder crosses below the
true optimum (§5.3).

## 4. Method

**Harness.** `docs/grid-sens.mjs`, standalone node. Mirrors (hand-copied,
same rule as the repo's other mirror tests): `v2Edge` ← `energy-worker.js`;
`readCost`'s folded UI-default physics ← the `census/census-density.mjs`
mirror (m 75 kg, Crr 0.008, CdA 0.45, ρ 1.1, k_eff 0.97, P_flat 80 W →
aRoll 6.07e-3, aAero 8.12e-3, β 0.7585 kJ/m); v55 σ = 10 m pre-smoothing ←
the `test-dem-smoothing.mjs` mirror. Dijkstra relax rules mirror the worker
exactly (f32 E storage, f64 heap keys, settled-byte staleness filter).

**Validation gate.** Every run first executes the REAL `energy-worker.js` in
a sandbox and asserts the harness's own 8-move field is bit-identical
(max|Δ| = 0 kJ, zero finite-mismatches) — observed on all runs. The flat
control (§5.1) additionally reproduces each lattice's closed-form worst case.

**Move sets.** Square lattices by Farey/Stern–Brocot level: 8 → +mediants →
16 → 32 → 64 → 128 headings (levels 0–2 coincide with the coprime
max-norm ≤ R sets; 64/128 are the Farey continuations). Square-4 (von
Neumann) as a degenerate baseline. Hexagonal lattices (node spacing = the
raster's min pixel, heights bilinearly resampled from the same smoothed
raster): hex-6 (60° headings) and hex-12 (+the √3-length 30°-offset moves).
**Square-128 is the reference**; square-64 lands within 0.2–0.9 % of it
everywhere, so the ladder has converged and "vs continuum" below means "vs
sq128".

**The confound and its control (H3).** A long move costed from its
endpoints' Δh alone *skips the relief under it*. With climb at
β ≈ 0.76 kJ/m against ≈ 0.014 kJ/m flat travel, skipping one 1 m bump fakes
more saving than ~50 m of route straightening — a terrain-resampling change
masquerading as a jaggedness fix. All long moves are therefore
**profile-integrated**: bilinear height samples every ~1 cell along the
segment, `v2Edge` summed per sub-segment (2·max(|dr|,|dc|) sub-steps; hex √3
moves in 2 sub-steps). Naive endpoint-Δh variants of square-16/32 are run
separately to size the artifact. Long moves also require their swept cells
passable (supercover sampling), so they cannot tunnel through nodata.

**Conditions.**
1. *5 m:* central-SP crop of the deployed `sampa_centro.tif` (IGC 5 m DTM),
   900×900 px ≈ 4.4×4.8 km, σ = 10 m smoothing per the v55 auto rule,
   4 spread sources.
2. *30 m emulation:* 1500×1500 crop anti-alias-smoothed (σ = 15 m) and 6×
   decimated → 250×250 at ~30 m, no further smoothing (matching how a
   coarse source is used in-app), 6 sources.
3. *Flat control:* heights constant, 700×700, 2 sources — isolates pure
   lattice geometry.

**Statistic.** Overestimate `E_mode/E_sq128 − 1` over all target cells
≥ 800 m from the source (0.3–13 M targets per condition; hex evaluated at
hex nodes mapped to the nearest raster cell). No energy budget (eMax 0), so
no truncation interacts. Reach = area within the median of each source's own
E8 field.

## 5. Results

### 5.1 Overestimate vs the near-continuum optimum (median / mean / p90)

| move set | 5 m DTM (smoothed) | 30 m emulation | flat median | lattice-theory max (observed) |
|---|---|---|---|---|
| square-4 | 31.0 % / 47.6 % / 102 % | 27.8 % / 33.7 % / 61 % | 32.0 % | 41.4 % (41.3 %) ✓ |
| hex-6 | 18.1 % / 29.3 % / 63 % | 14.1 % / 16.8 % / 32 % | 11.3 % | 15.5 % (16.2 %) ✓ |
| **square-8 (app)** | **12.7 % / 21.3 % / 47 %** | **8.1 % / 9.7 % / 18 %** | **5.7 %** | 8.24 % (9.2 %) ✓ |
| hex-12 | 7.9 % / 12.9 % / 28 % | 3.8 % / 4.7 % / 9.8 % | 2.5 % | 3.5 % (4.2 %) ✓ |
| square-16 | 5.8 % / 9.0 % / 19 % | 2.7 % / 3.2 % / 5.9 % | 1.2 % | 2.8 % ✓ |
| square-32 | 2.1 % / 3.1 % / 6.6 % | 0.9 % / 1.0 % / 1.8 % | 0.25 % | 0.7 % ✓ |
| square-64 | 0.6 % / 0.9 % / 2.0 % | 0.14 % / 0.2 % / 0.5 % | 0.05 % | — |

(Flat-control maxima slightly exceed the single-lattice theory values because
the reference sq128 has its own ~0.1–1 % residual; the agreement is the
validation, not a coincidence.)

### 5.2 The direct question: 8 vs 16 (profile-integrated)

| | 5 m | 30 m | flat |
|---|---|---|---|
| E8/E16 − 1 median | **6.9 %** | 3.9 % | 3.8 % |
| E8/E16 − 1 mean / p90 | 10.6 % / 22.6 % | 4.2 % / 6.0 % | 3.9 % / 7.0 % |
| E8/E32 − 1 median | 10.4 % | 5.7 % | 5.1 % |

### 5.3 The naive-edge artifact (H3), isolated

Median vs continuum, naive endpoint-Δh long edges (true profile value in
parentheses):

| | 5 m | 30 m |
|---|---|---|
| square-16 naive | +5.1 % (+5.8 %) | **−1.3 %** (+2.7 %) |
| square-32 naive | −0.2 % (+2.1 %) | **−8.5 %** (+0.9 %) |

At 30 m the naive edges span 60–90 m and flatten whole hillocks: the sign of
the error flips. Where a naive ladder lands near zero (sq32-naive at 5 m) it
is two large errors cancelling, not accuracy.

### 5.4 Budget reach (what the accessibility KPIs feel)

Area reachable within the median of each source's E8 field, relative to
square-8:

| | square-4 | hex-6 | square-8 | hex-12 | square-16 | square-32 | continuum |
|---|---|---|---|---|---|---|---|
| 5 m | −21 % | −7.6 % | 0 | +7.2 % | +10.7 % | +16.1 % | **+19.0 %** |
| 30 m | −23 % | −9.7 % | 0 | +6.0 % | +9.6 % | +13.2 % | **+14.9 %** |

### 5.5 Runtime (harness, 810 k cells, per source)

sq8 ≈ 0.7 s; sq16 profile ≈ 2 s (~2.5–3×); sq32 ≈ 4 s; sq64 ≈ 12 s;
sq128 ≈ 20 s. Memory unchanged (same per-cell arrays).

## 6. Mechanism: why terrain doubles the geometric penalty

On flat ground the E8/E16 gap follows octile theory exactly: medians rise
0.8 % → 6.9 % from on-axis to 22.5–30° and fall back — the classic
direction signature. On real terrain that signature vanishes (5.7–7.8 %
medians across ALL headings at 5 m) and the overall gap doubles. The
dominant cost is not extra path length but **height oscillation**: an 8-grid
path following a contour line must zigzag across it, and the asymmetric cost
(climb charged at β, descent refunded at ε·β with ε ≤ 1 − 0.13) taxes every
oscillation cycle. Finer heading sets track contours instead of chopping
across them. Consistently: the bias grows with terrain detail (5 m > 30 m >
flat), and is largest in high-relief subareas (p90 47 % at 5 m).

## 7. Threats to validity

- **Reference ≠ true continuum.** sq128 is a lattice too; but sq64→sq128
  moves < 1 %, so remaining truncation is second-order vs the reported gaps.
- **Between-cell terrain is modeled**, as the bilinear surface (sub-sampled
  every ~1 cell on long edges). Finer sub-stepping would charge long edges
  slightly more, shrinking the reported gaps marginally — the direction of
  this error makes the headline numbers mild upper bounds on the pure
  jaggedness effect.
- **Free-terrain optimum is not physical ground truth.** Real riding is
  street-constrained (graph mode is unaffected by all of this). The study
  measures terrain mode against its own continuum limit — the right target
  for "does the grid bias the field", not for "is the number the rider's
  kJ" (that is per-rider calibration territory, Entry 20).
- **One geography, one cost bundle.** Central São Paulo relief; UI defaults
  (80 W). The mechanism scales with β/(aRoll+aAero) ≈ 53:1, so heavier
  climb-dominance ⇒ larger bias; a strong-rider bundle would shrink it
  somewhat. Not swept here.
- **The 30 m condition is an emulation** (anti-aliased decimation of the
  5 m survey), not a real 30 m product like FABDEM (whose per-pixel noise is
  a separate, documented hazard).
- Sample sizes are millions of target cells but spatially correlated;
  figures are descriptive distributions, not independent draws.

## 8. Implications for the app

1. Terrain-mode optimal energies are **grid-native upper bounds**: ~13 %
   median (5 m) / ~8 % (30 m) above the continuum optimum at route scale.
   The 300 kJ-KPI counting is therefore a **conservative floor**
   (accessible area within a median budget undercounted ~15–19 %). The bias
   direction never flips under the current engine — a safety property worth
   keeping deliberately.
2. If tightening is wanted, **square-16 with profile-integrated knight
   moves** is the sweet spot: recovers ≈ ⅔ of the bias at ~2.5–3× relax
   cost, stays O(1)-local, keeps the upper-bound property. Square-32 gets
   within 1–2 % at ~3× more again.
3. **The naive 16/32 implementation must never ship** — it silently
   converts a bounded overestimate into an unbounded-sign resampling error
   (§5.3). Any work order must specify profile integration and re-run this
   harness as the acceptance test.
4. Hex lattices are dominated (hex-6 worse than the current grid; hex-12
   between 8 and 16 for a full lattice rewrite). Square-4 would have been
   catastrophic — the original 8-choice is vindicated.
5. Scope of an eventual 16-move work order: `dijkstra()`, `densityField()`,
   the Rust port (+`test-backend.mjs` parity), portal composition, passes
   semantics, `densityPoolSize`/`estimateRunTime` constants, and the A*
   heuristic (a 16-heading octile-style lower bound). Until then, the honest
   framing above costs nothing.

## 9. Pre-registered predictions for a 16-move engine (if built)

To be checked by re-running this harness's acceptance criteria against the
real engine: (a) field-median energy drops 5–8 % on the 5 m DTM, 3–5 % at
30 m; (b) budget-reach area grows 9–11 % (5 m); (c) density-run wall time
grows ≤ 3×; (d) passes corridors sharpen along contour lines (visual);
(e) bit-parity JS↔Rust preserved including the profile sub-sampling order.

## 10. Reproduction

```sh
cd docs
curl -O https://simujaules.pedalhidrografi.co/dem/sampa_centro.tif   # 34 MB
(cd ../census && npm install)                                        # geotiff
node grid-sens.mjs --sources 4 --crop 500,1200,900,900               # 5 m ladder (~3 min)
node grid-sens.mjs --sources 6 --crop 500,1200,1500,1500 --decimate 6  # 30 m (~1 min)
node grid-sens.mjs --sources 2 --crop 700,1300,700,700 --flat        # flat control
```

Every run self-validates its 8-move engine bit-identical against
`energy-worker.js` before reporting. Nothing here ships (`deploy.sh` stages
an explicit file list; `docs/` never deploys).
