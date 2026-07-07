# Goal release work order — DEM pre-smoothing + calibration (v55, EXECUTED)

Goal (Danilo, 2026-07-07): routed-path prediction error < ±5% med |Δ%| with bias
< ±2% median signed Δ%, validated per-corpus on danlessa/ppaz/jaam held-out rides.
Evidence base: `bicycling-energy-model` journal **Entry 20** — pre-registered
train/validation protocol, **VALIDATION PASSED**: ppaz 3.69/+0.96,
jaam 2.74/+0.31, danlessa 4.94/+0.81 (n = 121/94/216 held-out rides) at the
frozen config σ\* = 10 m + per-rider fitted (CdA, Crr, kSmooth). Shipped as
**v55** per this order. Honest ablation (recorded in the entry): per-rider
calibration is the dominant lever (σ=0 calibrated also passes); σ\*=10 is the
validated deployed default and softens the uncalibrated fine-DEM bias.

Deployed baseline before this release (Entry 19): pooled +9.5% median
over-charge at 5 m. The two levers, both deployable:

1. **Static DEM pre-smoothing at load** (the Entry-19 roadmap item) — σ\* = 10 m.
2. **Per-rider calibration** of the existing parameter panel (CdA, Crr, kSmooth;
   mass at the rider's known value) — documented procedure in Entry 20, no new
   app code (fitted values are per-rider and live in the journal, not here).

## WI-1 — `smoothHeightsInPlace(height, mask, H, W, dxM, dyM, sigmaM)` in app.js

The EXACT scheme validated by the Entry-20 harness (its header documents it;
port verbatim — this was pinned pre-registration precisely so the app and the
evidence use one transform):

- Sequential per-axis mask-normalized Gaussian: rows first, then columns.
- Per-axis σ_px = sigmaM / pixelSizeM for that axis (dxM, dyM); truncation
  radius = ceil(3·σ_px); weights w_k = exp(−k²/(2σ_px²)).
- At each valid output cell, the smoothed value = Σ w_k·h[k] over VALID
  in-window cells / Σ w_k over the same cells (one rule handles borders and
  nodata holes). Invalid cells (mask 0) stay untouched and never contribute.
- In place on the height Float32Array; O(max(H,W)) temp buffers per pass —
  no full-size copies (the 135 M-cell Sítio Urbano DEM cannot afford ×2).

## WI-2 — wiring in `loadDemFromArrayBuffer` (app.js ~2552)

- Apply AFTER the mask build and BEFORE `state.dem = {...}` (single install
  point — verify the FABDEM loader also funnels through it; grep found exactly
  one `state.dem =` assignment).
- **Auto rule**: apply σ* when the DEM's min(dxM, dyM) ≤ ~10 m (i.e. fine DTMs
  like IGC-SP 5 m); skip for ≥ ~15 m sources (FABDEM 30 m is already at the
  model's happy scale — Entry 19). User-facing knob (new input, i18n via
  `STRINGS`): "auto / off / custom σ (m)". Changing it requires a DEM reload
  (smoothing is in-place; document in the help modal).
- **Reproducibility**: record the applied σ in `state.dem.smoothedSigmaM`,
  in bundle metadata, and as a GeoTIFF metadata tag on DEM export (exported
  DEMs ARE the smoothed surface — the surface results came from; on re-import,
  the tag suppresses re-smoothing so a round-trip never double-smooths).
- Bundle binary-replay: replayed results must reproduce — the bundle carries
  the smoothed raster + the tag, so replay applies σ=0. Add a replay test.
- `cancelActiveCompute()` already runs at DEM load; network graph + probe
  calibration are already invalidated per load — no extra invalidation needed,
  but VERIFY both against the smoothing insertion point.

## WI-3 — docs & release

- Help modal: what the smoothing is, why (journal Entries 19/20 — measured
  +9.4/+3.6 pp resolution over-charge at 5 m, validation numbers TBD), the
  auto rule, and the reload-on-change caveat. Update the v54 resolution
  disclosure to say the mitigation now ships (numbers from Entry 20).
- CLAUDE.md: update the "v2 model is tuned for ~30 m" invariant — the roadmap
  item is now implemented; state the auto rule and the double-smoothing guard.
- Per-rider calibration: document the Entry-20 procedure (fit CdA/Crr/kSmooth
  on your own rides at the deployed σ*) in the help modal or a docs/ page —
  values themselves live in the journal, not hardcoded here.
- Tests: extend `test-energy-v2.mjs` (or a new `test-dem-smoothing.mjs`) with
  a pure mirror of `smoothHeightsInPlace` — hand-computed 1-D cases (flat
  stays flat; a spike attenuates by the analytic kernel factor; hole cells
  untouched and non-contributing; border normalization), plus a tiny 2-D
  case cross-checked against the Entry-20 python reference on the same array.
- Full suite must stay green (engines untouched — smoothing is app-side
  preprocessing; heights ship identically to JS worker / graph / Rust, so NO
  parity implications). sw.js VERSION v55 + changelog trio + release commit
  convention.

## Do-NOT-do

- No engine changes (the cost trio stays byte-identical).
- No per-rider parameters hardcoded into the app.
- No smoothing of already-coarse DEMs (the auto rule) and no re-smoothing of
  tagged exports.
- If Entry 20's validation FAILS, stop at its fallback ladder — do not ship a
  σ that wasn't validated.
