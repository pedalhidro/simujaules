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
//              after response,
//              zero-copy parse, interp progress. Network snap is
//              grid-wide (radius input = quiet zone, no rejection dead
//              end); .gpkg geom column from metadata; 0-cell networks
//              rejected with a clear error. SEO/LLM metadata
//              (description, canonical, OG, JSON-LD, llms.txt, sitemap).
const VERSION  = "v12";
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
