# Changelog

Versions track the service-worker `VERSION` in `sw.js` (bumped on every
deploy that changes app behaviour). Keep this file, the collapsed Changelog
section in the help modal (`index.html`), and the `sw.js` version-history
comment in sync — update all three with every release.

Backfill note: v1–v11 entries were reconstructed from the `sw.js` version
history and git log on 2026-06-12; v4–v10 shipped between 2026-05-08 and
2026-05-13 without individually recorded dates.

## v38 — 2026-06-25

A UI/UX review pass. **JS/UI only — the compute engine, Web Worker and Rust
backend are untouched and stay bit-parity.**

### Units

- The **energy budget stays in kJ**, so the cost coefficients α/β are labelled
  **kJ/m** again (reverting v37's J/m). No engine change — only the nomenclature.
- **Downhill recovery (η) is now a 0–100 percent** input (default 10), divided by
  100 at the compute reads; bundles keep the 0–1 fraction and a one-time
  persistence migration scales an existing `0.1` up to `10`.

### Visual & interaction

- The **collapse/expand group cue is a quiet grey bar** now, not a loud near-white
  border that out-shouted the green/orange/yellow/red **status** colours.
- **"Baixar bundle" is a secondary button** so **"Calcular"** is the only primary.
- **Drawing**: the active draw button shows an **armed** state and **Esc cancels**
  a draw; the **"Concluído em…" pill auto-dismisses**; the disabled **"Calcular"**
  button now **explains what it needs**; enabling density **auto-opens** the
  points/references group.

### Accessibility

- Icon buttons, file pickers and the layer-panel rows now have **bilingual
  accessible names**; native checkboxes/radios/sliders get `accent-color`;
  reorder/help/lang **touch targets ≥24px**; **reduced-motion** respected; the
  floating layer panel is `role="region"` (not a fake modal).

### i18n / copy / mobile

- Fixed PT/EN leaks (calibration text, budget tooltip); **shortened two over-long
  select options** so they no longer clip; PT Twitter description; the help-modal
  title; the "Cláudio" credit typo.
- **Mobile**: the locate button hides while the drawer is open and the layer
  button moves to the bottom stack; the drawer gains bottom padding.

### Example datasets

- **1B** gains a one-click **"Viário RMSampa"** loader (the ~145 MB RMSampa road
  network `.gpkg`) and **1C** an **"Águas RMSampa"** water-mask loader (`.tif`),
  both fetched from the bucket. `deploy.sh` now excludes the `vector/` and `mask/`
  prefixes from the bucket prune (same out-of-band pattern as `census/`).

## v37 — 2026-06-25

UI refinements on top of v36. **JS/UI only — the compute engine, Web Worker and
Rust backend are untouched and stay bit-parity.**

### Changes

- **Sidebar groups reordered & trimmed.** 1B–1D and 2A–2C controls were
  regrouped/renamed; "maximizar energia" and the "origem das referências"
  dropdown were removed.
- **Multi-column sidebar.** Each column now fills top-to-bottom before content
  spills into the next, and the panel scrolls **vertically only** — no
  horizontal scrollbar when content is tall.
- **Label tables.** The 1B network parameters and the 2A parameters are now
  2-column **label | input** tables. Cost coefficients are labelled **J/m**
  (α ≈ 0.008 J/m, β ≈ 1 J/m) and the budget in **kJ**; "recuperação na descida"
  stays a 0–1 fraction (shown as %).
- **Results styling moved to the layer panel.** The energy-field, trajectory-
  density and legend controls (former 3B–3D) now live at the bottom of the
  on-map **Controle de camadas** panel; its × button was removed (the layer
  button toggles it and Esc closes it). Statistics (3A) stay in the sidebar.
- **Group highlight.** Collapsed groups read grey, expanded groups white — the
  same border + left-bar treatment as the green/orange/yellow/red status
  colours, which still take priority. 1C/1D now turn **green** when you've drawn
  barriers/corridors/portals, even with nothing else loaded.
- **Branding.** The app title is now **Simujaules** with the tagline
  *"Imaginador de caminhos fáceis para o encontro."*

### Fixes

- Collapsing the sidebar no longer blanks the map (the map cell now fills the
  viewport and Leaflet re-fits).
- The rmsampa-v2 hydrography overlay no longer requests (404) tiles past zoom 16
  — it upscales the z16 tiles instead.
- **Deploy:** `deploy.sh` now excludes the `census/` prefix from its
  `--delete-unmatched-destination-objects` prune, so the out-of-band population
  FlatGeobuf survives deploys.

## v36 — 2026-06-24

A large UI/UX overhaul. **JS/UI only — the compute engine, Web Worker and Rust
backend are untouched and stay bit-parity; the no-op invariant holds (with no
drawings/overrides the compute grid is byte-identical).**

### Features

- **Nested collapsible groups.** The sidebar is reorganised into numbered,
  collapsible `<details>` groups: **0** Import/Export · **1** Inputs
  (1A DEM · 1B network · 1C barrier mask · 1D bridges) · **2** Compute setup
  (2A Parameters · 2B Points & references · 2C Execution) · **3** Results
  (3A Statistics · 3B Energy field · 3C Trajectory density [3C.a network /
  3C.b terrain] · 3D Legend). Everything starts collapsed except 1A; groups
  auto-expand as you load a DEM / network / mask / run / bundle. Each group
  shows a **status colour** (green/orange/yellow/red) reflecting its state.
- **Layer control panel.** All layer visibility/opacity/stacking-order +
  basemap (now including an **Esri satellite** option) + reference-marker
  toggle moved into a **non-blocking, top-right on-map panel** ("Controle de
  camadas"), opened from a floating map button that highlights while open.
  Each layer is one row: reorder arrows, visibility, name, opacity.
- **Floating compute feedback.** The progress bar + status/log messages now
  float in a dismissable pill at the bottom of the map, so they stay visible
  regardless of the sidebar layout.
- **Draggable multi-column sidebar.** Drag the sidebar's right border to snap
  it to 1–4 fixed-width columns (desktop/landscape); the hamburger also
  collapses/expands the docked sidebar on desktop. Both are remembered.
- **Full config persistence + portability.** Every toggle/value now persists
  across sessions; Group 0 gains **Export / Import / Reset** config buttons,
  and bundles embed the entire UI state (not just the parameter subset).
- **On-map drawing tools (Leaflet-Geoman).** Draw **barrier** and **passable
  corridor** polygons (1C) and **portal** lines (1D) directly on the map; they
  feed the compute (barriers block, corridors reopen, portals are bridge
  shortcuts) and round-trip through config + bundles.
- **Smaller touches:** density tweaks follow the displayed channel (terrain vs
  network); passes auto-max uses p90 of cells above auto-min; density bounds
  show in scientific notation; locate drops a marker + accuracy circle; the
  credit line moved into the help modal.

### Notes

- Adds the **leaflet-geoman** CDN library (SRI-pinned, runtime-cached offline
  like the other libs). Sampling-strategy order is now Censo (default) / Sobol
  / Uniforme (Halton dropped).

## v35 — 2026-06-24

Two changes ship together, numbered **v35** to avoid a version clash with the
in-flight `feature/ui-overhaul` branch (which already uses v33).

### Changed

- **App moved to its own domain.** The simulator now lives at the root of
  **https://simujaules.pedalhidrografi.co/** (a dedicated `gs://simujaules`
  bucket) instead of `telhas.pedalhidrografi.co/simujoules/`. The brand is
  spelled **Simujaules** — a deliberate, affective typo of *joules*.
  - Absolute URLs (canonical / Open Graph / schema.org, the bundled example
    DEMs, the census FlatGeobuf, `sitemap.xml`, `llms.txt`) repoint to the new
    root.
  - The RDF `@vocab` namespace IRI deliberately **stays** on
    `telhas.pedalhidrografi.co/simujoules/vocab/…` (a stable linked-data
    identifier) and resolves to the new domain via a redirect, so previously
    exported bundles keep validating.
  - Shared raster assets (the `rmsampa-v2` overlay and FABDEM tiles) stay on
    `telhas`.

### Features

- **Cloud compute now works when the app is accessed remotely**, not just from
  localhost. The "Nuvem (VM orquestrada)" option is available from
  `simujaules.pedalhidrografi.co`; fill in the **Orchestrator URL** and the new
  **Cloud password** to use it.
  - The orchestrator is now a public, **password-gated Cloud Run** service. It
    creates / starts / stops / **deletes** the GCP spot VM on demand. The
    browser sends the large compute payloads **directly to the VM over HTTPS**
    (Caddy on the VM, TLS via Cloudflare DNS-01) — they don't fit through Cloud
    Run, so only the lifecycle calls go to the orchestrator.
  - The same password gates both the control plane (orchestrator) and the data
    plane (the VM). On a wrong password / unreachable orchestrator / boot
    failure, the run falls back to the in-browser worker pool.
  - The VM uses an **ephemeral IP** (no idle-billed static address); the
    orchestrator rewrites the `compute.simujaules.pedalhidrografi.co` DNS record
    to it on each start. After **30 days idle** the VM is **deleted** (rebuilt
    on demand on next use), so long-term idle cost is ~0.
- No engine / numeric changes; all compute output is identical.

## v32 — 2026-06-24

### Features

- **New "IBGE 2022 census (population density)" reference-sampling strategy.** A
  fourth option in the density panel's *Sampling strategy* selector. Instead of
  spreading reference points uniformly (pseudo-random / Sobol / Halton), it
  samples them by **where people actually live** — a live, in-browser port of
  `census/sample_census.py`:
  - Fetches the census **setores** intersecting the current DEM's bounding box
    from a cloud-hosted **FlatGeobuf** over **HTTP Range requests** — only the
    bbox slice transfers (a few hundred KB for a city), never the ~450 MB
    national file. The dataset is the IBGE 2022 *malha de setores* joined to the
    *básico* population (`v0001`), built by the new `census/build_fgb.py` and
    served from `gs://telhas/simujoules/census/setores_br_pop.fgb`.
  - Weights each setor by `pop · (area clipped to the DEM / full area)`, picks
    setores by a **1-D Sobol inverse-CDF**, and places each point inside its
    setor with a **2-D Sobol** bbox draw + point-in-polygon rejection (structural
    parity with the Python; bit-parity is not required).
  - **Brazil-only** and **online-only** (consistent with the Overpass/FABDEM/
    cloud features) — clear messages when the DEM is projected, outside Brazil,
    has no populated setores, or the network/library is unavailable. Replaces the
    current reference set (like the GeoJSON file loader); JS-only, backend
    untouched. Adds the `flatgeobuf` CDN library (runtime-cached like the others).

## v30 — 2026-06-23

### Fixes

- **Bundles now round-trip the "Comparar com cenário sem rede" (compare) view.**
  Export/import was unaware of the compare scenario: it saved only the constrained
  `energy`/`passes`, and metadata never recorded the `#vec-compare` toggle — so a
  reloaded compare bundle lost the displayed-scenario picker and the difference /
  unconstrained views entirely. Now `downloadBundle` writes the unconstrained
  energy + passes and the saved (network-masked, interp-filled) difference field
  (`energy_unconstrained.tif`, `energy_difference.tif`, `passes_unconstrained.tif`),
  `buildMetadata` records `compare` plus the previously-missing `e-max-mode`, and
  load restores the toggle and rebuilds `energyAlt`/`passesAlt` so the scenario
  picker and the orange/blue difference view come back without recomputing.
  (Graph-mode "follow the vectors" compare restore remains a known follow-up —
  graph results aren't cached in the bundle yet.)

## v29 — 2026-06-23

### Features

- **Difference (network-cost) passes view: colourblind-safe recolour.** The
  two-scenario overlay went from light **red/green** (invisible to red–green
  colour-blindness; overlap only a soft yellow) to an **orange (network,
  constrained) / azure-blue (terrain, unconstrained)** additive-complement pair
  that sums to **white** — so where both scenarios route together brightness is
  maximal, while each colour alone sits on the blue–yellow opponent axis and
  stays discriminable under the common red–green CVD. The two passes control
  groups now carry colour-chip labels (**Network** / **Terrain**) so it's clear
  which channel each drives.

## v28 — 2026-06-23

### Internal

- **Network interpolation pool budgeted by `deviceMemory`.** The post-compute IDW
  network fill sized its worker pool against a fixed 1.5 GB budget, which pinned
  large DEMs (e.g. the 135 M-cell `sampa_geral`) to a single interp worker. It now
  budgets against `navigator.deviceMemory` (like `densityPoolSize`) plus the
  `#max-workers` override, so the interp parallelises across cores when the RAM is
  free (it runs after the Dijkstra workers are released; in Cloud mode the browser
  never ran them). Output unchanged.

## v27 — 2026-06-23

### Features

- **Cloud "keep VM warm between runs" toggle.** With it ticked, a run no longer
  stops the cloud VM when it finishes — the VM stays up so the next run reuses it
  instantly (only the first run of a session pays the ~1–2 min boot). The
  orchestrator lease + the in-VM idle-watchdog stop it after ~15 min idle (hard
  cap 2 h). In keep-warm mode, hiding/switching the tab no longer stops the VM;
  only a real page unload does. Default stays "stop after each run" (cost-safe).

## v26 — 2026-06-23

### Features

- **Cloud compute source.** The single "Use native backend (Rust)" checkbox is
  now a three-way **Compute source** selector: **Browser** (in-page worker pool,
  the default), **Localhost** (the native Rust backend, with its URL field), and
  **Cloud**. Cloud drives a small local orchestrator (default
  `http://127.0.0.1:8079`) that boots a pre-baked VM on demand, waits for it to
  report healthy, proxies the existing `POST /density` and `POST /single`
  compute requests through it byte-for-byte, then stops the VM after each run
  (and on tab hide via a `sendBeacon` to `/cloud/stop`). While a compute is in
  flight the app extends the VM lease with a periodic `/cloud/keepalive`.
- **Transfer-size estimate.** With Cloud selected, a line shows the estimated
  upload / download bytes and the wire time at an assumed uplink/downlink, so
  the network cost of a remote run is visible before pressing Compute.
- **Cloud is local-only.** The Cloud option is offered only when the applet is
  served from `localhost`/`127.0.0.1`/`[::1]` or `file:` (the orchestrator
  binds loopback); otherwise it's disabled with an explanatory note.
- **Graceful fallback.** On any orchestrator-unreachable or VM-boot failure the
  run falls back to the in-browser worker pool, with a cloud-aware status
  message. Browser/Localhost behaviour and engine bit-parity are unchanged — the
  compute path is untouched; Cloud just sends the same bytes to a proxy URL.

## v25 — 2026-06-22

### Fixes

- **Graph mode locked out the comparison toggles instead of honouring them.**
  v24 greyed out both "Constrain to network" and "Compare with unconstrained"
  while "Compute on network graph (follow the vectors)" was on. Now graph mode
  *runs* the comparison: "Constrain to network" is forced on and locked (graph
  mode is inherently network-constrained), while "Compare with unconstrained"
  stays togglable. With it on, graph mode computes a full-DEM **unconstrained
  raster** scenario alongside the graph compute and exposes the energy
  difference (the cost of being restricted to the network) through the
  "Displayed scenario" picker — graph / unconstrained / difference.
- **The native backend was unusable with multi-reference density off.** "Use
  native backend (Rust)" lived inside the density panel, so it disappeared
  whenever density was unchecked. It's now a top-level compute option (always
  visible).

### Features

- **Native backend single-source energy fields.** The backend previously only
  computed multi-reference density. A new `POST /single` endpoint accelerates
  single-source `from`/`to`/`round` energy-field runs (energy + optional passes)
  on the native server too, with the same auto-fallback to browser workers.
  Top-N routes, the destination path, and "maximize" stay browser-only (the
  backend produces no routes). `energy-worker.js` and `backend/src/main.rs` are
  kept bit-parity — `test-backend.mjs` gained `+single` cases (from/to/round ×
  budget × portals × network × passes), all matching to 0 ULP.

## v24 — 2026-06-21

### Fixes

- **Graph mode silently suppressed the constrained-vs-unconstrained compare.**
  "Compute on network graph (follow the vectors)" wins the run dispatch over the
  raster "Constrain to network" / "Compare with unconstrained" toggles, so with
  graph mode on — and it's persisted in localStorage, so it can be on from a
  prior session — the compare never ran and its "Displayed scenario" dropdown
  (constrained / unconstrained / difference) never appeared. Graph mode now
  **greys out and disables** those two toggles (with an explanatory tooltip)
  while it's on, both on toggle and on load, so the precedence is visible.

## v23 — 2026-06-21

### Features

- **OSM `ele` on bridge/tunnel decks (group 1d).** "Pull bridges & tunnels from
  OSM" now also fetches node `ele` tags and uses the mapped deck elevation for the
  raster **portal** endpoint heights, instead of guessing from the bare-earth DEM
  at the abutments. Per-abutment: the way-end node's `ele` if mapped, else a
  way-level `ele`, else the nearest mapped node from that end. Unmapped ends fall
  back to the DEM (NaN sentinel), so a pull **without** `ele` is byte-identical to
  v22. The mapped elevations are persisted in the bundle (`bridges.geojson`).

### Internal

- Portal endpoint heights (`hu`/`hv`) are threaded through the worker pool and the
  native backend Blob (now 32 B/portal: i32 u, i32 v, f64 lenM, f64 hu, f64 hv).
  `energy-worker.js buildPortalAdj` and `backend/src/main.rs build_portals` apply
  the identical NaN→DEM fallback and stay bit-parity (`test-backend.mjs` `+portals`
  cases now mix NaN and explicit `ele`). Graph mode ("follow the vectors") is
  unchanged (still DEM-based). A* top-N / maximise still ignore portals.

## v22 — 2026-06-21

### Features

- **Pull water from OSM (group 1c).** A new button queries Overpass over the DEM
  extent and builds the impassable mask directly — no GeoTIFF upload needed.
  Impassable =
  - water **areas** (`natural=water` / `waterway=riverbank` / `landuse=reservoir`,
    ways **and** multipolygon relations) — even-odd polygon-filled, islands become
    holes;
  - the open **sea/ocean** (from `natural=coastline`, which OSM stores as a
    directed line with land-left/water-right) — filled by a horizontal **and**
    vertical orientation sweep that sets each span's side locally, so coastline
    gaps/open-ends never cascade into a leak (and islands/bays resolve correctly);
  - **non-tunnelled** `waterway=river` **lines** — supercover-rasterised so an
    8-connected route can't slip across; a **"Rivers (lines) impassable"** toggle
    turns this layer off without re-querying.

  Streams and tunnelled/culverted waterways stay passable. The result feeds the
  existing uploaded-mask pipeline, so Invert, bridge corridors, the overlay, the
  "Apply to compute" toggle, and bundle export all work unchanged. Geographic
  (lon/lat) DEM only.

## v21 — 2026-06-21

### Fixes

- **"Load FABDEM for current viewport" crashed** with `TypeError: t is not a
  function`. The tile-mosaic loop variable (`const t = opened[i]`, a tile)
  shadowed the i18n `t()` function, and the v19/v20 status-string migration
  added a `t("status.fabdem_mosaic", …)` call inside that loop — so it called
  the tile object instead of translating. Renamed the loop variable to `tile`
  (both tile loops in `loadFabdemForView`). App-only; engine/backend unchanged.

## v20 — 2026-06-20

### Fixes & improvements

- **Bridge deck passes/density now show up.** A bridge portal jumps
  abutment→abutment, so the deck's interior cells weren't in the path tree and
  rendered no passes/density even when the bridge carried heavy traffic. Deck
  cells are now painted with the flow crossing the bridge
  (`min(passes[endA], passes[endB])` — the portal's tree-edge flow), so a deck
  reads commensurate with its ends.
- **Groups 1c/1d highlight when loaded.** The impassable-mask (1c) and bridges
  (1d) groups now light up (accent border) once their data is loaded, matching
  1a/1b.
- **Extract bridges from the loaded vector network (1d).** A new
  "Extract from loaded network" button derives bridge/tunnel decks from the
  network already loaded in 1b — offline, no Overpass. Bridge tags are read from
  dedicated `bridge`/`tunnel`/`layer` columns when present, else parsed from an
  OSM-export `other_tags` hstore; reprojection is reused from the network load
  (no re-parse).
- **Toggle 1c/1d on/off.** The impassable-mask (1c) and bridges (1d) groups each
  get an "Apply to compute" checkbox to enable/disable their effect on the
  compute without clearing the loaded data (and it round-trips in bundles).

## v19 — 2026-06-19

### New features

- **OSM bridges & tunnels (group 1d).** A dedicated "Pull bridges & tunnels
  from OSM" control queries Overpass for `way[bridge]` (and optionally
  `tunnel=yes`) over the DEM extent and models each structure as a level deck
  between its two ground abutments. Decks render on the map and persist in
  bundles as `bridges.geojson`. Useful for inland viaducts over valleys/saddles,
  not just water — a bare-earth DEM omits the deck, so routing over a bridge
  otherwise dives into the gap below.
- **Multi-level routing via hybrid portal edges (raster modes).** Each deck
  becomes a portal edge between its end cells at the flat-deck cost, relaxed
  alongside the 8-connected grid edges. The cells **under** the deck keep their
  ground elevation, so the route **over** a bridge and the route **under** it
  (e.g. a cross-street beneath a viaduct) both stay correct — the true
  multi-level case a single-elevation cell-override cannot represent.
- **Graph mode ("follow the vectors") multi-level.** The OSM streets pull now
  captures each way's bridge/tunnel/layer tags; in graph mode a deck crossing a
  way at a different layer no longer forms a junction (overpass), and deck edges
  are flattened to a straight profile between their ground endpoints — so a
  viaduct reads ~flat and routes independently of the road beneath it.

### Internal

- Engine change: `dijkstra`/`densityField` (energy-worker.js) and
  `dijkstra_tree` (backend/src/main.rs) gain portal relaxation; portal costs are
  derived from the deck length + endpoint heights with the same asymmetric model
  in both, so they match bit-for-bit (`backend/test-backend.mjs` gains `+portals`
  parity cases; `test-worker-pool.mjs` gains portal regression cases). With no
  bridges loaded the path is inert — results are byte-identical. A* top-N and the
  max-cost DP path don't use portals yet (an admissible A* heuristic would break).

## v18 — 2026-06-19

### New features

- **Impassable mask (group 1c).** Upload a binary GeoTIFF (1 = impassable,
  e.g. water bodies). It's resampled onto the DEM grid by area-coverage
  majority (a DEM cell is impassable iff ≥50% of its footprint is impassable
  in the source; outside the mask's extent cells are passable), so the mask
  can have a different extent / resolution / CRS than the DEM. Masked cells
  block all routing.
- **Network-carved bridge corridors.** With a vector network loaded (1b), an
  optional toggle lets the network carve narrow passable corridors across the
  mask. Each corridor is levelled to a smooth bridge profile — land elevation
  at each shore, a linear ramp up to a `±` offset at the bridge centre
  (clamped −5…+15 m), then back down — so routing crosses cleanly even where
  the DEM has no-data over water.
- **Verification overlay + bundle round-trip.** A "show on map" toggle paints
  the blocked water (red) and reopened corridors (green). Bundles now include
  `impassable.tif` and restore the mask, corridors and settings on reload.

### Internal

- The impassable mask, corridors and bridge offset are composed entirely
  app-side (`buildComputeGrid()`), so `energy-worker.js` and the Rust backend
  are unchanged — engine bit-parity is preserved. A run with no mask (or an
  all-zero mask) reproduces prior results exactly.

## v17 — 2026-06-19

### Improvements

- **Loaded-state highlight.** The "Load DEM" (1) and "vector network" (1b)
  groups now light up (accent border + left bar) once their data is loaded,
  so it's obvious at a glance what's in play.
- **Choices persist across reloads.** Parameter and visualization settings
  (mode, α/β/η, budget, toggles, N refs, sampling, colormaps, opacities,
  ranges, network params, basemap, …) are saved to `localStorage` and
  restored on the next visit. Session data (the loaded DEM, src/dst, reference
  points) is deliberately not persisted — that's what bundles are for.
- **Point/reference buttons clustered.** "Clear points", "Place random" and
  "Clear refs" now sit together in the Pick-points group with "Clear points"
  on top. In density mode only the src/dst picker fades out (it's replaced by
  references) instead of the whole group, so the reference actions stay live.

### Accessibility

- The status line is now an `aria-live` region, so loads / computes / errors /
  point-picking are announced to assistive tech.
- Every field label is programmatically associated with its input; the layer
  opacity sliders got `aria-label`s; a keyboard `:focus-visible` ring was
  added (there was none); and the example-DEM loaders are real `<button>`s
  instead of `<a href="#">`.

### Sidebar declutter

- The explanatory hint paragraphs were removed from the sidebar and their
  content migrated into the Help modal (`?`), which now also documents the
  maximize/length-DP mode, the OSM/Overpass pull, the native backend,
  worker-pool sizing, QMC sampling, GeoJSON reference loading, the round-trip
  budget modes, and the energy/passes range & blend controls. Nothing was
  lost — just rehomed.

## v16 — 2026-06-19

### Fixes

- Compute-time estimate is now correct for **network-graph and interpolation**
  runs (it was badly off for both):
  - **Graph mode** ("follow the vectors") was estimated with the *raster*
    model — cost ∝ 135 M grid cells — when a graph Dijkstra is ∝ the network's
    **edges**, orders of magnitude fewer. The estimate over-shot by ~1000×. It
    now uses a graph-size model (edges × refs), learned per-network via a new
    online correction.
  - **The IDW interpolation fill is now a separate phase**, not a fixed
    fudge bolted onto the compute. It frequently *dominates* a
    network-constrained run (it fills the whole grid while the compute touches
    only network cells/edges), and it scales with the **max ray distance**,
    which the old term ignored entirely. Graph-mode interp (single-worker) and
    raster-constrained interp (banded across the pool) are sized accordingly.
  - Compute and interpolation are corrected **independently** now — previously
    a slow interpolation inflated the compute correction (and a recompute would
    then over-estimate plain runs).
  - Toggling **Interpolate / Compute-on-graph / Constrain-to-network** (and the
    max-distance and smoothing inputs) now updates the estimate — those
    controls weren't wired to it before.
- Native backend log line is now self-describing: it echoes the request shape
  — `Emax=…, mode=…, type=vector|raster` — alongside the grid/slice info.

## v15 — 2026-06-19

### Improvements

- Reloading an exported bundle now restores **all** saved layers, not just
  the energy and passes rasters. Top-N routes and the maximize path were
  already written to the zip (`routes.geojson` / `path.geojson`), but the
  loader never read them back — it redrew the fields and told you to
  recompute the lines. The GeoJSON is now parsed on reload and its
  coordinates converted back to cell indices (the exact inverse of the
  export mapping, gated on the same strict DEM-dimension match that guards
  the raster replay), so the routes/path come back and recolor exactly like
  a fresh compute, with no recompute needed. Any subset works — a maximize
  bundle restores its path, a top-N bundle its routes, a density bundle just
  its field. (Graph-mode `graph_edges.geojson` is still not restored — it
  needs the full graph object, not just edge geometry.)

## v14 — 2026-06-19 (unreleased)

### Fixes

- Compute-time estimate is now accurate to ~±20% with no systematic bias
  (was up to ~3× low). Two independent errors were found by benchmarking
  estimate-vs-actual across DEMs (sampa_geral/centro/aguapreta), budgets,
  modes, and engines:
  - **Backend density on a large DEM under-estimated ~3×.** The estimate
    assumed parallelism scaled with cores (`min(refs, cores, 8)`), but the
    backend caps concurrent rayon slices to a *memory* budget — each slice
    holds full-grid scratch (~5 GB on the 135 M-cell DEM), so only 1-2 fit
    regardless of core count. It also used a native-speedup constant ~2× too
    low. The backend estimate now replicates the slice cap
    (`min(refs, cores, mem_budget / per_slice)`) — `GET /health` reports
    `mem_budget_bytes` — plus a bandwidth-contention term and a corrected
    nominal speedup.
  - **Small DEMs under-estimated up to ~3.8× at low budgets.** The probe ran
    at a fixed energy budget that *saturated* small grids (explored = the
    whole DEM), so the budget→explored extrapolation was anchored at a
    meaningless point. The calibration probe now caps by settled-cell count
    instead — bounding its wall time to ≤~1.5 s on any DEM (the responsiveness
    target) while always anchoring at an unsaturated point, with the explored
    and per-ref laws scaled from there.
  - An **online correction** now learns actual/predicted per engine from each
    completed compute (EMA), so the estimate converges to this machine and
    server's reality within a run or two — covering the residual the
    inherently server-dependent backend factor can't be predicted a priori.

## v13 — 2026-06-18 (unreleased)

### Features

- "Follow the vectors" network-graph mode (new `graph-engine.js`). When a
  vector network is loaded, the optional *Compute on network graph* toggle
  routes on the real polyline graph instead of the rasterised mask, so
  passes/paths trace the vectors with no staircase, corner-cutting, or
  width-fattening. The network is planarised with a selectable junction mode
  — *also at crossings* (splits segments at intersections so at-grade
  crossings route) or *only shared endpoints* (connects solely where lines
  share a vertex, preserving bridges/overpasses). Edge costs reuse the exact
  asymmetric energy model, sampled along the true geometry over the DEM
  (bit-parity with the grid step asserted in `test-graph-engine.mjs`). All
  compute modes are supported (from/to, round, top-N routes, maximize,
  multi-reference density), results render as a colored-vector overlay, and
  style-knob changes recolor without recomputing. JS-only — the Rust backend
  is untouched.

## v12 — 2026-06-12 (unreleased)

### Performance

- Multi-reference density runs split across a worker pool
  (`min(cores − 1, K, memory cap)`) — near-linear speedup, merged on the
  main thread. Combined with Dijkstra heap optimisations (hole-sifting,
  zero-allocation pops, flat-index neighbour deltas): ~10× on typical
  8-core density runs, bit-identical outputs.
- Optional native Rust backend (`backend/`, **off by default**): density
  runs on all cores via rayon, radix-heap Dijkstra, scratch-buffer reuse,
  ~7× over the sequential JS path; automatic fallback to browser workers.
- Compute-time estimate is now budget- and engine-aware. It was assuming a
  full-grid Dijkstra at a fixed rate, so changing the energy budget didn't
  move it at all (off by ~3-18× on huge DEMs). A one-shot calibration probe
  at DEM load now learns this terrain's real per-cell rate and
  budget→explored relationship; the live estimate scales with the budget
  (explored ∝ (eMax/alpha)²), divides by the density worker-pool size, and
  reflects the native backend when enabled. Shows "estimating…" until the
  probe lands.
- Density compute engine rewritten (`densityField` in `energy-worker.js`):
  one reused scratch set with targeted reset/accumulate over only the
  explored cells (an energy budget makes that a small fraction of the
  grid), and an exact monotone **radix heap** matching the native
  backend's queue. On the 135 M-cell `sampa_geral` DEM (5 refs, budget
  150) this brings the in-browser density run to within ~15-20% of the
  native Rust backend's compute time — both are memory-bandwidth-bound at
  that size, so the residual is the JS-vs-native floor. Like the backend,
  the radix heap settles in exact cost order except on genuine f64 cost
  ties (either equal-cost parent is a valid optimum); the browser density
  field now matches the backend's tie behaviour rather than the old binary
  heap's.
- Density scales to large workloads without crashing. Browser: density
  workers are leaner (passes + density f32, energySum stays f64), and the
  pool memory cap now budgets against `navigator.deviceMemory` with an
  accurate per-worker estimate — so medium DEMs parallelise where they
  couldn't before. A 135 M-cell DEM still runs single-threaded on 16 GB
  (two workers can't fit; `deviceMemory` caps at 8 GB so we can't detect
  bigger machines) — an optional "Max compute workers" override lets users
  who know they have the RAM force parallelism. Backend: it no longer
  OOM-crashes at high ref counts — concurrent rayon slices are capped to a
  memory budget (auto-detected, or `SIMU_MAX_MEM_GB` / `--max-mem-gb` /
  `RAYON_NUM_THREADS`); fewer slices just run more refs serially. Scratch
  `passes` is f32 (parity-safe).

### Features

- Quasi-Monte-Carlo sampling option (Sobol / Halton) for "Place random"
  reference placement; sequences continue across clicks.
- Round-trip budget mode: energy budget can cap each leg (old behaviour,
  default) or the round-trip total ("Budget applies to" select).
- Round-mode passes are filtered: only completable (in-budget, displayed)
  destinations count as trajectory endpoints.
- "Energy color" passes blend mode: corridor hue from the energy field's
  colormap, opacity from the passes intensity (min/max/γ shape the alpha).
- Optional vector-network rendering: black lines at a configurable ground
  width (default 4 m, zoom-compensated) with an opacity slider,
  canvas-rendered, 2 M-vertex safety cap. Layers stack deterministically
  via dedicated panes (default relief < energy < network < passes <
  routes), user-reorderable via the "Layer stacking order" modal
  (persisted per device).
- "Constrain compute to network" toggle — keep a network loaded (and
  drawn) without restricting the search graph.
- Basemap selector: OSM, Carto minimalist dark/light (no labels), or
  solid black / white / gray with no tiles.
- "Export rendered images": zips the displayed energy/passes PNGs with
  world files (.pgw/.prj) — styled layers drop into QGIS georeferenced.
- "Pull streets from OSM": queries Overpass for highway=* over the
  current map view ∩ DEM extent and rasterises the ways as the network —
  no .gpkg needed.
- "Compare with unconstrained": with a constraining network, Compute runs
  both scenarios in parallel and a selector switches the energy layer
  between constrained / unconstrained / difference (the energy cost of
  the network).
- Changelog section in the help modal (collapsed by default).
- SEO/LLM metadata: meta description, canonical URL, Open Graph/Twitter
  cards, schema.org WebApplication JSON-LD, noscript summary, llms.txt,
  sitemap.xml; lang attribute fixed to pt-BR (matches default content).
  deploy.sh ships llms.txt, sitemap.xml and CHANGELOG.md.

- Network interpolation is much faster: an integer chamfer prefilter
  skips cells provably beyond any ray's reach (~4× on networks smaller
  than the DEM), and the fill runs banded across the worker pool
  (~×cores). Outputs stay bit-identical. Smoothing runs as a single
  post-merge pass.
- Scenario comparison extended: passes are computed for both scenarios
  (signed difference shows corridors the network creates), and the
  comparison also works in multi-reference density mode (two sequential
  runs splitting the progress bar, browser pool or native backend). The
  selector now switches energy AND passes together. In "difference" mode
  the passes layer overlays both scenarios — constrained light red,
  unconstrained light green, additively blended (overlap sums to a soft
  yellow, coincident corridors brighten). The channels share one scale by
  default; a green-channel sub-panel (min/max/γ/mean filter, blank =
  inherit red) lets each be tuned independently. The energy difference is analysed on network cells and then
  interpolated across the grid like the constrained field (when interp is
  on).

### Fixes

- PWA manifest restored (deleted in the v11 commit; broke deploys, blocked
  every future service-worker install, and PWA install).
- Service worker: synchronous `Response.clone()` (intermittent cache-write
  failures), `event.waitUntil` on background cache writes, 5xx navigation
  fallback to the cached shell, maskable icons precached.
- CDN libraries get SRI hashes + `crossorigin` — also makes them
  runtime-cacheable, fixing offline mode.
- GeoPackage parser handles ISO Z/M geometry types (1002 etc.) — 3-D
  .gpkg files no longer rasterise to an empty network.
- Stale-result race fixed: loading a DEM/network mid-compute cancels
  in-flight workers (generation counter) instead of rendering old arrays
  onto the new grid.
- Worker crash/load failure now surfaces an error instead of leaving the
  UI stuck on "Computing…".
- User-derived strings escaped before status-bar HTML interpolation.
- Native-backend runs: liveness ticker (elapsed time) while the server
  computes; errors after a successful response surface instead of
  silently recomputing in the browser; response parsed zero-copy (the
  backend 8-byte-aligns its payload); the post-merge network
  interpolation phase shows status + progress (it previously looked like
  a hang on large DEMs).
- Density mode + constraining network: Compute used to abort silently —
  the compute-time network re-snap treated the (always-null in density
  mode) src point as a snap failure and returned before dispatching any
  work. src/dst are now only re-snapped when set; density reference
  points get their own re-snap onto the network (markers follow), and
  "Place random" samples are snapped to the network at placement time.
- Network snap no longer dead-ends: clicks snap to the nearest network
  cell grid-wide (expanding-ring search) instead of being rejected beyond
  the snap-radius input — on sparse networks every click used to fail,
  leaving Compute permanently disabled. Networks that rasterise to 0 cells
  (CRS/geometry mismatch) are rejected loudly instead of silently bricking
  clicks; the GeoPackage geometry column name is now read from
  gpkg_geometry_columns instead of being hardcoded to "geom".
- Bundle-before-DEM order now works: a bundle loaded without (or against
  the wrong) DEM is held as pending — rasters included — and re-applied
  automatically when a DEM with matching dimensions is loaded. Previously
  the DEM load wiped the restored src/dst/ref points and the bundle's
  rasters were lost.
- Density-mode map clicks no longer silently set src/dst when placement
  is "random"; "Refresh style" button no longer loses its PT translation;
  deploy.sh staging-dir leak and GNU-cp portability fixed.

## v11 — 2026-05-13

- Wasm engine removed — JS worker is the only compute engine.
- Fix layered-DP backtrack direction bug (spurious `backtrack_fail`).
- Fix ReferenceError on `autoMax`/`passesMax` in result metadata.

## v8–v10 — 2026-05

- Reverse-optimisation toggle (maximize energy): edge costs inverted
  against a precomputed `MAX_EDGE_COST`.
- Length-constrained max-cost path via layered DP (exactly L edges,
  memory-capped).
- DP failures (unreachable, memory cap) surfaced in the UI via warning
  messages.

## v4–v7 — 2026-05

- DEM relief layer: cmocean.phase elevation × slope hillshade.
- Locate-me button; mobile drawer refinements.
- OOM fixes for 100 M-cell DEMs: reservoir-sampled percentiles,
  stride-downsampled relief canvas, slope buffer dropped after render.
- Same OOM fix applied to the energy/passes renderer; skip relief on
  non-geographic DEMs; harden localStorage for iOS private browsing.

## v1–v3 — 2026-05-08

- First public shell: GeoTIFF DEM loading (geotiff.js 3.x), asymmetric-cost
  8-connected Dijkstra energy fields (α/β/η model), passes count, top-N
  routes with repulsion modes, multi-reference density, vector-network
  constraint (.gpkg via sql.js), GDAL-style IDW fill, bundle export
  (georeferenced GeoTIFFs + JSON-LD metadata), PT/EN i18n, FABDEM viewport
  loader, PWA shell with offline precache.
