# Terrain passability & bridges — design notes and learnings

_Written 2026-06-19, covering the v18 (impassable mask + corridors) and v19 (OSM
bridges & tunnels + hybrid portal edges) work. Audience: future maintainers
(human or agent). This is the "why", not the "what" — the code + CHANGELOG say
what; this says why, what we tried, and what bit us._

## The problem

Simujoules routes on a DEM with an asymmetric cost model (uphill
`α·dist + β·dh`, downhill `max(0, α·dist − η·β·|dh|)`). A bare-earth DEM is the
ground surface — it knows nothing about **where you can't go** (water) or **where
the ground lies about the route** (bridges). Two gaps:

1. **Impassable areas** (water bodies) — the DEM happily routes a bike across a
   lake. v18 fixed this.
2. **Bridges/tunnels** — a viaduct deck is ~flat, but a bare-earth DEM shows the
   valley/saddle *under* it, so routing over the bridge dives into the gap and
   climbs out (a large phantom cost). v19 fixed this, including the hard
   multi-level case.

## v18 — impassable mask + network corridors (recap)

- **Upload a binary GeoTIFF** (1 = impassable). Resampled onto the DEM grid by
  **area-coverage majority** (a DEM cell is impassable iff ≥50% of its footprint
  is impassable in the source), via adaptive S×S supersampling + proj4 CRS
  reprojection. Outside the source extent ⇒ passable. Different
  extent/resolution/CRS than the DEM is fine.
- The vector network can carve **passable corridors** across the mask, each
  levelled to a smooth profile: land elevation at each shore, linear ramp up to a
  ±offset at the bridge **centre** (clamped −5…+15 m). This was the user's
  refinement — a triangular ramp, not a flat slab.
- **Key architectural choice (carried into v19):** compose the effective
  height/mask in `app.js` (`buildComputeGrid`) *before* serialization, so the
  engine (`energy-worker.js`) and Rust backend stay untouched and bit-parity
  holds. A run with no mask is byte-identical to before — the **no-op
  invariant**, which is the single most important property to preserve.

## v19 — OSM bridges & tunnels

### OSM data learnings (verified live against the user's test bridge)

- Bridges are highway ways tagged `bridge=yes` (also `viaduct`, `aqueduct`,
  `boardwalk`, …). **The way is split exactly at both abutments** — a `bridge=*`
  way IS the span, with its two endpoints on solid ground. This is *ideal*: the
  first/last geometry vertex give the two ground elevations for deck
  interpolation, for free.
- `man_made=bridge` is the bridge **outline/area** (descriptive), separate from
  the routable way — we ignore it.
- `layer=N` indicates vertical stacking (deck above, road below). We capture it
  but Phase B doesn't need it (the portal model is layer-agnostic — see below);
  it would matter for graph-mode (Phase C, deferred).
- `tunnel=yes` is the inverse (a grade through a hill) — same flattening logic.
- **Coverage is good in cities.** A live Overpass query at the user's coords
  returned the A→B bridge as **Avenida Doutor Arnaldo** (`bridge=viaduct,
  highway=primary, layer=2`, ways 167131039/167131057) over a multi-level
  interchange (Green Line metro + cross-streets stacked underneath). That's the
  poster child for the 2.5-D problem below.

### The 2.5-D problem (the crux)

A raster DEM holds **one elevation per cell**. A bridge over a road is **two
routable surfaces at the same (r,c)**: the deck (high) and the ground (low). You
cannot represent both in one cell. The user's own test captures it: A→B (the
deck) must read flat, AND the orthogonal ground line C→D (a saddle, naturally
flat) must *stay* flat. They cross at one cell.

### Three approaches we investigated

1. **Raster cell-override** (the v18 corridor style): overwrite the deck cells'
   height to the interpolated deck. ✗ Rejected — at the crossing cell it raises
   the ground, breaking the under-route (C→D). Fine for water/valley spans where
   nothing routes underneath, wrong for road-over-road.
2. **Graph mode** ("follow the vectors"): a bridge and the road it crosses are
   separate edges; the engine even has a dormant `zTol` crossing-suppression
   hook (graph-engine.js ~187) that never fires because OSM lines carry no Z.
   Add layer-aware junction suppression + per-edge deck flattening → both levels
   route correctly. ✓ Works, JS-only (no backend parity concern). **Deferred
   (Phase C)** — the user's core ask is met by #3; revisit if graph-mode bridges
   are wanted.
3. **Hybrid: raster + bridge "portal" edges** (the user's idea, chosen). Keep
   the dense raster Dijkstra (ground elevation everywhere ⇒ C→D correct), and
   **inject one directed shortcut per bridge** between its two abutment cells at
   the flat-deck cost. The cells under the deck are never touched ⇒ both levels
   coexist on the raster. ✓ **This is the answer to "handle both levels."**

### Why the hybrid is the right call

- It's the only raster approach that keeps **both** routes correct
  simultaneously. Proven by the regression test: a portal lowers `E[goal]` but a
  cell off the portal path is **unchanged** (multi-level locality).
- It composes with everything: the network constraint (portal endpoints must be
  in the effective mask), the energy budget, maximize, reverse legs, density.
- Cost: it modifies the **parity-locked** engine (`dijkstra`, `densityField`,
  Rust `dijkstra_tree`). That's the price of correctness here — accepted
  deliberately, where v18 was able to stay engine-free.

## Implementation notes (the load-bearing details)

- **Portal model.** `state.bridges = [{ latlngs, endA, endB, deckLenM, kind,
  layer, name }]`. `buildPortals()` packs these into `portalU/portalV/portalLenM`.
  A portal is a directed edge `endA↔endB` with cost = the grid model applied to
  `(deckLenM, dh = h(endB) − h(endA))`. One edge per bridge, end-to-end —
  intermediate geometry is render-only. OSM splitting at abutments makes this
  clean (no mid-bridge ramps).
- **Relaxation.** Relaxed right after the 8 grid neighbours, with the *same*
  guards: `settled`, `reverse ? bwd : fwd` (mirrors the grid dh sign flip),
  `maximize` inversion + clamp, `eMax` budget, f32-store/f64-compare, parent set,
  heap push. Portal-reached cells join `order`, so the subtree-passes walk and
  the targeted density reset cover them for free.
- **Parity strategy (critical).** Portal costs are derived from the *same shared
  inputs* (deck length f64, endpoint heights widened f32→f64, params) with the
  *same formula* in JS (`buildPortalAdj`) and Rust (`build_portals`) — so they're
  bit-identical, exactly like the grid edges. `test-backend.mjs` `+portals` cases
  confirm max|Δ|=0 across all modes. Two subtleties: (a) **per-cell portal
  iteration order** must match (JS `Map` vs Rust `HashMap` both preserve
  insertion order from the same portal array) so exact-tie passes agree; (b)
  monotonicity is preserved (edge ≥ 0 ⇒ tentative ≥ g), so the radix heap
  invariant holds.
- **Threading discipline (the v18 lesson, reaffirmed).** There is **no single
  serialization choke point**. Height/mask reach the engine at ~6 sites (single
  worker, density pool, native backend Blob, compare ×2, probe, graph build) plus
  the interp domain. v18 review caught the backend Blob being missed. For
  portals we exploited `baseMsg` (spread into every worker message) so they reach
  all worker paths in one place — but **must be CLONED, not transferred** (the
  density pool spawns N workers sharing `baseMsg`; transferring would detach the
  buffers after the first). The native backend Blob is the one path outside
  `baseMsg` — it gets `nPortals` + the three arrays appended after the optional
  network mask. Always grep for direct `state.dem.height/mask` reads after such a
  change.
- **Wire format (backend).** `head(4) + json + height(4N) + mask(N) +
  [networkMask(N) iff hasNetwork] + portalU(4P) + portalV(4P) + portalLenM(8P)`.
  Rust must advance `off` past the network mask before reading portals, and
  `expected` length must include `P·16`.
- **Scope.** Portals wire into `dijkstra` (from/to/round) + `densityField`. A\*
  top-N and the layered-DP max-cost path **don't** use portals — an admissible A\*
  heuristic (straight-line lower bound) would break if a shortcut made the actual
  cost lower than the heuristic. Documented limitation.

## Decisions & rationale

- **Dedicated pull** (not folded into the streets pull): bridges are a terrain
  correction independent of whether you constrain routing to the network.
- **Bridges + tunnels**: tunnels follow a grade through a hill — same model.
- **Defer graph-mode bridges (Phase C)**: the hybrid answers "both levels" for
  the raster modes (the default); graph mode is a separate, larger effort.
- **No bridge offset by default**: a portal is one edge end-to-end, so the deck
  is the straight line between abutments (offset 0). The v18 corridor centre-hump
  offset doesn't apply to a single edge.

## Gotchas & things that bit us (or could)

- **Element-id mismatches** are silent and deadly. v18's review found the Invert
  checkbox wired to `imp-invert` while the HTML used `impassable-invert` — a
  permanent no-op + dropped bundle state. Lesson: grep that every
  `getElementById(...)` id exists in the HTML, and verify with a script.
- **Service-worker staleness** (see [[sw-worker-importscripts-staleness]]): edits
  to `energy-worker.js` can run stale in the browser (SW-cached subresource).
  Bump VERSION; in dev, bypass/unregister the SW. The whole engine change is
  invisible until VERSION bumps.
- **Bare-earth DEM assumption.** Bridge flattening assumes the DEM omits the deck
  (FABDEM-style). If the DEM is a DSM that already includes the deck, the portal
  is redundant (harmless but pointless). Noted in the help text.
- **Rendering residue.** The portal jumps end-to-end, so the deck's *interior*
  cells aren't visited — they render the ground (under-deck) energy. Routing is
  correct; only the visualization of the deck interior is "missing". Optional
  follow-up: stamp the portal's passes along the deck line.
- **maximize + portals**: `maxEdgeCost` is bounded by one grid step, so a long
  portal cost exceeds it and `maxEdgeCost − cost` clamps to 0 (portal becomes
  "free" in maximize mode). Maximize is niche; left as a documented edge case.
- **Adversarial multi-agent review earns its keep.** The v18 review (11 agents)
  found 6 real issues, 0 false positives. Worth running on every engine-touching
  change.

## Verification

- `node test-worker-pool.mjs` — portal shortcut lowers `E[goal]`, unrelated cells
  unchanged (multi-level locality), pooled ≡ single with portals, field actually
  changes. Plus all prior invariants.
- `cd backend && cargo build --release && node test-backend.mjs` — bit-for-bit
  JS↔Rust parity *with* portals (max|Δ|=0) across from/to/round × eMax.
- **Still pending (needs a DEM + browser):** the real-world e2e on Av Dr Arnaldo
  — load a São Paulo DEM (~−23.551, −46.677), pull bridges, confirm A→B
  (−23.550484,−46.678140 → −23.551438,−46.676810) routes flat while the
  orthogonal ground line C→D (−23.550228,−46.677153 → −23.551718,−46.677920)
  stays flat and is *unchanged* by the bridge — the visual proof both levels
  coexist.

## Future work (parked)

- **Phase C — graph-mode multi-level**: carry bridge/tunnel/layer tags into the
  graph build; layer-aware junction suppression (the dormant `zTol` hook);
  per-edge deck flattening of `profH`. Makes "follow the vectors" multi-level
  correct too.
- **Portals in A\*/DP**: needs an admissible heuristic that accounts for
  shortcuts (or accept inadmissibility for top-N).
- **Deck passes stamping** for visualization (see rendering residue).
- **Layer-aware portals**: currently any `bridge=*` is flattened; could filter by
  span length / layer to be conservative on short overpasses.

## File map

- `app.js` — bridge pull/model/overlay/persistence/invalidation;
  `buildPortals` + `baseMsg`/backend-Blob threading; group 1d UI + i18n.
- `energy-worker.js` — `buildPortalAdj`; portal relax in `dijkstra` +
  `densityField`; run-handler build + threading.
- `backend/src/main.rs` — `Params.n_portals`; `PortalAdj`/`portal_cost`/
  `build_portals`; portal relax in `dijkstra_tree`; `handle_density` wire parse.
- `test-worker-pool.mjs`, `backend/test-backend.mjs` — portal regression +
  parity cases.
- `CLAUDE.md` — the portal-edge invariant (parity contract).
