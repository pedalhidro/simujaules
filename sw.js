// Service worker for the Simujoules PWA.
//
// Caching strategy:
//   PRECACHE — same-origin app shell, installed atomically. Bumping the
//              VERSION constant invalidates this on next activate.
//   RUNTIME  — opportunistic cache for same-origin/CORS runtime fetches:
//              CDN libs (Leaflet, GeoTIFF, JSZip, proj4, sql.js), fonts,
//              small data files. Populated on first network success;
//              cache-first thereafter with a quiet background revalidation
//              so updates land on the second load.
//
// What we *don't* cache (deliberately):
//   - Basemap/overlay tile images — tile layers load without crossorigin, so
//     their responses are opaque and refused by the non-2xx guard in handle().
//   - Large data files: DEM rasters (.tif/.tiff) and GeoPackages (.gpkg) are
//     exempted from the fetch handler entirely (network/HTTP cache only), and
//     anything over MAX_RUNTIME_BYTES is skipped as a belt-and-braces cap.
//     The user picks a fresh DEM, the worker sees a bare-metal fetch, no
//     storage hit.
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
// The per-version history lives in CHANGELOG.md only (its newest heading
// must equal VERSION — test-changelog.mjs checks it).
const VERSION  = "v82";
const PRECACHE = `simu-precache-${VERSION}`;
const RUNTIME  = `simu-runtime-${VERSION}`;

// Belt-and-braces cap on RUNTIME entries: the .tif/.gpkg exemption above the
// fetch handler already keeps the known big files out, but any other huge
// response would both bloat the cache AND get fully re-downloaded in the
// background on every reuse (stale-while-revalidate). Responses whose
// Content-Length parses above this are served but never cached. When
// Content-Length is ABSENT — common on chunked/Content-Encoding responses
// through a CDN — we can't trust "no header" to mean "small": putIfWithinCap
// below counts the decoded bytes off the stream instead, so a big body still
// can't slip past the cap uncapped.
const MAX_RUNTIME_BYTES = 30 * 1024 * 1024;

// Cache `res` into RUNTIME if it fits the size cap; a no-op otherwise. `res`
// must already be a clone the caller owns (see the "res.clone() must happen
// synchronously" note on handle(), below) — this function may consume its
// body.
//   - Content-Length present: today's fast path (size check, then put).
//   - Content-Length absent, no body: nothing to count — put directly.
//   - Content-Length absent, has a body: read it via the stream reader,
//     counting bytes; cancel and skip caching once the count exceeds the
//     cap, otherwise rebuild a Response from the counted chunks. The rebuilt
//     Response's body is the DECODED bytes (the reader already inflated
//     them), so content-encoding/content-length/transfer-encoding are
//     stripped from its headers — keeping them would corrupt a later
//     cache.match() read (a decoder trying to re-inflate already-decoded
//     bytes, or a length header that no longer matches the body).
async function putIfWithinCap(req, res) {
  const len = parseInt(res.headers.get("content-length") || "", 10);
  if (Number.isFinite(len)) {
    if (len > MAX_RUNTIME_BYTES) return;
    const cache = await caches.open(RUNTIME);
    return cache.put(req, res);
  }

  if (!res.body) {
    const cache = await caches.open(RUNTIME);
    return cache.put(req, res);
  }

  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RUNTIME_BYTES) {
      reader.cancel();
      return; // over cap — do not cache (memory bounded to ~cap + one chunk)
    }
    chunks.push(value);
  }

  const headers = new Headers(res.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  const rebuilt = new Response(new Blob(chunks), {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
  const cache = await caches.open(RUNTIME);
  return cache.put(req, rebuilt);
}

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
  // The UI modules app.js imports, in evaluation order (see app.js).
  "./app/i18n.js",
  "./app/panel.js",
  "./app/boot.js",
  "./app/map.js",
  "./app/state.js",
  "./app/compute-source.js",
  "./app/dom.js",
  "./app/dem.js",
  "./app/network.js",
  "./app/bridges.js",
  "./app/draw.js",
  "./app/water.js",
  "./app/network-view.js",
  "./app/graph-mode.js",
  "./app/points.js",
  "./app/run.js",
  "./app/kpi.js",
  "./app/maxseg.js",
  "./app/render.js",
  "./app/refgeom.js",
  "./app/engines.js",
  "./app/cloud.js",
  "./app/estimate.js",
  "./app/colormaps.js",
  "./app/geotiff.js",
  "./app/grid.js",
  "./app/bundle.js",
  // Pure helpers shared with the tests and headless tools.
  "./lib/changelog.js",
  "./lib/census-sampler.js",
  "./lib/cost.js",
  "./lib/dem-smoothing.js",
  "./lib/maxseg-coarsen.js",
  "./lib/pool-merge.js",
  "./lib/ref-energy.js",
  "./lib/run-message.js",
  "./lib/water-raster.js",
  "./energy-worker.js",
  "./graph-engine.js",
  "./wasm-worker.js",
  "./engine32.wasm",
  "./manifest.webmanifest",
  "./icons/icon-v2.svg",
  "./icons/icon-192-v2.png",
  "./icons/icon-512-v2.png",
  "./icons/icon-maskable-192-v2.png",
  "./icons/icon-maskable-512-v2.png",
  "./icons/apple-touch-icon-v2.png",
  "./vocab/simujoules.jsonld",
  // The help modal renders its changelog from this file (lib/changelog.js);
  // precached so the section still opens offline.
  "./CHANGELOG.md",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(PRECACHE)
      // cache: "reload" — the precache must bypass the browser HTTP cache
      // (deploy.sh serves app.js/workers with max-age=3600), or a VERSION
      // bump can install a stale, mixed-version shell. Still atomic.
      .then((cache) => cache.addAll(
        PRECACHE_URLS.map((u) => new Request(u, { cache: "reload" })),
      ))
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

  // Skip big data files entirely — DEM rasters, GeoPackage networks
  // (the "Viário RMSampa" example alone is ~145 MB) and FlatGeobufs (v73:
  // the viário/água/pontes + census pulls issue THOUSANDS of Range requests
  // against multi-GB .fgb files — each was paying a cache lookup + a 206
  // body clone here, and Cache.put refuses 206s anyway) go straight to the
  // network/HTTP cache. Returning without calling respondWith() lets the
  // browser handle the request normally.
  if (/\.(tiff?|gpkg|fgb)$/i.test(url.pathname)) return;

  // Skip the Photon geocoder (the 🔍 address search) — handle()'s cache-first
  // would freeze each query's results forever and bloat RUNTIME with one
  // entry per keystroke. Straight to the network; offline search is useless
  // anyway.
  if (url.hostname === "photon.komoot.io") return;

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
          return putIfWithinCap(req, copy);
        }
      }).catch(() => {}),
    );
    return cached;
  }

  try {
    const res = await fetch(req);
    if (res && res.ok && res.status < 400) {
      // Cache only successful responses. opaque (cross-origin no-cors) and
      // 4xx/5xx are skipped to avoid poisoning the cache; over-cap bodies
      // are skipped inside putIfWithinCap.
      const copy = res.clone();
      event.waitUntil(putIfWithinCap(req, copy));
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
