# Simujoules — Speaker notes

Companion to [`index.html`](./index.html). One section per slide, in order.
Each gives a **target time**, the **points to land**, the **exact numbers** to
cite, and (where useful) the **transition** into the next slide. A shortened
version of each is embedded in the deck as `<aside class="notes">` (press `S`
during the talk to see them in the speaker view).

**Total target: ~28–32 min talk + ~8 min questions.** Trim the methodology
sub-stack (slide 8) and the limitations/future-work pair (16–17) first if you
are short on time; never cut the 2.5-D proof (12) or the performance-model
validation (13).

A one-line cheat sheet of the headline numbers is at the bottom (["Numbers to
have ready"](#numbers-to-have-ready)).

---

## 1 — Title (0:45)

- Open on the icon motif: **concentric energy isolines, skewed south-east**.
  Say why they're skewed — the cost of cycling is *asymmetric*: climbing is
  expensive, descending is nearly free. "That skew is the entire talk in one
  picture."
- One sentence on what it is: *a free, build-step-free web app that computes the
  energy it costs to cycle across real terrain — and everything runs in your
  browser; the elevation data never leaves your machine.*
- Situate it: part of **pedalhidrografia**, a cycling-geography effort for São
  Paulo. Current version **v24**.

## 2 — Roadmap (0:30)

- Don't read all nine items. Just flag the two genuine research contributions:
  **§6 the 2.5-D multi-level routing** and **§7 the validated performance
  model**. "Everything else is the foundation that makes those two possible."

## 3 — Motivation: why energy? (1:30)

- The framing question: on hills, the **shortest or fastest** route can be the
  **most exhausting**. A flat 6 km can beat a hilly 4 km.
- Three intuitions: flat is cheap; climbing fights gravity; descending *refunds*
  energy, but only partly (you brake, you coast, you don't pedal).
- Because up ≠ down, the cost graph is **directed**: A→B costs differently than
  B→A. Plant this — it justifies the reverse "to-source" field, round-trip mode,
  and the directed bridge portals later.
- End on the richer question that falls out: *where does terrain itself force
  cyclists to converge?* → leads to passes/density.

## 4 — The asymmetric insight (1:15)

- Walk the diagram left to right. **α·d** is paid on every metre (rolling
  resistance, air, the act of pedalling) — always positive.
- **+β·Δh** uphill: proportional to height gained.
- **−η·β·|Δh|** downhill: a *refund*, but only fraction **η** of the equivalent
  climb, and the edge cost is **clamped at zero** — you can coast for free, but
  the terrain can never *pay* you to ride.
- Why η is small: most of a descent's potential energy is lost to braking, drag,
  and simply not pedalling.

## 5 — The cost model (2:00) — *the heart of the talk*

- Put the equation up and read it once, slowly:
  - Δh ≥ 0 (uphill/flat): **cost = α·d + β·Δh**
  - Δh < 0 (downhill): **cost = max(0, α·d − η·β·|Δh|)**
- Parameters and defaults: **α = 0.008** (cost per flat metre, ≈ 8 mJ/m),
  **β = 1.0** (per metre climbed, ≈ 1 J/m), **η = 0.1** (10% of a descent
  refunded).
- The unit anchor: **one energy unit ≈ the work to climb 1 m ≈ 0.8–1 kJ**
  mechanical for an ~85 kg rider + bike. With β = 1 that's the natural unit:
  one unit = one metre of climb.
- Be honest about scope: this is a **rough effort proxy**, *not* a calibrated
  physiological power model. (You'll repeat this in Limitations.)
- The load-bearing engineering claim: **this exact code appears in every
  routine** — Dijkstra, the density engine, A*, the max-cost DP, the bridge
  portals, the graph engine. One model, reused — which is *why* cross-mode and
  cross-engine consistency can be proven later.

## 6 — Origin (1:15)

- Quote the README: *"a static-site, no-backend port of the QGIS Processing
  algorithm."* It began **2026-05-05** to remove the install barrier of a QGIS
  plugin. ~1,380 lines on day one.
- The instructive sub-story: the **first architecture bet was Rust→WebAssembly**
  for the inner Dijkstra loop, with a pure-JS fallback. It was **abandoned 8
  days later** (2026-05-13). They instead made the JS engine fast (typed arrays,
  a hand-rolled binary heap, later a radix heap).
- "Two roads to native": the dropped **in-page wasm engine** vs. the later,
  **opt-in Rust+rayon HTTP backend** — native speed when you want it, never
  required, automatic fallback. That "optional with fallback" pattern recurs.

## 7 — Evolution timeline (1:15)

- Two phases. **May 2026:** rapid "sync" commits, a working prototype, no
  versioning. Then ~a month of silence.
- **June 12 (v12):** the relaunch — the single biggest commit (+3,253 lines) —
  introduces the worker pool, the optional Rust backend, radix-heap density, the
  calibrated estimator, QMC sampling, OSM streets, scenario compare, *and* the
  documentation/parity-test discipline.
- From **v14** it's strict versioned releases. v18/v19 are the 2.5-D work;
  v20–v24 refine bridges and water.
- Optional aside (full disclosure, lands well academically): much of this was
  **authored with an AI coding agent under a strict invariant-and-parity
  regime** — return to it under Validation as a *process* point, not a gimmick.

## 8 — Methodology I–IV (vertical sub-stack, ~4:00 total)

Press **Down** to walk the four sub-slides; **Right** skips the stack.

**I — the energy field (1:00).** Dijkstra on an **8-connected grid** (4 cardinal
+ 4 diagonal) from an anchor → minimum energy to reach every passable cell.
Three modes: **from** (forward), **to** (reverse search — a genuinely different
field *because* cost is directed), **round** (sum). The numerical-care box is a
real war story: energy is stored **Float32** to halve memory on 135 M cells, but
heap priorities are **Float64**, so you must gate on an explicit `settled` byte —
not `g > E[idx]` — or the f32/f64 mismatch pops duplicates, corrupts passes, and
caps the field at ~200 m.

**II — passes & natural corridors (1:00).** Passes at a cell = its **subtree
size in the shortest-path tree** (a betweenness-like count of how many optimal
paths cross it), computed by walking the settle order in reverse. The payoff:
this surfaces the terrain's **natural highways** — saddles, valley floors — as an
*emergent* property of topography, with no road network supplied.

**III — density + QMC (1:00).** Density = passes counts **accumulated over K
reference points** and normalised — a (quasi-)Monte-Carlo estimate of region-wide
channelling. (Precisely: a per-cell *sum* over references, each normalised by
H·W, then ÷H·W again — *not* a mean ÷K; it is the per-cell *energy* layer that is
a mean across reaching references.)
References can be clicked, pseudo-random, or **quasi-random (Sobol/Halton)**.
QMC matters: low-discrepancy points tile the area evenly, so the field
**converges with fewer references** (fewer Dijkstra runs). Each reference is an
independent Dijkstra → embarrassingly parallel → motivates the next section.

**IV — top-N & maximize (1:00).** Top-N: re-run A* with a **repulsion penalty**
on used cells so alternatives diverge; the penalty multiplies **only the α·dist
term — climb is never penalised** (you can't wish a hill away). Maximize: the
dual problem — invert the objective to find the **most expensive** routes; the
length-constrained version is a **layered DP** (max-cost path of exactly L edges,
memory-capped at 256 MB). Mention **energy budgets** (eMax) prune the search.

## 9 — Systems: two compute tiers (1:15)

- Principled split: a point-to-point query is **one Dijkstra** (one worker);
  density is **K independent Dijkstras** → a **pool**.
- Pool sizing is **memory-aware**: `poolSize = min(K, cores−1, memCap)`, where
  memCap budgets ~**38 B/cell** (≈55 round) against `navigator.deviceMemory`
  (spec-capped at **8 GB**, hence the `#max-workers` override).
- The "honest ceiling": on **sampa_geral** (14913×9055 ≈ **135 M cells**) one
  worker needs ≈ 5 GB; two won't fit 16 GB, so the pool collapses to **one
  worker**. The tool reports the truth instead of faking parallelism.

## 10 — Systems: the native backend (1:15)

- **Rust + rayon** HTTP server, **off by default**, per-session opt-in, with
  **automatic fallback** to browser workers on any failure.
- Per-thread ref slices reuse **one scratch set** (no per-ref allocation);
  priority queue is a **radix heap on raw f64 bits** — exact minima, no
  quantisation (f64 keys are order-preserving as unsigned ints → O(1) push,
  amortised O(64) pop). Concurrent slices are **memory-capped** (run more refs
  serially rather than OOM).
- Measured: **2–4×** per Dijkstra vs the JS worker; **3–10×** over the browser
  pool. Honest caveat: on huge frontiers both are **memory-bandwidth-bound**, so
  the native edge shrinks toward ~1.3×.

## 11 — One model, two engines: bit-parity (1:30)

- The engineering thesis: you can have a fast native path **and trust it**,
  because `backend/src/main.rs` is a **line-for-line port** of the JS
  `dijkstra()`.
- The numbers: **|Δenergy| < 1e-3** (the Float32 storage floor),
  **|Δdensity| < 1e-15** (machine epsilon), **0 finite/infinite mismatches**.
- The *only* permitted divergence: passes counts on **exactly-equal f64 cost
  ties**, where the radix heap and binary heap pick different (but equally
  optimal) parents.
- `node backend/test-backend.mjs` enforces this across from/to/round × budgets ×
  bridge portals. The rule is codified: change one engine, you change the other,
  and the test gates the commit.

## 12 — The 2.5-D problem (vertical sub-stack, ~5:00 total) — *do not cut*

**Crux (1:15).** A bare-earth DEM stores **one elevation per cell**. Two things
it can't represent: **water** (no "no-go" concept — the grid happily routes a
bike across a lake) and **bridges** (a flat deck, but the DEM shows the *valley
under it*, so routing over the bridge dives into the gap and pays a phantom
climb). The crux: **a bridge over a road is two routable surfaces at the same
(row, col).**

**Three approaches (1:00).** Walk the table.
- *Raster cell-override* — raise the deck cells. **Wrong** exactly at the
  interesting cell: it raises the ground for the road underneath, breaking it.
- *Graph mode* — route on the vector network, deck and road as separate edges.
  Works, JS-only, kept for "follow the vectors", deferred for raster.
- *Hybrid portal edges* (chosen) — keep the dense ground raster **and** inject
  one shortcut per bridge. The **only** raster option where over- and
  under-routes are both correct at once.

**The portal model (1:30).** Walk the diagram. The portal is **one directed edge
between the two abutment cells**, priced at the flat-deck cost using the *same*
asymmetric model, relaxed right after the 8 grid neighbours with the same
settled/budget/maximize guards. The genius is what it **doesn't** do: it never
modifies the cells beneath the deck. So A→B gets the cheap flat crossing and
C→D still sees the real ground. Two levels, one raster — and the portal cost is
bit-parity in JS and Rust (the test has +portals cases).

**Passability from OSM (1:00).** No need to BYO data — pull bridges and water
straight from **OpenStreetMap** over the DEM footprint. Two details worth saying:
OSM splits bridge ways **at the abutments**, handing you the ground endpoints
for free (v23 also reads node `ele` for true deck heights); and the **sea** fill
can't flood-fill (one coastline gap would leak the ocean over all land), so it
uses the coastline's **directed orientation** — water always to the right —
swept horizontally and vertically. All composed app-side → the **no-op
invariant** holds.

**Real-data proof (0:45) — the money slide.** Av. Dr. Arnaldo viaduct over a
multi-level interchange, driven headlessly on the real `sampa_centro.tif`:
- abutments at **814 m**, but the bare-earth DEM dips to **788.7 m** below the
  deck — a ~25 m phantom valley;
- with the portal, energy to the far abutment **E[B] drops 25.18 → 1.33** — a
  **~18.9×** reduction. (The post-portal 1.33 ≈ α × 173 m, i.e. the *flat-deck
  cost* of the 173 m deck: flat ⇒ β·Δh ≈ 0 ⇒ cost ≈ α·L.)
- the orthogonal ground line C→D is **byte-identical, Δ = 0**.
- That Δ=0 *is* the proof: we fixed the over-route without touching the
  under-route — multi-level coexistence on real terrain. (~44% of the wider
  field shifts too — expected, the bridge is a real shortcut.)
- *Honesty note (for you, not the slide):* these figures are a one-off headless
  verification recorded in `docs/bridges-and-passability.md`; the harness isn't
  shipped. The *continuously-enforced* guarantee is the bit-parity test suite —
  cite that if pressed on reproducibility.

## 13 — Performance model (vertical sub-stack, ~4:30 total) — *do not cut the validation*

**Master formula (1:30).** The estimator is itself a small research result. Show
**T ≈ c_alloc·N + R·τ_ref(e)/S(P_eff).** Decode: a one-time scratch allocation
plus per-reference Dijkstra work divided by parallelism. The interesting term is
**τ_ref ∝ min(1, (e/e_full)²)** — exploration grows **quadratically with the
energy budget** (reachable *area* ∝ reach², reach ∝ budget/α) until it
**saturates** the grid. Measured exponent **2.0–2.1**, right on the geometric
prediction. Summary line: **linear in references, quadratic-then-flat in budget,
divided by threads.**

**The P↔M coupling (1:00).** **P_eff = min(P, R, ⌊(M−21N)/38N⌋)** — usable
threads are capped by **memory**, not cores. On 135 M cells: 1 worker ≈ 8 GB,
2 ≈ 13 GB → two won't fit 16 GB. *Anatomy of a 3.63× bug:* the old backend
estimate assumed **8-way parallelism**, but the server fits only **2
memory-bounded slices** on a huge DEM (each rayon slice ≈ 5 GB). Divide by 8 when
reality divides by 2 → 4× error, partly offset → measured **3.63×** under. Fix:
**replicate the slice cap** in the estimate.

**Validation (1:00).** The table:
- 50 refs, e=300, 1 thread, JS: **predicted 426 s vs measured 427 s**.
- 50 refs, e=300, 2 threads, native: **180 vs 177 s**.
- Reported case: old **20.9 s** vs actual **76.0 s** (3.63× off); new first-run
  **82.6 s** (0.92 — within 8.7%).
- Production: a per-DEM **calibration probe** at load (3 spread refs, stopped by
  **settled-cell count** not budget → always < ~1.5 s and always *unsaturated*),
  plus a **per-engine online EMA correction**. First run **±20%** → converges to
  **~1%**. Residual **±30%** is dominated by **which references you place** (a
  flat-valley ref explores far more than a ridge-boxed one), not the machine.

## 14 — Validation & verification (1:30)

- Philosophy: correctness = **bit-level parity**, not "close enough."
- Four suites, run **before every engine commit** — *there is no CI*:
  `test-worker-pool.mjs` (invariants + **pooled ≡ single-run**, maxΔ = 0 +
  portal regression), `test-backend.mjs` (JS↔Rust bit-parity), 
  `test-water-raster.mjs` (OSM water vs pure mirrors), `test-graph-engine.mjs`
  (planarisation + a **400-trial** crossing fuzz).
- Two keystones: the **no-op invariant** (no mask + no bridges ⇒ byte-identical
  to the pre-feature engine, so passability shipped without re-validating the
  parity-locked core); and **adversarial review as process** — the v18 engine
  change was reviewed by **11 agents → 6 real issues, 0 false positives.**
- This is also where you can land the **AI-assisted development** point honestly:
  built with an agent, but under parity tests + adversarial multi-agent review.
  The *rigour*, not the authorship, is the point.

## 15 — Reproducibility & open science (1:30)

- **One run → one bundle (.zip):** `energy.tif` (Float32), `passes.tif`
  (Float64), `network/impassable.tif` (Uint8); `routes/path/bridges` GeoJSON;
  `metadata.jsonld` with **every parameter**. **Reproducible from the JSON-LD +
  the same DEM.** Opens directly in QGIS.
- The metadata isn't ad-hoc: a **published OWL / JSON-LD ontology** (schema v3,
  **CC-BY-4.0**) with QUDT units and xsd ranges — real Linked Data.
- **Privacy by architecture:** pure client-side compute, **DEM never leaves the
  browser**, no account/upload, offline after first load. Build-step-free PWA,
  five CDN libs (SRI-pinned), PT/EN.
- The pitch: for a *research* tool, "reproducible + interoperable + private +
  zero-install" is as much the contribution as the algorithms.

## 16 — Limitations (1:00)

- **Geographic-CRS bias** — really a WGS84 tool; degrees→metres is a flat-earth
  cosine approximation (~0.3% under 50 km), fine at city scale, not high-latitude
  / large extents.
- **Rough cost model** — α/β/η is an effort proxy, deliberately.
- **Portals are scoped** — only the Dijkstra-based modes; A*/DP/maximize don't
  use them (a shortcut breaks an admissible straight-line heuristic).
- **Memory-bound at scale**, **estimate ±20% first run**, **OSM-dependent** pull
  (needs a geographic DEM). None of these are hidden — all documented.

## 17 — Future work (1:00)

- *Routing:* graph-mode portals; portals in A*/DP via a shortcut-aware admissible
  heuristic; layer-aware portals (filter by span/layer).
- *Modelling & scale:* **calibrate α/β/η against measured rider power / Strava**
  (the most scientifically interesting one — turns the proxy quantitative); model
  remote-backend HTTP transfer explicitly; tiling / hierarchical Dijkstra beyond
  the single-worker ceiling.
- Close on: the careful architecture (composed app-side, bit-parity engines,
  no-op invariants) is built to absorb all of these without destabilising the
  core.

## 18 — Takeaways (1:00)

Read the four numbered points, then the one-liner. Land them crisply:
1. Energy — asymmetric, directional — is the right cost, and it makes natural
   corridors computable.
2. Hybrid portal edges solve real 2.5-D routing on raster DEMs (Δ=0 under a real
   viaduct).
3. A validated analytic performance model → calibrated, self-correcting ±20%
   estimate.
4. Bit-parity + no-op invariants + reproducible JSON-LD bundles: speed never
   costs correctness.

## 19 — Thanks / links (0:30)

- The app is live and free — try it on your own city's DEM. Everything shown is
  reproducible from the exported bundles. Invite questions on engine internals,
  parity testing, or the performance model.

---

## Anticipated questions

- **"Is the cost model validated against real cyclists?"** No — it's a
  deliberate effort *proxy* (α/β/η), not a power/physiology model. Calibrating it
  against measured rider data is explicit future work. What *is* rigorously
  validated is the numerics (bit-parity, pooled ≡ single, the perf model).
- **"Why not A\* everywhere instead of Dijkstra?"** Fields/density need the cost
  to *every* cell (or many references), where Dijkstra's single-source sweep is
  the right tool; A* is point-to-point and is used for top-N. Also, portals break
  an admissible straight-line A* heuristic, which is why A*/DP exclude them.
- **"How is it correct if it was written by an AI?"** Correctness is enforced
  structurally: a Rust↔JS bit-parity test, pooled-vs-single equivalence (maxΔ=0),
  the no-op invariant, four test suites run before every engine commit, and an
  11-agent adversarial review (6 real issues, 0 false positives). The authorship
  doesn't change what the tests prove.
- **"What about projected CRSs / large extents?"** Current limitation — it's a
  WGS84 tool with a flat-earth metre approximation; the OSM pulls are refused on a
  projected DEM. Good to ~0.3% under ~50 km.
- **"Why store energy in f32 if it causes parity headaches?"** Memory. On a
  135 M-cell grid, f64 energy would roughly double the per-cell footprint and cut
  the reachable DEM size. The `settled`-byte discipline is the price paid to keep
  f32 storage *and* correct passes.
- **"Can it scale past 135 M cells?"** Not in one worker on 16 GB — that's the
  honest ceiling. Tiling / hierarchical Dijkstra is future work; the native
  backend with more RAM extends it but is bandwidth-bound on huge frontiers.

## Numbers to have ready

| Thing | Value |
|---|---|
| Default params | α = 0.008, β = 1.0, η = 0.1 |
| Energy unit | ≈ 1 m climb ≈ 0.8–1 kJ (≈85 kg rider+bike) |
| Grid | 8-connected (4 cardinal + 4 diagonal) |
| Biggest DEM | sampa_geral 14913×9055 ≈ 135 M cells |
| Per-cell worker budget | ~38 B/cell (~55 round) |
| 135 M ceiling | 1 worker ≈ 8 GB; 2 ≈ 13 GB → won't fit 16 GB |
| Native speed-up | 2–4× per Dijkstra; 3–10× over browser pool |
| Parity | |Δenergy| < 1e-3, |Δdensity| < 1e-15, 0 mismatches |
| Viaduct proof | abutments 814 m, dip 788.7 m, E[B] 25.18→1.33 (18.9×), C→D Δ=0 |
| Perf-model validation | 426 s predicted vs 427 s measured |
| The bug | 3.63× under-estimate (missing memory slice cap) |
| Estimate accuracy | ±20% first run → ~1% steady; residual ±30% = ref placement |
| Probe | 3 refs, settled-cell-capped, < ~1.5 s, EXPLORE_EXP 2.1 |
| Adversarial review | 11 agents → 6 real issues, 0 false positives |
| Bundle | energy.tif f32, passes.tif f64, mask uint8, GeoJSON, metadata.jsonld (schema v3, CC-BY-4.0) |
