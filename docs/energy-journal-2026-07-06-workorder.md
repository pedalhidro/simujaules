# Energy-model journal alignment — work order (2026-07-06, FINAL scope)

Goal: align this app with `../bicycling-energy-model/research/MODEL_COMPARISON_JOURNAL.md`.
**Read Entry 18 first** — it is the correction that sets this order's scope.

## History (why the scope shrank three times)

- **rev 1** proposed a totals-form "estimated energy" headline alongside the routed
  per-edge number → withdrawn (violates requirement 1 below).
- **rev 2 ("Option B")** proposed removing the per-edge descent clamp via Johnson
  potential reweighting (`φ = β·h`); **rev 2.5** was a 4-agent adversarial pass
  that hardened Option B's mechanism math (mode-aware recovery sign, round-trip
  cancellation, per-ref recovery ordering, reduced-space A\* heuristic). All of
  that math is internally correct — and **moot: the premise was refuted.** The
  pre-implementation audit proved the clamp NEVER fires, so the reweighting
  composes with an identity: zero routes and zero displayed numbers would change.
  Archived verbatim (with the refutation header) at
  `archive-energy-optionB-2026-07-06-moot.md`, kept in case a future cost-model
  change ever makes negative pre-clamp descent edges reachable.

## Binding product requirements (Danilo, 2026-07-06)

1. **Viewing energy ≡ routing energy.** One number everywhere; anything shown for a
   routed path/cell is the per-edge sum the search optimized.
2. **Dijkstra performance must not regress.** Edge costs stay O(1)-local; nothing
   path-history-dependent in the engine.

**Both already hold today.** No engine change is needed or permitted by this order.

## The finding (journal Entry 18)

Reproduce: `node ../bicycling-energy-model/data/activities/verify_v2edge_clamp.mjs`
(self-contained, exits non-zero on any violation).

- `v2Edge`'s trailing `max(0, e)` on descents is **provably dead code**: with the
  grade-local `ε(s) = clamp₀₁(min(1, (α/β)/s) − 0.13)`, the descent cost is
  `≥ 0.13·α·d` (gentle), `= 0.13·β·|dh|` (middle), `= α·d` (steep) — always > 0,
  for every parameter bundle incl. `kSmooth < 1` (margins only widen). Same bound
  as the A\* heuristic's `descFloor` derivation (`energy-worker.js` ~617–637).
  Numerically: 1.78 M-combo sweep, global min pre-clamp = +4.1e-4 kJ.
- Entry 17's "over-charges descents" strike targeted `regime_compare.mjs`'s R1a —
  ONE ride-frozen ε applied per edge under `max(0,·)` — which is **not** what this
  app computes. Journal Entry 18 + four inline corrections to Entry 17 record it.
- Jensen (convex `max(0, x−0.13)`): the app's grade-local ε gives slightly **more**
  descent credit than the champion's aggregate ε_geom, never less (equality on
  constant grade).
- **R1d ran (results in Entry 18, same day).** The dead-clamp claim held on real
  data (min pre-clamp descent edge **+4.6 J** across 1 402 rides — the clamp never
  fired once). But the Jensen prediction FAILED: grade-local ε is
  **resolution-sensitive**, and at the harness's 5 m grid steeper local grades
  collapse the descent credit (ε(s) → 0), overwhelming the convexity effect — R1d
  sits ABOVE the champion, losing the P. Paz endpoint 7.1 vs 5.8. At the app's
  native **~30 m grid it roughly ties the champion** (JAAM 4.2 vs 5.5, longões
  6.5 vs 6.7); at 5 m on noisy urban tracks it is catastrophic (censo 12.3%).
  Net for this app: **vindicated where indicted, and it runs at the resolution
  where its grade-local ε is least wrong** — but sub-30 m profiles are a real
  hazard (see the new WI-2 bullet).

## Work items (small; Sonnet-executable; one release)

### WI-1 — `refEnergyKJ`: mirror `epsGeom` exactly (the one code change)

`refEnergyKJ` (`app.js` ~8165) computes ε from the **lumped** mean descent grade
`s̄ = H₋/X₋` while its comment claims "drop-weighted". The champion's estimator
(`epsGeom` in `../bicycling-energy-model/data/activities/regime_compare.mjs` ~343)
is: resample the profile into **30 m cells**, accumulate the drop-weighted
`Σ h₋ᵢ·min(1, (α/β)/sᵢ) / H₋` over descending cells, then apply the −0.13 offset
and clamp₀₁ ONCE on the aggregate. Port that exactly — **including the 30 m cell
discretisation, which the R1d results demonstrated is load-bearing, not
incidental** (finer cells read steeper/noisier grades and collapse the credit:
censo at 5 m raw was 12.3% vs 4.6%). Decide with the diff whether the 30 m cells are
cut on the deadbanded or raw profile — mirror what `r0Champion`/`epsGeom` actually
compose in the harness (read the call site; do not re-derive from prose). This only
changes the *Geometria de referência* readout (imported/drawn tracks — not routed
paths), so requirement 1 is untouched.

### WI-2 — comments & docs (no behaviour change)

- `v2Edge` header comment (`energy-worker.js` ~15–18) and the Rust mirror
  (`backend/src/main.rs::v2_edge`), plus `graph-engine.js`'s `stepCost`: note the
  trailing `max(0,·)` is provably unreachable (Entry 18 / the `descFloor` bound)
  and is kept ONLY as defensive bit-parity code — never remove it on one side
  alone, and never remove it at all without re-running the Entry 18 proof against
  the changed formula.
- `epsOffset: 0.13` provenance (`app.js` ~757, worker header): now cross-validated
  on 3 independent riders + the author's full export (journal Entries 12/14/16).
- `CLAUDE.md` invariants: record requirement 1 (viewing ≡ routing energy — holds by
  construction) and requirement 2 (edge costs local/cheap), so no future change
  introduces a second "estimated energy" for routed paths or a path-dependent cost.
- If `docs/performance-formula.md` / the presentation echo Entry 17's "per-edge
  over-charges descents" claim about this app, correct per Entry 18.
- Do **NOT** ship any help-modal sentence about a "known conservative descent
  bias" — refuted; the app has no such bias.
- **Resolution sensitivity — now MEASURED (journal Entry 19, 922 SP rides on
  the deployed `dem/sampa_geral.tif`), and the decision rule TRIGGERED.** The
  usual input is the IGC-SP 5 m DTM, and both engines sample ε at the DEM cell
  size (`graph-engine.js` `stepCells = 1`). Measured on real rides vs ∫P·dt:
  v2Edge at 5 m over-charges by **+9.4 pp** (censo group rides) / **+3.6 pp**
  (pooled independent riders, n=864) relative to the same raster at 30 m — both
  mechanisms confirmed (h₊ roller inflation on 919/922 rides; drop-weighted ε
  0.414@5 m vs 0.456@30 m pooled). Absolute deployed bias: pooled median
  **+9.5%** high at 5 m, **+6.3%** at 30 m (the residual is the base
  grade-local-ε-vs-aggregate gap, not resolution). Actions:
  1. Ship the disclosure in THIS release: help-modal note (PT+EN via `STRINGS`)
     and a `CLAUDE.md` line — the v2 model behaves best near ~30 m sampling; on
     5 m DTMs energies read conservatively HIGH (measured ~+9% median on SP
     rides) and descent-heavy routes are relatively over-charged.
  2. **Roadmap item (journal-backed, per the Entry-19 decision rule): a STATIC
     ~30 m pre-smoothing of the height raster at DEM load** — per-DEM
     preprocessing, keeps 5 m cell spacing and O(1)-local edge costs, so it
     satisfies both binding requirements. Entry 19's igc30 column IS its
     measured preview: censo 22.1 → 12.3, pooled 9.6 → 7.1 med |Δ%|. Its own
     release, with UI knob + journal cross-reference — NOT part of this order.
  3. **FABDEM warning (Entry 19 secondary):** do NOT use FABDEM for energy
     work on flat/urban terrain — its per-pixel noise inflates h₊ by +57%
     median (up to +135% on flat corpora) and v2Edge amplifies it (pooled
     17.6% vs 7.1% med |Δ%| against the IGC 30 m). The validated local survey
     is load-bearing; note this wherever the app's FABDEM loader is documented.

### Explicit do-NOT-do list

- **No engine-trio changes** (`energy-worker.js` / `graph-engine.js` /
  `backend/src/main.rs`). Reweighting is a proven no-op; the dead clamp stays
  (parity + defense); regime decomposition / time-model / braking-ε all remain
  rejected (Entries 8/10/13/17).
- No parameter-default changes; no k_DEM/k_h corrections (Entry 6 TODO still
  open); no elevation deadband in the engine (requirement 2).
- The pending Phase-2 aero-taper item
  (`docs/review-2026-07-02-round2-workorder.md`) stays its own separate change —
  and if it ever lands, re-run `verify_v2edge_clamp.mjs` against the tapered
  formula (the dead-clamp proof is formula-specific).

## Verification & release

- Extend `test-energy-v2.mjs`:
  1. `refEnergyKJ` vs a hand-computed `epsGeom` profile — a mixed-grade descent
     where lumped vs drop-weighted visibly differ, and a constant-grade profile
     where they must agree exactly.
  2. Clamp-neutrality guard: `v2Edge`'s output ≡ the unclamped descent expression
     over a (dist, grade, params) sweep — machine-checks that the Entry 18 proof
     stays true if the cost model ever changes.
- All suites pass (engine untouched ⇒ unchanged): `node test-worker-pool.mjs`,
  `test-energy-v2.mjs`, `test-graph-engine.mjs`, `test-water-raster.mjs`;
  `cd backend && cargo build --release && node test-backend.mjs`.
- Browser check: reference-geometry energy readout + help modal, PT and EN.
- Ship as one release: bump `sw.js` `VERSION`, move the changelog trio
  (`CHANGELOG.md` + help-modal `<details>` + `sw.js` comment), commit authored as
  Claude with Danilo as co-author (see `CLAUDE.md`).
