// Service worker for the Simujoules PWA.
//
// Caching strategy:
//   PRECACHE — same-origin app shell, installed atomically. Bumping the
//              VERSION constant invalidates this on next activate.
//   RUNTIME  — opportunistic cache for cross-origin libs (Leaflet, GeoTIFF,
//              JSZip, proj4, sql.js) and fetched tile images. Populated on
//              first network success; cache-first thereafter with a quiet
//              background revalidation so updates land on the second load.
//
// What we *don't* cache:
//   - Large DEM rasters (.tif/.tiff). Per the chosen scope (PWA shell only),
//     DEMs are network-only. The user picks a fresh DEM, the worker sees a
//     bare-metal fetch, no storage hit.
//   - Anything that isn't a GET. POST/PUT/DELETE are passed through.
//
// To force an update during dev, bump VERSION and reload — `activate` purges
// every cache that doesn't match. deploy.sh sets no-cache on this file so
// browsers actually fetch the new version instead of staling out.

// Bump on every deploy that ships meaningful behavioural changes to the
// app shell — the activate handler purges any cache whose name doesn't
// match these two, so an old cached app.js / index.html / wasm /
// geotiff CDN URL is replaced on the user's next visit instead of
// lingering until manual reload.
//   v1 → v2: GeoTIFF library upgrade (3.0.5), bundle outputs as .tif,
//            mobile drawer, sidebar tightening.
//   v2 → v3: PT/EN i18n toggle, FABDEM viewport loader,
//            astar mask-relaxation fix.
//   v3 → v4: Locate-me button, hamburger to bottom-left on mobile,
//            DEM relief (cmocean.phase + slope multiply) layer.
//   v4 → v5: Relief OOM fix on huge DEMs — reservoir-sampled
//            percentiles, stride-downsampled canvas, drop slope array
//            after render. Locate button uses panTo (no zoom change).
//   v5 → v6: Same OOM fix in renderFieldToDataURL (energy/passes),
//            drawer-toggle z-index fix so close-via-hamburger works,
//            skip relief render on non-geographic DEMs, harden
//            localStorage access for iOS private-browsing.
//   v6 → v7: Wasm support removed entirely — energy-worker-wasm.js and
//            wasm/pkg/* dropped from precache.
//   v7 → v8: Reverse-optimisation toggle (maximize energy) in the
//            Parameters group; worker now accepts a maximize flag and
//            inverts edge costs against a precomputed MAX_EDGE_COST.
//   v8 → v9: Length-constrained max-cost path via layered DP (L > 0
//            input under the Maximize toggle).
//   v9 → v10: Surface DP failures (unreachable, memory cap) to the UI
//             via a "warning" message instead of silently console.warn.
//   v10 → v11: Fix layered-DP backtrack sign error (was reading the
//              direction array but subtracting the offset, sending the
//              walk the wrong way → spurious "backtrack_fail"). Fix
//              ReferenceError on autoMax/passesMax in renderResult.
//   v11 → v12: Density worker pool + Dijkstra heap optimisations;
//              manifest link fixed (index.html pointed at a manifest.json
//              that never existed); CDN libs get SRI + crossorigin (which
//              also makes them runtime-cacheable here — no-cors responses
//              were opaque and never cached, so offline mode lacked the
//              libraries); maskable icons precached; synchronous
//              res.clone() before the body can be consumed. QMC
//              (Sobol/Halton) sampling option for "Place random" refs.
//              Round-trip budget mode: eMax can cap each leg (old
//              behaviour, default) or the round-trip total. Round-mode
//              passes are filtered: only displayed (feasible/in-budget)
//              destinations count as trajectory endpoints. "Energy color"
//              passes blend (hue from energy field, alpha from passes).
//              Optional vector-network rendering (black lines, adjustable
//              ground width + opacity; deterministic layer stacking via
//              dedicated panes, user-reorderable in a modal) and
//              constrain-to-network toggle. Basemap selector (OSM, Carto
//              minimal, solid colours). Rendered-image export (PNG +
//              world files). Changelog in the help modal +
//              CHANGELOG.md (see CLAUDE.md: keep all three in sync).
//              Fix bundle-before-DEM order: pending bundle re-applied on
//              matching DEM load instead of being wiped. Density+network
//              Compute no longer aborts silently (null-src re-snap bug);
//              random refs snap to the network. OSM (Overpass) network
//              pull; constrained-vs-unconstrained compare + difference
//              fields (energy diff interpolated; passes overlaid red/
//              green additively with per-channel min/max/gamma/filter,
//              also in density mode); interp
//              prefilter + pooled banding (bit-identical, ~4x clustered,
//              xcores everywhere); backend liveness ticker, hard-fail
//              after response; budget- and engine-aware compute-time
//              estimate (per-DEM calibration probe at load);
//              density engine rewritten (reused scratch +
//              targeted reset + radix heap) — in-browser density now within
//              ~20% of the native backend on huge DEMs;
//              density workers leaner (f32) + deviceMemory-budgeted pool +
//              opt-in max-workers override; backend caps rayon slices to a
//              memory budget (SIMU_MAX_MEM_GB) so it no longer OOMs at scale;
//              zero-copy parse, interp progress. Network snap is
//              grid-wide (radius input = quiet zone, no rejection dead
//              end); .gpkg geom column from metadata; 0-cell networks
//              rejected with a clear error. SEO/LLM metadata
//              (description, canonical, OG, JSON-LD, llms.txt, sitemap).
//   v12 → v13: "Follow the vectors" network-graph mode (new graph-engine.js,
//              now precached): routes on the real polyline graph (planarised,
//              both junction modes) instead of the rasterised mask — passes
//              trace the vectors, rendered as a colored-vector overlay. All
//              compute modes; JS-only (Rust backend untouched). Bumped so the
//              new worker (graphBuild/graphRun) + graph-engine.js actually
//              install — a v12 cache would serve the pre-graph worker.
//   v13 → v14: Compute-time estimate accuracy fix. The v12 estimate could be
//              ~3× low (backend density on a huge DEM): it assumed all cores
//              parallelise, ignoring the server's memory-bounded slice cap
//              (1-2 slices fit, not cores-many), and used a too-low native
//              speedup. The calibration probe is now cell-capped (≤~1.5 s on
//              any DEM, anchored unsaturated — fixes a separate up-to-3.8×
//              error on small DEMs), the backend estimate replicates the slice
//              cap (/health now reports mem_budget_bytes), and an online
//              correction learns actual/predicted per engine. Bumped so the
//              new probe protocol (maxSettled) + estimate worker install.
//   v14 → v15: Bundle reload restores ALL saved layers, not just the energy/
//              passes rasters. The top-N routes and the maximize path were
//              exported to the zip (routes.geojson / path.geojson) but the
//              loader never read them back — reload redrew the fields and told
//              you to recompute the lines. Now the GeoJSON is parsed and its
//              coords are converted back to cell indices (exact inverse of the
//              export mapping, gated on a strict DEM-dimension match), so the
//              routes/path render and recolor identically to a fresh compute,
//              with no recompute. Bumped so the updated app.js installs.
//   v15 → v16: Time estimate now correct for network/graph runs. Graph mode
//              ("follow the vectors") was estimated with the raster model
//              (~1000× too high — a graph Dijkstra is ∝ edges, not 135 M
//              cells); it now uses a graph-size model. The IDW interpolation
//              fill is a separate, often-dominant phase (scales with N and the
//              max ray distance — previously ignored). Compute and interp are
//              corrected independently (a slow interp no longer inflates the
//              compute estimate), and toggling interp / graph / constrain now
//              moves the number. Bumped so the updated app.js installs.
//   v16 → v17: UI/accessibility pass. The "Load DEM" and "vector network"
//              groups light up (accent border + bar) once their data is
//              loaded. Parameter/visualization choices now persist across
//              reloads (localStorage). The clear-points / place-random /
//              clear-refs buttons are clustered together (clear-points on
//              top); only the src/dst picker fades in density mode now, not
//              the whole group. Sidebar hint paragraphs were removed and
//              their content migrated into the Help modal (which now also
//              documents maximize, OSM pull, the native backend, worker
//              sizing, QMC sampling, etc.). Accessibility: #status is an
//              aria-live region, field labels are programmatically
//              associated with their inputs, opacity sliders got aria-labels,
//              a global :focus-visible ring was added, and the example DEM
//              loaders are now <button>s instead of <a href="#">. Bumped so
//              the updated app.js / index.html install.
//   v17 → v18: Optional impassable mask (group 1c). Upload a binary GeoTIFF
//              (1=impassable, e.g. water); it's resampled onto the DEM grid by
//              area-coverage majority (≥50% ⇒ blocked) and blocks routing. The
//              vector network can carve passable "bridge" corridors across it,
//              with a smooth elevation offset (linear ramp from each shore to a
//              +/- peak at the bridge centre, clamped −5…+15 m). Composed
//              app-side in buildComputeGrid() — energy-worker.js and the Rust
//              backend are unchanged (bit-parity preserved). Bundles gain
//              impassable.tif. Bumped so the updated app.js / index.html install.
//   v18 → v19: Optional OSM bridges & tunnels (group 1d). A dedicated pull
//              queries Overpass for way[bridge] (+ tunnel=yes) over the DEM
//              extent and models each as a level deck between its two ground
//              abutments. In the raster compute each deck is a PORTAL EDGE
//              between its end cells at the flat-deck cost, relaxed alongside
//              the grid edges — the cells UNDER the deck keep ground elevation,
//              so the route over a bridge and the route under it both stay
//              correct (true multi-level on a 2.5-D grid). Engine change:
//              dijkstra/densityField (energy-worker.js) + dijkstra_tree
//              (backend/src/main.rs) gain portal relaxation; portal costs
//              match bit-for-bit (test-backend.mjs +portals cases). Graph mode
//              ("follow the vectors") also goes multi-level: the OSM streets
//              pull captures bridge/tunnel/layer tags, and graph-engine.js
//              suppresses different-layer crossing junctions + flattens deck
//              edges. Bundles gain bridges.geojson. Bumped so the updated
//              worker/backend/app install.
//   v19 → v20: Bridge follow-ups. (1) Deck passes/density: a portal jumps
//              abutment→abutment, so deck cells showed no passes even when the
//              bridge carried heavy traffic — now painted with the crossing
//              flow (min of the two abutments' passes). (2) Groups 1c/1d
//              (impassable mask, bridges) light up when their data is loaded.
//              (3) New 1d source: extract bridges/tunnels from the already-
//              loaded vector network (gpkg tags / OSM other_tags) — offline, no
//              Overpass. (4) 1c/1d each get an "apply to compute" toggle to
//              enable/disable their effect without clearing the data. Bumped so
//              the updated app.js installs.
//   v20 → v21: Fix: "Load FABDEM for current viewport" threw "TypeError: t is
//              not a function". The tile-mosaic loop's variable (const t =
//              opened[i]) shadowed the i18n t() function, and the v19/v20 status
//              i18n migration added a t("status.fabdem_mosaic") call inside that
//              loop — so it invoked the tile object. Renamed the loop var to
//              `tile` (both tile loops). App-only patch; engine/backend unchanged.
//   v21 → v22: New 1c source — "Pull water from OSM". Queries Overpass over the
//              DEM extent and rasterises an impassable mask onto the DEM grid:
//              water AREAS (natural=water / waterway=riverbank / landuse=reservoir,
//              ways + multipolygon relations) via even-odd fill; the open SEA
//              (natural=coastline, land-left/water-right) via a horizontal+vertical
//              orientation sweep (gap-tolerant, no flood-leak); and NON-tunnelled
//              waterway=river LINES via supercover (with a "Rivers (lines)
//              impassable" toggle). Streams + tunnelled waterways stay passable.
//              Reuses the uploaded-mask pipeline (Invert, corridors, overlay,
//              bundle). App-only; engine/backend unchanged. New test:
//              test-water-raster.mjs. Bumped so the updated app.js installs.
//   v22 → v23: OSM `ele` on bridge/tunnel decks. The 1d "Pull bridges & tunnels
//              from OSM" pull now also fetches node `ele` tags and uses the
//              mapped deck elevation for the raster PORTAL endpoint heights
//              (per-abutment, with way-`ele` / nearest-node fallback). Unmapped
//              ends fall back to the bare-earth DEM (NaN sentinel), so a pull
//              without ele is byte-identical to v22. Threaded through the worker
//              pool + native backend Blob (now 32 B/portal) and persisted in the
//              bundle (bridges.geojson). energy-worker.js + backend/src/main.rs
//              kept bit-parity (test-backend.mjs +ele cases). Graph mode stays
//              DEM-based for now.
//   v23 → v24: UX fix — "Compute on network graph (follow the vectors)" wins the
//              run dispatch over the raster "Constrain to network" / "Compare
//              with unconstrained" toggles, so with graph mode on (it's persisted,
//              so it can be on silently from a prior session) the compare never
//              ran and its "Displayed scenario" dropdown never appeared. Graph
//              mode now greys out + disables those two toggles (with a tooltip)
//              while it's on, on toggle AND on load. App-only; no engine change.
//   v24 → v25: Graph mode now RUNS the comparison instead of disabling it.
//              "Constrain to network" is forced on + locked (graph mode is
//              inherently network-constrained) while "Compare with unconstrained"
//              stays togglable: graph mode runs a full-DEM unconstrained RASTER
//              scenario alongside the graph compute and exposes the difference via
//              the "Displayed scenario" picker (graph / unconstrained / difference).
//              Native backend single-source: "Use native backend" moved out of the
//              density panel (always visible) and now also accelerates from/to/round
//              ENERGY-FIELD runs via a new POST /single endpoint (top-N/path/maximize
//              stay browser-only; auto-fallback unchanged). energy-worker.js +
//              backend/src/main.rs kept bit-parity (test-backend.mjs +single cases).
//   v25 → v26: Cloud compute source. The "Use native backend (Rust)" checkbox
//              became a three-way Compute-source selector: Browser (in-page
//              workers, default), Localhost (native Rust backend), and Cloud — a
//              local orchestrator (127.0.0.1:8079) that boots a pre-baked VM on
//              demand, waits for health, proxies /density & /single, then stops
//              the VM after each run (and on tab hide). Adds a transfer-size
//              estimate. Cloud is only offered when the applet is served locally.
//              On orchestrator/boot failure the run falls back to the browser
//              pool. No new served files; compute path / bit-parity unchanged.
const VERSION  = "v26";
const PRECACHE = `simu-precache-${VERSION}`;
const RUNTIME  = `simu-runtime-${VERSION}`;

// Paths are relative to the SW's scope (the deploy root). Keep this list
// in sync with what index.html actually loads — anything missing from here
// will work online but break the offline launch.
// Precache only files we *know* will resolve — cache.addAll is atomic, so
// a single 404 in this list aborts the whole install. Bare-directory URLs
// (./) are intentionally absent: GCS / CDN configs sometimes redirect them
// and an opaque-redirect response would fail the install. The navigate
// handler below maps "./"-style requests onto cached "./index.html" anyway.
const PRECACHE_URLS = [
  "./index.html",
  "./app.js",
  "./energy-worker.js",
  "./graph-engine.js",
  "./manifest.webmanifest",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-192.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png",
  "./vocab/simujoules.jsonld",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(PRECACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      // skipWaiting: don't sit in the "waiting" state behind the previous
      // SW. Combined with clients.claim() below, the new code takes effect
      // on the very next page load instead of after every tab is closed.
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== PRECACHE && k !== RUNTIME)
            .map((k) => caches.delete(k)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // pass through

  const url = new URL(req.url);

  // Skip DEMs entirely — they're huge and the user opted out of caching
  // them. Returning without calling respondWith() lets the browser handle
  // the request normally.
  if (/\.tiff?$/i.test(url.pathname)) return;

  // For top-level navigation requests, try the network first so deploys
  // propagate quickly; fall back to the cached shell for offline launch
  // AND for 5xx edge errors (a CDN hiccup shouldn't take the app down
  // when we have a perfectly good shell cached).
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => (res && res.status < 500)
          ? res
          : caches.match("./index.html").then((c) => c || res))
        .catch(() => caches.match("./index.html")),
    );
    return;
  }

  event.respondWith(handle(event));
});

// Cache-first with stale-while-revalidate. Returns the cached copy
// immediately if there is one, and refreshes the cache in the background
// from the network. On cache miss, fetch from network and stash a copy.
//
// NOTE on scope: the background refresh writes to RUNTIME, and caches.match()
// returns a PRECACHE hit first. So stale-while-revalidate is effective for
// RUNTIME entries (cross-origin CDN libs + tiles) but INERT for the precached
// same-origin shell (app.js, workers, index.html) — by design. The shell is
// versioned: it updates atomically when VERSION bumps (install re-runs
// addAll, activate purges the old cache), never piecemeal here. That
// atomicity is what keeps app.js and energy-worker.js on the same version;
// revalidating individual precached files into PRECACHE would break it.
//
// Two subtleties:
//   - res.clone() must happen synchronously, BEFORE the response is
//     handed to the page. Cloning inside caches.open(...).then(...) races
//     the page consuming the body — clone() then throws "body already
//     used" and the cache write intermittently fails.
//   - cache writes go through event.waitUntil so the SW isn't terminated
//     mid-put after the response has been returned.
async function handle(event) {
  const req = event.request;
  const cached = await caches.match(req);
  if (cached) {
    // Background refresh, ignored failures — offline browsing is fine.
    event.waitUntil(
      fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          return caches.open(RUNTIME).then((c) => c.put(req, copy));
        }
      }).catch(() => {}),
    );
    return cached;
  }

  try {
    const res = await fetch(req);
    if (res && res.ok && res.status < 400) {
      // Cache only successful responses. opaque (cross-origin no-cors)
      // and 4xx/5xx are skipped to avoid poisoning the cache.
      const copy = res.clone();
      event.waitUntil(caches.open(RUNTIME).then((c) => c.put(req, copy)));
    }
    return res;
  } catch (err) {
    // Network is unreachable. One more cache lookup in case another tab
    // has populated it in the meantime.
    const fallback = await caches.match(req);
    if (fallback) return fallback;
    throw err;
  }
}
