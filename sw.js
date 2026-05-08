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

const VERSION  = "v1";
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
  "./energy-worker-wasm.js",
  "./wasm/pkg/energy_wasm.js",
  "./wasm/pkg/energy_wasm_bg.wasm",
  "./manifest.webmanifest",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
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
  // propagate quickly; fall back to the cached shell for offline launch.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(() => caches.match("./index.html")),
    );
    return;
  }

  event.respondWith(handle(req));
});

// Cache-first with stale-while-revalidate. Returns the cached copy
// immediately if there is one, and refreshes the cache in the background
// from the network. On cache miss, fetch from network and stash a copy.
async function handle(req) {
  const cached = await caches.match(req);
  if (cached) {
    // Background refresh, ignored failures — offline browsing is fine.
    fetch(req).then((res) => {
      if (res && res.ok) {
        caches.open(RUNTIME).then((c) => c.put(req, res.clone()));
      }
    }).catch(() => {});
    return cached;
  }

  try {
    const res = await fetch(req);
    if (res && res.ok && res.status < 400) {
      // Cache only successful responses. opaque (cross-origin no-cors)
      // and 4xx/5xx are skipped to avoid poisoning the cache.
      caches.open(RUNTIME).then((c) => c.put(req, res.clone()));
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
