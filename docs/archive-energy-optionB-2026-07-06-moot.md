# ARCHIVED — Option B (potential reweighting), verified rev — MOOT, do not implement

> **Status (2026-07-06, later the same day): withdrawn — premise refuted.**
> `v2Edge`'s descent clamp provably NEVER fires (grade-local ε keeps every
> descent edge ≥ 0.13·min(α·d, β·|dh|)-scale positive; see journal **Entry 18**
> and `bicycling-energy-model/data/activities/verify_v2edge_clamp.mjs`, a
> 1.78M-combo sweep). So the reweighting below composes with an identity: it
> would change ZERO routes and ZERO displayed energies. The tell is this
> document's own test 5, which requires "verify the OLD model's clamp would
> have fired" — that test cannot pass.
>
> This file is kept because the verification pass's *mechanism math* is
> correct and non-trivial (mode-aware sign of the potential recovery, exact
> round-trip cancellation, per-ref recovery-before-averaging, the reduced-space
> A\* heuristic `aRoll·distLB`, radix-heap scale-invariance, portal
> non-negativity) — worth having if a FUTURE cost-model change ever makes
> negative pre-clamp descent edges reachable. The live work order is
> `energy-journal-2026-07-06-workorder.md`.

## Energy-model journal alignment — work order (2026-07-06, Option B, verified rev) [original, verbatim]

Goal: align this app with `../bicycling-energy-model/research/MODEL_COMPARISON_JOURNAL.md`
(the energy law's spec repo; entries reverse-chronological, Entry 17 =
2026-07-06 is the newest) by removing the per-edge descent clamp via potential
reweighting, so viewing energy and routing energy are the same number
everywhere, with no performance cost. **Decision made 2026-07-06: implement
Option B.**

**This revision (2026-07-06, same day) is the output of an adversarial
verification pass** (4 independent agents, each given the actual code and
asked to prove or disprove a specific claim from scratch, including numeric
worked examples). It found **one real bug** in the original draft (a sign
error, below — confirmed independently twice, by two different numeric
examples), **two hedges that were unnecessary** (portal non-negativity and the
radix heap both needed no special treatment — proven, not assumed), and **one
scope reduction** (most path/route energy reporting doesn't need the
reduction machinery at all). Everything below reflects the verified state; do
not revert to the pre-verification framing.

## Binding requirements (Danilo, 2026-07-06)

1. **Viewing energy ≡ routing energy.** Any energy the app shows for a cell,
   path, or export must be the SAME number the router computed. No second
   "estimated" figure that disagrees with the field.
2. **Dijkstra performance must not regress.** Edge costs stay O(1)-local; no
   path-history-dependent term in the inner loop.

## The mechanism — Johnson-style potential reweighting

The current per-edge cost (`v2Edge` in `energy-worker.js`, mirrored as
`stepCost` in `graph-engine.js` and `v2_edge` in `backend/src/main.rs`) clamps
descents at zero: `max(0, aRoll·d + aAero·d − ε·β·|dh|)`. That clamp exists
ONLY because Dijkstra needs non-negative weights — it is not physics. It is
also exactly the thing Entry 17 identified as the source of the per-edge
model's descent over-charge: a cliff's credit can't be netted against a later
flat stretch because each edge is clamped independently.

Reweight every edge with the potential `φ(cell) = β · h(cell)` (β = mg/k_eff
kJ per metre of climb, already computed in `readCost()`). For an edge whose
**physical** direction of travel is origin→destination, `dh = h(dest) −
h(origin)`:

- **Uphill / flat** (`dh ≥ 0`): raw cost `aRoll·d + (dh < climbThr·d ? aAero·d : 0) + β·dh`.
  Reduced cost = raw − β·dh = `aRoll·d + (aero term)`.
  **The β·dh term cancels — one term FEWER than today.**
- **Downhill** (`dh < 0`, let `|dh|` be the drop): raw cost
  `max(0, aRoll·d + aAero·d − ε·β·|dh|)`. Reduced cost = raw + β·|dh| =
  (the pre-clamp value) `aRoll·d + aAero·d + (1 − ε)·β·|dh|`.
  Since `ε = clamp01(min(1, abRatio·d/|dh|) − epsOffset) ≤ 1 − epsOffset = 0.87`,
  `(1 − ε) ≥ epsOffset = 0.13 > 0`, so this is **strictly positive without any
  clamp or branch on sign** — the `max(0, ·)` is provably unnecessary once
  reweighted and can be deleted.

**Verified (portal non-negativity, CONFIRMED, no caveat needed).** Bridge
portals cost `v2Edge(deckLenM, dh, cost)` — the identical function, just fed a
deck length and an OSM/DEM elevation difference instead of a grid step
(`buildPortalAdj`/`build_portals`, confirmed by reading both). The
non-negativity proof above **never uses any relationship between `d` and
`dh`** — it holds for the climb branch because `β·dh` cancels exactly
regardless of `d`, and for the descent branch because `ε`'s two ordered clamps
(`min(·,1)` then `−epsOffset` then `max(·,0)`) force `ε ∈ [0, 1−epsOffset]` for
**any** ratio `abRatio·d/|dh|`, not just grid-typical ones. So it holds
verbatim for portals — long flat decks and short steep decks alike — with no
separate portal-specific proof required. (One harmless nuance: `beta` in code
is `mg·kSmooth/keff/KJ`, kSmooth-scaled, while `abRatio` is deliberately
un-smoothed — the proof never relies on `abRatio·beta` being any particular
value, so this doesn't affect the conclusion.)

**Verified (radix heap, CONFIRMED, no change needed — the original hedge
below was wrong).** *An earlier draft of this document worried that "radix
bucketing must be re-derived for the new (smaller) reduced-cost range." This
is false and should not be acted on.* Both the JS (`energy-worker.js`
`bucketOf`, densityField) and Rust (`RadixHeap`, `backend/src/main.rs`) radix
heaps bucket purely by the highest bit at which a pushed key's bits differ
from the last-popped minimum (`clz32`/`leading_zeros` on the XOR) — this is
scale-invariant by construction, works identically whether costs are ~0.01 kJ
or ~10,000 kJ, and bucket arrays grow dynamically. The *only* precondition
(stated explicitly in the Rust doc comment) is that priorities are monotone
non-decreasing, i.e. edges are ≥ 0 — which the proof above guarantees. Zero
code changes to either heap implementation. (Aside, worth knowing for testing:
Rust's `debug_assert!(key >= self.last)` is compiled out in `--release`, which
is how this project ships and tests — so a regression that DID introduce a
negative edge would silently misbehave in the shipped binary rather than
panic. The non-negativity test below should be run at least once against a
debug build so that assertion can catch what release mode won't.)

**Verified (A\* heuristic, CONFIRMED — this is the final formula, not a
"re-derive, likely simplifies" placeholder).** Under the reduced-cost model,
`h'(idx) = cost.aRoll · distLB` (distLB = straight-line remaining ground
distance) is admissible AND consistent, for every edge branch (uphill
non-climbing, uphill climbing, downhill) and **both** search directions,
because reduced cost is `≥ aRoll·d` unconditionally in every branch — the
climbing branch hits this floor exactly (aero dropped, no `β·dh` left to
subtract from), the other two branches have non-negative slack on top. The
admissibility/consistency proofs are the ordinary triangle-inequality
arguments on `distLB`. **This heuristic needs NONE of `climbThr`, `abRatio`,
`epsOffset`, or `beta`** — replace the whole `descFloor`/`climbFloor`/`minPerM`
block (energy-worker.js ~609-647) with this one line; `hGoal`, `height[idx]`,
and the `reverse`-conditioned climb ternary all become dead code. The
repulsion-penalty argument (top-N) is unaffected — it was already a
non-negative addition on top of the base cost, independent of this proof.

**Verified (`maxEdgeCost` bound, CONFIRMED unchanged — do not shrink it).**
*An earlier draft said this bound "should shrink" under reduction. It does
not — the formula is unchanged, only an in-code comment is stale.* The
existing bound `((aRoll+aAero)·diag + β·globalHeightRange) · 1.001` was
derived to cover the OLD model's worst case (the climb branch, which carried
`+β·dh`). Under reduction the climb branch's worst case shrinks (no `β·dh`
left), but the descent branch's worst case grows by the same amount (up to
`+β·|dh|`, since `(1−ε) ≤ 1`) — the two are algebraically identical in
magnitude, just attached to the opposite branch. So the SAME numeric formula
bounds both models; only the code comment ("Worst per-edge cost = rolling +
flat aero over the diagonal + the full climb term") needs rewording to
describe the descent-retained term instead. Portals are a non-issue here:
`maximize` mode already excludes portals entirely (existing code,
`portalAdj = maximize ? null : …`).

**Recovering true energy — mode-dependent sign (VERIFIED BUG in the original
draft, fixed here).** *An earlier draft of this document stated a single
formula `E_true[i] = E_reduced[i] + β·(h[i]−h[src])` for all cases. This is
only correct for forward searches and is WRONG for reverse ("to" mode)
searches — confirmed independently by two agents, each with their own
from-scratch numeric worked example (one found a 700%+ error using the wrong
sign). Do not implement the single-formula version.*

The reason: in reverse mode (`reverse=true`, used for "to" mode and for the
backward leg of round trips and round-mode density), the search's
traversal order and the PHYSICAL direction of travel are opposite — the seed
is the physical *destination*, not the physical *origin*, of the route being
accumulated. So the potential telescopes with the opposite sign:

```text
forward (reverse=false, seed=S, settled cell=X):
    E_true(X) = E_reduced(X) + β · (h(X) − h(S))      // physical route S → X

reverse (reverse=true, seed=S, settled cell=X):
    E_true(X) = E_reduced(X) − β · (h(X) − h(S))      // physical route X → S
             = E_reduced(X) + β · (h(S) − h(X))
```

Apply whichever formula matches the `reverse` flag already passed to that
search. This is now the ONE pair of formulas used everywhere a *live search's*
per-cell energy needs converting to true energy — see the call-site list
below for exactly which sites that is (fewer than you'd think — most
path/route reporting sidesteps this entirely).

**Round-trip mode needs NO recovery at all — sum the raw reduced values
directly (verified, and simpler than recovering each leg).** For any round
trip sharing one seed, the forward leg's `+β·(h(X)−h(seed))` and the backward
leg's `−β·(h(X)−h(seed))` correction terms are exactly equal and opposite, so
they cancel completely when the two legs are summed:

```text
E_reduced_fwd(X) + E_reduced_bwd(X)  =  E_true_fwd(X) + E_true_bwd(X)   (exactly, no residual)
```

This is a general fact about a potential around any closed walk back to the
same seed — it holds identically for the message-handler's simple round mode,
`densityField()`'s round branch (each reference point is its own independent
closed walk), and graph-engine's/the backend's round modes. **Do the simplest
thing: sum the two legs' raw `E_reduced` arrays with no conversion step, and
compare THAT sum against `eMaxTotalCap` directly** — it already equals the
true round-trip total. (The dangerous alternative — recovering each leg with
the *same*, mode-unaware formula before summing — doesn't cancel, it
**doubles** the error; do not do that.)

**Why this is also the totals-form fix Entry 17 asked for (illustrative, for
a forward-mode path S→goal).** Sum the reduced costs along the path and add
back `β·(h(goal)−h(S)) = β·(h₊ − h₋)`:

```text
E_true(path) = aRoll·X + aAero·X_nc + β·h₊ − β·Σ_i ε_i·h₋ᵢ
             = aRoll·X + aAero·X_nc + β·(h₊ − ε_dw·h₋),   ε_dw = Σ ε_i·h₋ᵢ / h₋
```

— exactly the champion's totals form with a genuinely drop-weighted `ε_dw`.
Cliffs net against flats automatically. Entry 17's "totals is the physically
faithful evaluation" and this repo's "one number, computed locally and fast"
turn out to be the same thing once the clamp — which was never physical — is
gone. **Note:** most concrete path/route energy reports (below) get this for
free via a much simpler mechanism than the reduction math — a plain re-walk
with the clamp deleted — so this derivation is presented to explain *why* the
reduction is correct, not as a literal recipe you need to implement at every
call site.

**Side effect (disclose, don't chase further).** DEM roller noise partially
self-cancels now (an up-then-down jitter bump refunds `ε·β·δ` instead of being
clamped away), directionally similar to the journal's Entry-5/7 deadband
correction — but do not add an explicit deadband (requirement 2 forbids
path-history state); this is a free, structural side benefit only.

## Scope — verified call-site classification

**Key simplification found by the audit: only "live field" energy (a whole
grid/graph's worth of per-cell values populated during an actual Dijkstra/A*/
density search) needs the reduction + mode-aware recovery machinery. Energy
reported for one ALREADY-KNOWN path (top-N routes, the layered max-cost DP,
graph-mode routes) mostly does NOT — it already works by re-walking the known
path and summing the per-edge cost fresh, and for that you only need to
delete `v2Edge`'s trailing `max(0,·)` (one line), no potential/reduction code
at all.** Below, every site is tagged **(a)** = needs the mode-aware recovery
formula, **(b)** = just needs the clamp deleted (clean re-walk over a known
path, or a DP with no non-negativity requirement), or **(c)** = unaffected /
comment-only.

### `energy-worker.js`

- **`v2Edge`** (~line 90-100): delete the trailing `return e < 0 ? 0 : e` →
  `return e;`. This one-line change is what realises (b) everywhere below for
  free; the reduced-cost variant (for (a) sites) is a SEPARATE function/inline
  transform used only inside the live search loops, not a replacement for
  `v2Edge` itself (top-N's re-walk and the DP below still need the plain,
  now-unclamped `v2Edge`).
- **`dijkstra()` grid + portal relax** (~lines 269-310): **(a)**. Cost pushed
  onto the heap is the reduced cost; both the `eMax` budget compare and the
  stored `E[nIdx]` need the mode-aware recovery applied (recovery can be
  applied once per settled cell right after popping it, using that search's
  fixed `reverse` flag — O(1), no regression). Prefer running the whole
  search in reduced space and converting to true energy only when writing the
  final output array, per requirement 2.
- **`densityField()` internal `search()` relax** (~lines 463-509): **(a)**,
  same shape as `dijkstra()`.
- **`densityField()` non-round accumulation** (~lines 519-529): **(a)**, with
  a nuance the original draft missed: **recovery must happen PER REFERENCE
  POINT, immediately after that ref's search completes and BEFORE its energy
  is added into the cross-ref `energySum`/`energyCount` accumulators** — each
  ref has its own seed, hence its own recovery constant, and you cannot
  un-mix an average after summing terms with different additive offsets.
- **`densityField()` round-mode combine** (~lines 530-548): per the
  round-cancellation result above, this needs **no recovery at all** — sum
  the raw forward (`E`) and backward (`E2`) reduced accumulators directly,
  and compare that raw sum against `eMaxTotalCap` directly. Delete the
  now-unnecessary "re-derive the radix bucket width" note from any earlier
  draft — confirmed unnecessary (see radix-heap verification above).
- **`onExplored`/`lastStopG` calibration probe** (~lines 457-478, 521, 533):
  **(c)**, not a correctness site, but its scale/magnitude will change
  (reduced vs. true cost) — flag for `app.js`'s `estimateRunTime()`
  calibration constants (`EXPLORE_EXP`/`RATE_EXP`/etc.), do not silently
  re-tune as part of this change (see Verification & release below).
- **A\* relax loop** (~lines 604-753): **(a)** for the search's own
  accounting (reduced cost + mode-aware budget compare, same as dijkstra);
  the repulsion penalty is added on top of the reduced base cost and is
  untouched by this change (it never involved `β`/`dh`).
- **A\* heuristic** (~lines 609-647): replace entirely with the verified
  `h'(idx) = cost.aRoll * distLB` (see above) — do not patch the old
  `descFloor`/`climbFloor` algebra, it no longer applies.
- **A\* top-N "true energy" re-walk** (~lines 1610-1630, `let trueE = ...; for
  (...) trueE += v2Edge(d, dh, cost);`): **(b)**. This ALREADY re-walks the
  known path and sums fresh `v2Edge` values with the correct per-mode `dh`
  sign — it needs nothing but the clamp deletion in `v2Edge` itself. Do not
  add reduction/recovery logic here. (Sub-case: when `maximize` is true,
  `trueE` stays `res.energy` unchanged — maximize uses its own unrelated
  `maxEdgeCost`-inversion, not this reduction, so no interaction as long as
  reduction stays scoped to non-maximize mode.)
- **`maxCostPathOfLength()` (layered DP, max-cost-path-of-length-L)**
  (~lines 1011-1166): **(b)**. This is a fixed-length Bellman-Ford-style DP —
  it has no priority queue and no non-negativity requirement, so it is simply
  OUT OF SCOPE for the reduction/recovery machinery. Once `v2Edge`'s clamp is
  deleted, `prev[goal]`/`dp.energy` are already true, correctly-netting
  energy with zero further changes. Do not thread reduced costs through this
  function.
- **Message-handler mode "from"** (~lines 1487-1501): **(a)** — apply the
  forward recovery formula to the WHOLE `energy` array (not just
  `energy[goalIdx]`) before it's used for field colors or `pathEnergy`.
- **Message-handler mode "to"** (~lines 1502-1516): **(a)** — apply the
  REVERSE recovery formula (opposite sign from "from") to the whole array.
  This is the site most likely to get the sign wrong if implemented by
  copy-pasting the "from" branch's logic — do not.
- **Message-handler mode "round"** (~lines 1517-1560): per the
  round-cancellation result, sum `f.E` (raw reduced) + `b.E` (raw reduced)
  directly with no recovery step, same as `densityField`'s round branch;
  compare that sum against `eMaxTotalCap` directly. `pathEnergy`/passes
  inherit correctness from this combine, no separate fix needed there.
- **`maxEdgeCost` computation and comment** (~lines 1376-1392): formula
  unchanged (verified above); reword the comment describing the worst-case
  regime (now descent-side, not climb-side).

### `graph-engine.js`

- **`stepCost()`** (~lines 104-116): same one-line clamp deletion as
  `v2Edge`, in lockstep (bit-parity invariant).
- **`directedCosts()`/`profileCost()`** (~lines 122-130, 613-625): these
  precompute TRUE per-edge totals (`costAB`/`costBA`) ONCE per run, walking
  each edge's internal elevation profile — already O(1)-per-edge for the live
  search (the profile walk happens at build time, not inside the relax loop,
  confirmed by reading the call site). **Implementation risk, be
  careful:** `costAB`/`costBA` are read by BOTH the live `dijkstra()` search
  (which needs REDUCED costs) and the clean re-walk helpers `pathEnergy()`/
  `topN()`'s reported route energy (which need the TRUE costs, unchanged).
  Do NOT overwrite `costAB`/`costBA` with reduced values. Either precompute a
  parallel `costABReduced`/`costBAReduced` pair once (each edge's reduced
  total = `costAB[e] - β·(nodeH[edgeB[e]]-nodeH[edgeA[e]])`, still O(1) per
  edge, computed once like `costAB` itself), or apply the potential inline,
  per-edge, inside `dijkstra()`'s relax loop only (reading the existing
  `costAB`/`costBA` and the two endpoint node heights it already has handy).
  Either way, `pathEnergy()`/`topN()`'s route-energy call keep consuming the
  unchanged, TRUE `costAB`/`costBA` — those sites are **(b)**.
- **`dijkstra()` relax loop** (~lines 630-655): **(a)**, same
  reduced-cost + mode-aware budget-compare-and-store pattern as the JS grid
  engine.
- **top-N base field** (`nodeEnergy[v]=base.E[v]`, ~line 819): **(a)** — same
  live-field pattern; **`topN()`'s own reported route energy** (`pathEnergy()`
  call, ~line 728) is **(b)**, already a clean re-walk over true costs.
- **density dispatch, non-round** (~lines 828-850): **(a)**, same per-ref
  recovery-before-cross-ref-sum nuance as the JS worker's `densityField`.
- **density dispatch, round; and mode "round"** (~lines 833-844, 854-868):
  per the round-cancellation result, sum raw forward+backward directly, no
  recovery, compare the raw sum against `totalCap` directly.
- **mode "from"/"to"** (~lines 869-877): **(a)**, same live-field pattern.
- **final path-energy assembly** (~line 889): the **round** branch inherits
  correctness from the round-mode `nodeEnergy` combine above (no separate
  fix); the **"from"/"to"** branch calls `pathEnergy()` — **(b)**, unchanged.
- **`maximizeWalk()`** (~lines 743-778): **(b)**, the graph-mode analogue of
  `maxCostPathOfLength()` — a fixed-L DP with no non-negativity requirement,
  out of scope for reduction, already-true energy once `stepCost`'s clamp is
  deleted.
- Graph-mode maximize (fixed in v52 to respect mode "to") and round-mode
  (fixed in v52 to sum fwd+bwd) must keep those v52 fixes working under the
  new cost model — regression-test both explicitly, they are recent and easy
  to silently re-break.

### `backend/src/main.rs`

**Higher risk than the JS engine, flag this prominently: the Rust backend has
no A\*/top-N/maximize-path/path-reconstruction of any kind — every single
energy value `/density` and `/single` return comes from a live Dijkstra's
`s.e` state. There is no clean-re-walk escape hatch here at all — 100% of
this file's energy-reporting surface is classification (a)**, unlike the JS
engine where top-N/the DP dodge the sign-flip risk entirely. Extra care and
extra test coverage here are warranted.

- Port identically: `v2_edge` (delete the clamp), `dijkstra_tree` (reduced
  cost + mode-aware recovery, mirroring the JS `dijkstra()` fix exactly),
  `build_portals`/`portal_cost` (reduced cost, no special portal proof needed
  per the verification above), `Acc::accumulate` (per-ref recovery before
  cross-ref summing, mirrors JS density non-round), `Acc::accumulate_round`
  and `compute_single`'s round branch (sum raw forward+backward directly, NO
  recovery, per the cancellation result — mirrors JS round combine exactly),
  `compute_single`'s non-round branch (`let energy = s.e.clone();` — apply
  the mode-aware recovery to the whole array before cloning/returning).
- `Scratch.passes` (f32, density-only) and `Acc`/`energySum` (f64) dtype
  invariants are UNCHANGED by this work (reweighting doesn't touch passes
  counting) — do not touch dtype choices.
- Because `debug_assert!(key >= self.last)` in the radix heap is compiled out
  in `--release` (this project's normal build/test mode), a sign-flip
  regression here would NOT panic — it would silently return wrong energies.
  Run the new non-negativity/parity tests below against a debug build at
  least once specifically to exercise that assertion as an extra safety net,
  in addition to the normal `--release` test run.
- `node backend/test-backend.mjs` fixtures WILL need regeneration since the
  model output changes (routes/energies differ from the old clamped model).
  This is expected — call it out explicitly in the PR/commit, do not treat
  fixture diffs as a red flag to revert.

## Explicit do-NOT-do list

- No regime-decomposed cost, no time-model descent-bridge term, no
  braking/curviness ε penalties — all tested and rejected/refuted in the
  journal (Entries 8, 10, 13, 17). This work order is ONLY the potential
  reweighting; it does not reopen any of those.
- No parameter-default changes (CdA 0.45 / Crr 0.008 / etc. — Entry 16: fitted
  CdA is the aero-position value, wrong for whole-ride prediction).
- No k_DEM / k_h DEM-source correction (Entry 6's per-source fit is still an
  open TODO, never measured). `kSmooth` stays the user knob, default 1.
- Do not fold in the pending Phase-2 aero-taper item from
  `docs/review-2026-07-02-round2-workorder.md` in the same change — it touches
  the same formula and must land in its own follow-up commit against the
  NEW reduced-cost baseline, never mixed into this one.
- Do not add an explicit elevation deadband to the engine (requirement 2 —
  edge costs must stay path-history-free). The roller-noise self-cancellation
  described above is a side effect of the math, not a new stateful filter.
- Do NOT thread reduced costs through `maxCostPathOfLength()` (JS) or
  `maximizeWalk()` (graph-engine) — verified out of scope, see above.
- Do NOT apply a single, mode-unaware recovery formula anywhere, and do NOT
  recover each round-trip leg independently before summing (both are proven
  wrong/unnecessary above — this is the single highest-risk mistake in this
  change; re-read the "Recovering true energy" section before touching any
  `reverse`-aware code path).
- Do NOT overwrite `graph-engine.js`'s `costAB`/`costBA` arrays with reduced
  values — they must stay true costs for `pathEnergy()`/`topN()`'s re-walk to
  keep working; use a parallel array or an inline in-loop transform instead.

## Verification & release

- **New tests** (extend `test-energy-v2.mjs` and/or a new
  `test-reweighting.mjs`):
  1. Reduced cost ≥ 0 for a sweep of grades from −100% to +100% (grid AND
     portal), including the boundary `ε = 1 − epsOffset`. Run this sweep at
     least once against a **debug** build of the Rust backend too (not just
     `--release`), so `debug_assert!` can catch what release mode silently
     wouldn't.
  2. **Sign test (the highest-value new test):** for a small synthetic
     multi-cell profile with a genuine climb and a genuine descent, verify
     BOTH: (i) forward-mode `E_reduced[goal] + β·(h[goal]−h[src])` equals a
     direct sum of the unclamped `v2Edge` costs along the path in the S→goal
     direction; AND (ii) reverse-mode `E_reduced[goal] − β·(h[goal]−h[src])`
     (opposite sign!) equals a direct sum of the unclamped `v2Edge` costs in
     the goal→S direction. Assert that using the WRONG sign on the reverse
     case fails the test by roughly `2·β·(h[goal]−h[src])` — i.e. the test
     must be discriminating, not just checking the right answer once.
  3. **Round-trip cancellation test:** for the same synthetic profile, verify
     that summing the raw forward and backward `E_reduced` arrays (no
     recovery at all) equals the true round-trip total (forward physical cost
     + backward physical cost, each computed by a direct unclamped `v2Edge`
     sum in its own physical direction).
  4. **Per-ref density accumulation test:** two reference points with
     different seed heights; verify the per-cell mean energy matches
     recovering each ref's contribution BEFORE averaging (catches the
     "recovered after averaging" bug the per-ref nuance above warns about).
  5. Constant-grade descent profile: verify the OLD model's clamp would have
     fired (proving the test is discriminating) and the new model's route is
     cheaper, matching the analytic drop-weighted ε telescoping formula above
     — the Entry-17 sanity gate, adapted.
  6. A* admissibility: for a sample of DEM regions, confirm A* results still
     match a brute-force/Dijkstra reference (no missed better routes) using
     the new `h'(idx)=aRoll·distLB` heuristic.
  7. Budget pruning: confirm cells beyond budget are still pruned correctly
     under the new mode-aware comparison, including the round-mode raw-sum
     comparison against `eMaxTotalCap`.
  8. Portal non-negativity and a path crossing a portal, energy-recovery
     checked the same way as test 2.
  9. `graph-engine.js` regression: confirm `costAB`/`costBA` are unchanged
     (still true costs) after a live search runs — i.e. `topN()`/`pathEnergy()`
     called after a `dijkstra()` search still report the same values as
     before this change (modulo the intended clamp-removal effect), proving
     no aliasing/overwrite bug crept in.
  10. `maxCostPathOfLength()`/`maximizeWalk()` regression: confirm these are
      byte-for-byte unaffected by whatever reduced-cost code lands elsewhere
      in the same file (they should not reference it at all).
- **Regenerate and inspect** (don't just accept) `backend/test-backend.mjs`
  fixtures — confirm JS/Rust still agree bit-for-bit on the NEW model.
- **Full suite, must pass**: `node test-worker-pool.mjs`,
  `node test-energy-v2.mjs`, `node test-graph-engine.mjs`,
  `node test-water-raster.mjs`, `cd backend && cargo build --release && node
  test-backend.mjs` (plus the one debug-build non-negativity run noted above).
- **Load the app in a real browser** and check: from→to, round-trip, density
  (single + pooled), top-N, max-cost DP path, graph mode, bundle export/import
  round-trip, budget pruning, maximize mode. Confirm the field and any path
  energy readout now visibly agree (requirement 1) and that a route crossing
  a steep descent looks cheaper than before (the intended, disclosed change).
- **Performance**: spot-check compute time on a large DEM before/after — it
  should be flat or slightly BETTER (fewer branches/terms in the hot loop),
  never worse. If `estimateRunTime()`'s calibration constants
  (`EXPLORE_EXP`/`RATE_EXP`/etc., see `CLAUDE.md`) drift because the cost
  distribution changed shape (the calibration probe's `lastStopG` reads a
  raw, unbudgeted search-internal value whose scale will shift — see the
  `energy-worker.js` scope notes above), note it but do not silently re-tune
  them as part of this change — flag for a separate calibration pass if the
  online correction (`corrBrowser`/`corrBackend`) doesn't absorb it within a
  run or two.
- **Docs**: `CLAUDE.md` invariants — record requirement 1 (viewing ≡ routing,
  now true by construction via potential reweighting) and that the descent
  clamp is GONE (update every comment in `energy-worker.js`/`graph-engine.js`/
  `backend/src/main.rs` that still describes `max(0,·)` as the model,
  including the `maxEdgeCost` comment's stale "full climb term" phrasing).
  Help modal (`help.p.cost*` strings, PT+EN via `STRINGS`): describe the model
  without the clamp; note routes on steep descents are now somewhat cheaper
  than in prior versions. Update the `epsOffset: 0.13` provenance comment:
  cross-validated on 3 independent riders + the author's full export (journal
  Entries 12/14/16).
- **This is a model-change release, not a refactor.** Ship as one release:
  bump `sw.js` `VERSION`; move the changelog **trio** (`CHANGELOG.md` +
  help-modal `<details>` + `sw.js` comment) — the changelog entry MUST state
  plainly that the descent-clamp removal changes route energies and route
  choices on steep terrain, and why (viewing≡routing requirement + Entry 17).
  Commit authored as Claude with Danilo as co-author (see `CLAUDE.md`).

## Secondary decision (default chosen, flag at review)

Do bridge-deck descents earn ε credit under the new model, or stay flat-cruise
(today's behaviour, per the existing invariant that portals don't use ε at
all — portals are currently `alpha*deckLenM + beta*dh`, no ε term visible in
the current code, only downhill-clamped)? **Default: keep decks exactly as
today (no ε), just reweight the existing formula** — do not introduce a new ε
term on portals as part of this change; that would be a separate model
decision, not implied by the clamp-removal work.
