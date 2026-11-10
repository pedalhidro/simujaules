#!/usr/bin/env node
// Simujaules end-to-end browser smoke harness — dev tooling (like census/ and
// mcp/), never deployed.
//
// WHAT IT IS FOR
//   1. Equivalence proof for refactors: run it on the tree before and after a
//      change and diff the two JSON reports. Every step records a deterministic
//      digest (UI text with durations stripped, SHA-256 of every map overlay
//      image and vector layer, SHA-256 of every file of an exported bundle), so
//      identical behaviour gives byte-identical reports:
//        node e2e/smoke.mjs --root <old-tree> --out old.json
//        node e2e/smoke.mjs --root <new-tree> --out new.json
//        diff old.json new.json            # empty = no observable change
//      Compare reports only from the SAME machine / Chromium build: overlay
//      hashes are PNG data URLs and PNG encoding is not portable across builds.
//      Never commit a golden report.
//   2. Pass/fail smoke (CI): exit 0 only if there was no page error, no
//      non-whitelisted console error, no failed same-origin request (a 404 for
//      a module or worker) and every step's own invariants held (pool-of-3 ≡
//      pool-of-1, style change ≠ recompute, bundle/config/dataset round trips,
//      drawn barrier cells unreachable, ...).
//
// RUN
//   cd e2e && npm ci && npx playwright install --with-deps chromium   # CI
//   node smoke.mjs [--root <dir>] [--out <report.json>] [--only <prefixes>]
//                  [--no-cdn-cache] [--chromium <path>] [--headed]
//   --root   tree to serve (default: the parent of this script's directory)
//   --out    write the full JSON report (default: print a summary only)
//   --only   comma-separated step-name prefixes; runs every GROUP containing a
//            matching step (groups share browser state, so they run whole):
//            a–l core · m raster network · n graph mode · o drawing tools ·
//            p config · q GPX overlay · r mask + dataset I/O · s Overpass (canned)
//   --no-cdn-cache   fetch CDN libraries live instead of via ./cdn-cache/
//   --chromium <path> (or env SMOKE_CHROMIUM)   explicit Chromium executable
//   Exit code: 0 clean · 1 problems (listed in the report / on stderr) · 2 crash.
//
// DETERMINISM
//   Fixed viewport (1400x900 @1), locale en-US, tz America/Sao_Paulo, service
//   worker blocked, navigator.hardwareConcurrency=4 / deviceMemory=8 pinned,
//   all inputs generated in fixtures.mjs, every wait is a condition (no sleeps).
//   Since v83 the app merges density-pool slices in SLOT order, so a pool of 3
//   is bit-reproducible: the g.density-pool3-equivalence steps run it twice,
//   require identical bytes, and record its hashes. (On a tree older than v83
//   those two steps can fail or flip — slices were summed in completion
//   order.) The other hashed density runs keep #max-workers=1, which makes
//   their digests comparable across any pair of trees; a pool of 3 only
//   matches a pool of 1 to ~1e-7 (different association of the same sum).
//
// NETWORK
//   Allowed: our own 127.0.0.1 server and the CDN hosts unpkg.com,
//   cdn.jsdelivr.net, cdnjs.cloudflare.com (cached under ./cdn-cache/ — optional,
//   gitignored, safe to delete; SRI still checked by the page). Overpass is
//   answered with a canned fixture (group s). Everything else (tiles, fonts,
//   geocoder, FABDEM, FlatGeobuf, census) is ABORTED.
//
// WHITELIST (the only one)
//   A console error is tolerated only if its text is exactly
//   "Failed to load resource: net::ERR_BLOCKED_BY_CLIENT" (optionally
//   ".Inspector") AND its location URL is one this harness aborted (always an
//   external host). The tolerated hosts are listed in the report.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// createRequire resolves from THIS directory first (e2e/node_modules), then
// the global module paths — so a local `npm ci` Playwright wins, and a
// preinstalled global one is the fallback.
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const JSZip = require("jszip");
const { fromArrayBuffer } = await import("geotiff");
const fx = await import("./fixtures.mjs");
const { DEM, cellLL, makeDemTiff } = fx;

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- arguments
const argv = process.argv.slice(2);
const arg = (name, dflt = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt;
};
const ROOT = path.resolve(arg("--root") || path.join(HERE, ".."));
const OUT = arg("--out");
const HEADED = argv.includes("--headed");
const NO_CDN_CACHE = argv.includes("--no-cdn-cache");
const CHROMIUM = arg("--chromium") || process.env.SMOKE_CHROMIUM || null;
const ONLY = arg("--only") ? arg("--only").split(",").map((x) => x.trim()).filter(Boolean) : null;
if (!fs.existsSync(path.join(ROOT, "index.html"))) {
  console.error(`smoke: no index.html under ${ROOT}\nusage: node smoke.mjs [--root <tree>] [--out <report.json>] [--only a,m,...] [--no-cdn-cache] [--chromium <path>]`);
  process.exit(2);
}
// Step groups (see header). A group runs if --only is absent or any prefix's
// first letter is one of its step letters.
const GROUPS = { core: "abcdefghijkl", net: "m", graph: "n", draw: "o", config: "p", refgeom: "q", mask: "r", osm: "s" };
const wantGroup = (g) => !ONLY || ONLY.some((p) => GROUPS[g].includes(p[0]));

// ---------------------------------------------------------------- constants
// External hosts the page may load from (scripts/styles with SRI). Everything
// else that is not our own server is ABORTED (tiles, geocoder, FABDEM,
// Overpass, FlatGeobuf, census, Google Fonts, ...).
const CDN_HOSTS = new Set(["unpkg.com", "cdn.jsdelivr.net", "cdnjs.cloudflare.com"]);
const CDN_CACHE = path.join(HERE, "cdn-cache");
// Per-wait timeout. Generous while everything passes; once any step has failed
// the run is already red, so later waits drop to DEGRADED_TIMEOUT to keep a
// broken tree's run short while still recording what else breaks.
const NORMAL_TIMEOUT = 90_000;
const DEGRADED_TIMEOUT = 5_000;
let STEP_TIMEOUT = NORMAL_TIMEOUT;

// Click targets (cell row/col). Picked inside the DEM, away from the edges and
// from the bottom-centre floating status pill.
const PT_SRC = [60, 50];
const PT_DST = [130, 190];
const PT_REFS = [[40, 40], [50, 200], [100, 120], [140, 60], [150, 170], [80, 160]];

// ---------------------------------------------------------------- helpers
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
// Strip run-time-dependent numbers (durations) from UI text; keep the rest.
function stripTimings(s) {
  if (s == null) return s;
  return String(s)
    .replace(/\d+(?:[.,]\d+)?\s*(?:ms|s|min)\b/g, "<t>")
    .replace(/\s+/g, " ")
    .trim();
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".jsonld": "application/ld+json",
  ".md": "text/markdown; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".css": "text/css; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".tif": "image/tiff",
};

function startServer(root) {
  const server = http.createServer((req, res) => {
    let p;
    try { p = decodeURIComponent(new URL(req.url, "http://x").pathname); } catch { p = "/"; }
    if (p.endsWith("/")) p += "index.html";
    const file = path.normalize(path.join(root, p));
    if (!file.startsWith(root + path.sep) && file !== root) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404, { "content-type": "text/plain" }); res.end("not found"); return; }
      res.writeHead(200, {
        "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
        "cache-control": "no-store",
      });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

// ---------------------------------------------------------------- in-page instrumentation
// Runs before any page script: captures the Leaflet map instance (the app keeps
// it in a module-scoped const), counts Workers (live = created - terminated) and
// result-meta writes, and pins navigator.hardwareConcurrency / deviceMemory so the
// worker-pool sizes (and so the pooled float sums) are machine-independent.
const INIT_SCRIPT = `(() => {
  const S = window.__smoke = { created: 0, live: 0, workerUrls: [], metaWrites: 0, maxsegWrites: 0, statusWrites: 0 };
  try {
    Object.defineProperty(Navigator.prototype, "hardwareConcurrency", { configurable: true, get: () => 4 });
    Object.defineProperty(Navigator.prototype, "deviceMemory", { configurable: true, get: () => 8 });
  } catch (e) {}
  let _L;
  Object.defineProperty(window, "L", {
    configurable: true,
    get() { return _L; },
    set(v) {
      _L = v;
      try { if (v && v.Map && !v.__smokeHooked) { v.__smokeHooked = true; v.Map.addInitHook(function () { window.__smokeMap = this; }); } } catch (e) {}
    },
  });
  const RW = window.Worker;
  if (RW) {
    window.Worker = class SmokeWorker extends RW {
      constructor(url, opts) {
        super(url, opts);
        S.created++; S.live++;
        S.workerUrls.push(String(url).replace(location.origin, ""));
        this.__smokeDead = false;
      }
      terminate() {
        if (!this.__smokeDead) { this.__smokeDead = true; S.live--; }
        return super.terminate();
      }
    };
  }
  document.addEventListener("DOMContentLoaded", () => {
    const watch = (id, key) => {
      const el = document.getElementById(id);
      if (el) new MutationObserver(() => { S[key]++; }).observe(el, { childList: true, characterData: true, subtree: true });
    };
    watch("result-meta", "metaWrites");
    watch("maxseg-meta", "maxsegWrites");
    watch("status", "statusWrites");
  });
})();`;

// ---------------------------------------------------------------- the run
const problems = [];            // fatal findings (exit 1)
const whitelisted = [];         // tolerated console errors (pattern + count)
const report = {
  harness: "simujaules-smoke/2",
  viewport: "1400x900@1",
  dem: { W: DEM.W, H: DEM.H, lon0: DEM.lon0, lat0: DEM.lat0, cellDeg: DEM.d },
  steps: [],
};

const abortedUrls = new Set();

async function newContext(browser, port, opts = {}) {
  const ctx = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "America/Sao_Paulo",
    serviceWorkers: "block",
    acceptDownloads: true,
    colorScheme: "light",
    reducedMotion: "reduce",
  });
  await ctx.addInitScript(INIT_SCRIPT);
  const ownOrigin = `http://127.0.0.1:${port}`;
  await ctx.route("**/*", async (route) => {
    const url = route.request().url();
    let u;
    try { u = new URL(url); } catch { return route.abort(); }
    if (url.startsWith(ownOrigin + "/")) return route.continue();
    if (opts.overpass && url.startsWith("https://overpass-api.de/api/interpreter")) {
      return route.fulfill({ status: 200, headers: { "content-type": "application/json", "access-control-allow-origin": "*" }, body: JSON.stringify(opts.overpass) });
    }
    if (u.protocol === "https:" && CDN_HOSTS.has(u.hostname) && route.request().method() === "GET") {
      if (NO_CDN_CACHE) return route.continue();
      const key = sha(url);
      const bodyF = path.join(CDN_CACHE, key + ".body");
      const metaF = path.join(CDN_CACHE, key + ".json");
      try {
        if (!fs.existsSync(bodyF)) {
          const resp = await route.fetch();
          if (resp.status() !== 200) { problems.push({ type: "cdn-fetch", url, status: resp.status() }); return route.fulfill({ response: resp }); }
          fs.mkdirSync(CDN_CACHE, { recursive: true });
          fs.writeFileSync(bodyF, await resp.body());
          fs.writeFileSync(metaF, JSON.stringify({ url, contentType: resp.headers()["content-type"] || "application/octet-stream" }));
        }
        const meta = JSON.parse(fs.readFileSync(metaF, "utf8"));
        return route.fulfill({
          status: 200,
          headers: { "content-type": meta.contentType, "access-control-allow-origin": "*", "cache-control": "no-store" },
          body: fs.readFileSync(bodyF),
        });
      } catch (e) {
        problems.push({ type: "cdn-fetch", url, error: String(e.message || e) });
        return route.abort();
      }
    }
    abortedUrls.add(url);
    return route.abort("blockedbyclient");
  });
  ctx.on("requestfailed", (req) => {
    const url = req.url();
    if (url.startsWith(ownOrigin + "/")) {
      problems.push({ type: "same-origin-request-failed", url: url.slice(ownOrigin.length), error: req.failure()?.errorText || "" });
    }
  });
  ctx.on("response", (resp) => {
    const url = resp.url();
    if (url.startsWith(ownOrigin + "/") && resp.status() >= 400) {
      problems.push({ type: "same-origin-http-error", url: url.slice(ownOrigin.length), status: resp.status() });
    }
  });
  return ctx;
}

function wirePage(page, label) {
  page.on("pageerror", (err) => {
    problems.push({ type: "pageerror", page: label, message: String(err.message || err), stack: String(err.stack || "").split("\n").slice(0, 4).join(" | ") });
    if (onPageError) onPageError(err);
  });
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const loc = msg.location() || {};
    const text = msg.text();
    // WHITELIST (the only one): Chromium's network-level "Failed to load
    // resource" line for a request THIS HARNESS aborted on purpose (an
    // external tile/font/... URL). Matched on the exact aborted URL, never on a
    // same-origin URL.
    if (/^Failed to load resource: net::ERR_BLOCKED_BY_CLIENT(?:\.Inspector)?$/.test(text) && loc.url && abortedUrls.has(loc.url)) {
      whitelisted.push(new URL(loc.url).hostname);
      return;
    }
    problems.push({ type: "console-error", page: label, text: text.slice(0, 500), url: loc.url || "", line: loc.lineNumber ?? null });
  });
  page.on("worker", (w) => {
    w.on("console", (msg) => {
      if (msg.type() === "error") problems.push({ type: "worker-console-error", page: label, worker: w.url(), text: msg.text().slice(0, 500) });
    });
  });
}

// ----- page-side helpers (evaluated in the page)
async function waitIdle(page, timeout = STEP_TIMEOUT) {
  // (default parameter is evaluated per call, so it follows degraded mode)
  // no live workers, no progress bar, no map animation; then two frames.
  await page.waitForFunction(() => {
    const m = window.__smokeMap;
    const prog = document.getElementById("progress");
    return window.__smoke.live === 0 && !(prog && prog.classList.contains("active")) &&
      !(m && (m._animatingZoom || (m._panAnim && m._panAnim._inProgress)));
  }, null, { timeout, polling: 50 });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

async function setValue(page, id, value) {
  await page.evaluate(([id, value]) => {
    const el = document.getElementById(id);
    if (!el) throw new Error("missing #" + id);
    el.value = String(value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, [id, value]);
}

async function setChecked(page, id, on) {
  await page.evaluate(([id, on]) => {
    const el = document.getElementById(id);
    if (!el) throw new Error("missing #" + id);
    if (el.checked !== on) el.click(); // click = real toggle + input/change events
  }, [id, on]);
}

async function clickId(page, id) {
  await page.evaluate((id) => {
    const el = document.getElementById(id);
    if (!el) throw new Error("missing #" + id);
    el.click();
  }, id);
}

// Real mouse click on the map at a DEM cell centre (lat/lng -> container point
// via the captured Leaflet map). Refuses to click if something other than the
// map's own panes would receive it.
async function clickCell(page, [r, c]) {
  const [lat, lng] = cellLL(r, c);
  const pt = await page.evaluate(([lat, lng]) => {
    const m = window.__smokeMap;
    if (!m) throw new Error("Leaflet map instance not captured");
    const p = m.latLngToContainerPoint([lat, lng]);
    const rect = m.getContainer().getBoundingClientRect();
    const x = rect.left + p.x, y = rect.top + p.y;
    const hit = document.elementFromPoint(x, y);
    const ok = !!hit && m.getContainer().contains(hit) && !hit.closest(".leaflet-marker-icon, .leaflet-control");
    return { x, y, ok, hit: hit ? (hit.id || hit.className || hit.tagName) : null };
  }, [lat, lng]);
  if (!pt.ok) throw new Error(`map click at cell ${r},${c} would hit ${pt.hit}`);
  await page.mouse.click(pt.x, pt.y);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
}

// Digest of everything on the Leaflet map (overlay images + vectors + markers),
// hashed in the page. Sorted so creation order of unrelated layers can't matter.
// compact: vectors collapsed to {count, sha} (graph mode draws one polyline
// per edge — hundreds of entries).
async function mapDigest(page, { compact = false } = {}) {
  const d = await page.evaluate(async () => {
    const m = window.__smokeMap;
    const enc = new TextEncoder();
    const h = async (s) => {
      const d = await crypto.subtle.digest("SHA-256", enc.encode(s));
      return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
    };
    const r7 = (x) => Math.round(x * 1e7) / 1e7;
    const flat = (ll) => Array.isArray(ll) ? ll.flatMap(flat) : [[r7(ll.lat), r7(ll.lng)]];
    const images = [], vectors = [], markers = [];
    const layers = [];
    m.eachLayer((l) => layers.push(l));
    for (const l of layers) {
      if (l instanceof L.ImageOverlay) {
        const b = l.getBounds();
        images.push({
          pane: l.options.pane, opacity: l.options.opacity,
          bounds: [r7(b.getSouth()), r7(b.getWest()), r7(b.getNorth()), r7(b.getEast())],
          srcSha: await h(String(l._url || "")),
          srcLen: String(l._url || "").length,
        });
      } else if (l instanceof L.Polyline) {
        const pts = flat(l.getLatLngs());
        vectors.push({
          kind: l instanceof L.Polygon ? "polygon" : "polyline",
          pane: l.options.pane, color: l.options.color ?? null, weight: l.options.weight ?? null,
          dash: l.options.dashArray ?? null, n: pts.length, geomSha: await h(JSON.stringify(pts)),
        });
      } else if (l instanceof L.CircleMarker) {
        const p = l.getLatLng();
        vectors.push({ kind: "circle", pane: l.options.pane, at: [r7(p.lat), r7(p.lng)], radius: l.getRadius?.() ?? null, color: l.options.color ?? null });
      } else if (l instanceof L.Marker) {
        const p = l.getLatLng();
        const html = l.options.icon && l.options.icon.options ? String(l.options.icon.options.html || "") : "";
        markers.push({ at: [r7(p.lat), r7(p.lng)], iconSha: await h(html) });
      }
    }
    const byJson = (a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0);
    images.sort(byJson); vectors.sort(byJson); markers.sort(byJson);
    return { images, vectors, markers };
  });
  if (compact) d.vectors = { count: d.vectors.length, sha: sha(JSON.stringify(d.vectors)) };
  return d;
}

async function uiText(page, ids) {
  return await page.evaluate((ids) => {
    const o = {};
    for (const id of ids) {
      const el = document.getElementById(id);
      o[id] = el ? el.textContent.replace(/\s+/g, " ").trim() : null;
    }
    return o;
  }, ids);
}

// Volatile metadata.jsonld fields: wall-clock stamps and durations.
const VOLATILE_MD_KEYS = new Set(["schema:dateCreated", "timestamp", "elapsedMs"]);
function stripVolatile(o) {
  if (Array.isArray(o)) return o.map(stripVolatile);
  if (o && typeof o === "object") {
    const r = {};
    for (const k of Object.keys(o)) if (!VOLATILE_MD_KEYS.has(k)) r[k] = stripVolatile(o[k]);
    return r;
  }
  return o;
}

async function digestZip(buf) {
  const zip = await JSZip.loadAsync(buf);
  const files = {};
  for (const name of Object.keys(zip.files).sort()) {
    const f = zip.files[name];
    if (f.dir) continue;
    let data = await f.async("nodebuffer");
    if (name === "metadata.jsonld") data = Buffer.from(JSON.stringify(stripVolatile(JSON.parse(data.toString("utf8"))), null, 1));
    files[name] = { bytes: data.length, sha256: sha(data) };
  }
  return files;
}

// Decode one GeoTIFF from two bundles and compare numerically: same shape,
// same finite/infinite cells, max deviation <= 1e-6 of the field max (JS slices accumulate density in Float32, so re-partitioning the refs moves the ~7th digit).
async function compareTifs(zipA, zipB, name) {
  const read = async (buf) => {
    const z = await JSZip.loadAsync(buf);
    const f = z.file(name);
    if (!f) return null;
    const ab = await f.async("arraybuffer");
    const img = await (await fromArrayBuffer(ab)).getImage();
    return (await img.readRasters())[0];
  };
  const a = await read(zipA), b = await read(zipB);
  if (!a || !b) return { equivalent: false, reason: "missing" };
  if (a.length !== b.length) return { equivalent: false, reason: "length" };
  let maxAbs = 0, maxDev = 0, finMismatch = 0, identical = true;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (Number.isFinite(x) !== Number.isFinite(y)) { finMismatch++; continue; }
    if (!Number.isFinite(x)) continue;
    if (x !== y) identical = false;
    maxAbs = Math.max(maxAbs, Math.abs(x));
    maxDev = Math.max(maxDev, Math.abs(x - y));
  }
  const rel = maxAbs > 0 ? maxDev / maxAbs : 0;
  if (process.env.SMOKE_DEBUG) console.error("[smoke] compare", name, rel);
  return { equivalent: finMismatch === 0 && rel <= 1e-6, finiteMismatch: finMismatch, relDevWithin1e6: rel <= 1e-6 };
}

async function exportBundle(page, tag) {
  const [dl] = await Promise.all([
    page.waitForEvent("download", { timeout: STEP_TIMEOUT }),
    clickId(page, "download-bundle"),
  ]);
  const p = await dl.path();
  const buf = fs.readFileSync(p);
  const keep = path.join(WORK, `bundle-${tag}.zip`);
  fs.writeFileSync(keep, buf);
  return { buf, file: keep, files: await digestZip(buf) };
}

// Click Compute and wait for a rendered result (result-meta rewritten, no live
// workers, progress bar off). Fails fast if the status line turns into an error.
async function runCompute(page) {
  await waitIdle(page);
  const before = await page.evaluate(() => {
    const b = document.getElementById("run");
    return { writes: window.__smoke.metaWrites, created: window.__smoke.created, disabled: b.disabled };
  });
  if (before.disabled) throw new Error("Compute button is disabled: " + (await page.evaluate(() => document.getElementById("run").title)));
  await clickId(page, "run");
  await page.waitForFunction((w0) => {
    const st = document.getElementById("status");
    if (st && st.querySelector('span[style*="ff6b6b"]')) return true;
    const prog = document.getElementById("progress");
    return window.__smoke.metaWrites > w0 && window.__smoke.live === 0 && !prog.classList.contains("active");
  }, before.writes, { timeout: STEP_TIMEOUT, polling: 50 });
  const errSpan = await page.evaluate(() => document.getElementById("status").querySelector('span[style*="ff6b6b"]')?.textContent || null);
  if (errSpan) throw new Error("compute failed: " + errSpan);
  const status = await page.evaluate(() => document.getElementById("status").textContent);
  await waitIdle(page);
  return { status: stripTimings(status) };
}

async function resultDigest(page, extra = {}) {
  // innerHTML with <br> turned into " | " so line boundaries survive (and the
  // timing regex sees "48 ms" as its own token).
  const meta = await page.evaluate(() => {
    const html = document.getElementById("result-meta").innerHTML.replace(/<br\s*\/?>/gi, " | ");
    const d = document.createElement("div"); d.innerHTML = html; return d.textContent;
  });
  return { resultMeta: stripTimings(meta), ...extra, map: await mapDigest(page) };
}

class SkipRest extends Error {}
let WORK;
let onPageError = null; // set while a step runs: a page error fails it at once
async function step(name, fn) {
  const t0 = Date.now();
  const entry = { name };
  try {
    const pageErr = new Promise((_, reject) => { onPageError = (e) => reject(new Error("page error: " + (e.message || e))); });
    entry.digest = await Promise.race([fn(), pageErr]);
    entry.ok = true;
  } catch (err) {
    entry.ok = false;
    entry.error = String(err && err.message || err).split("\n")[0].slice(0, 400);
    problems.push({ type: "step-failed", step: name, error: entry.error });
    STEP_TIMEOUT = DEGRADED_TIMEOUT;
  } finally {
    onPageError = null;
  }
  report.steps.push(entry);
  console.error(`[smoke] ${entry.ok ? "ok  " : "FAIL"} ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)${entry.ok ? "" : " — " + entry.error}`);
  return entry.ok;
}

async function loadApp(page, port) {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "load", timeout: STEP_TIMEOUT });
  // app.js is a module: wait until it has wired the UI (colormap options
  // populated + map captured).
  await page.waitForFunction(() => !!window.__smokeMap && document.getElementById("colormap")?.options.length > 0 &&
    document.querySelector(".leaflet-control-zoom-in"), null, { timeout: STEP_TIMEOUT });
  await waitIdle(page);
}

async function loadDem(page, demFile) {
  await page.setInputFiles("#dem-file", demFile);
  await page.waitForFunction(() => {
    const m = document.getElementById("dem-meta");
    if (document.getElementById("status").querySelector('span[style*="ff6b6b"]')) return true;
    return m && !m.hasAttribute("data-i18n") && /\d/.test(m.textContent);
  }, null, { timeout: STEP_TIMEOUT });
  const err = await page.evaluate(() => document.getElementById("status").querySelector('span[style*="ff6b6b"]')?.textContent || null);
  if (err) throw new Error("DEM load failed: " + err);
  await waitIdle(page);
}

// ---------------------------------------------------------------- groups
// Each group runs in its own fresh browser context, so groups are independent
// and the core (a–l) digests do not depend on the newer groups.
async function groupCore(browser, port, F) {
  {
    const ctx = await newContext(browser, port);
    const page = await ctx.newPage();
    wirePage(page, "main");

    // a. page load
    const loaded = await step("a.page-load", async () => {
      await loadApp(page, port);
      const ids = ["run", "dem-file", "mode", "n-dirs", "want-topn", "want-density", "string-pull", "use-wasm",
        "colormap", "download-bundle", "bundle-file", "help-btn", "lang-tag", "result-meta", "maxseg-run", "kpi-group", "map"];
      const present = await page.evaluate((ids) => ids.filter((id) => document.getElementById(id)), ids);
      const missing = ids.filter((i) => !present.includes(i));
      if (missing.length) throw new Error("missing controls: " + missing.join(","));
      return await page.evaluate(() => ({
        title: document.title,
        lang: document.documentElement.lang,
        runDisabled: document.getElementById("run").disabled,
        colormap: document.getElementById("colormap").value,
        colormapOptions: document.getElementById("colormap").options.length,
        nDirs: document.getElementById("n-dirs").value,
        useWasm: document.getElementById("use-wasm").checked,
        detailsGroups: document.querySelectorAll("details.group, details.group-parent").length,
      }));
    });
    if (!loaded) throw new SkipRest("page did not load — remaining steps skipped");

    // b. language toggle PT -> EN -> PT
    await step("b.language-toggle", async () => {
      const probe = async () => page.evaluate(() => ({
        lang: document.documentElement.lang,
        title: document.title,
        run: document.getElementById("run").textContent.trim(),
        group3: document.querySelector("#group-3 > summary").textContent.trim(),
        modeFrom: document.querySelector('#mode option[value="from"]').textContent.trim(),
        pill: document.getElementById("lang-tag").textContent.trim(),
        // every translated label/option/hint in the side panel, minus the
        // (timing-derived) run estimate — catches a STRINGS key gone missing
        panelText: (() => {
          const c = document.getElementById("panel").cloneNode(true);
          c.querySelector("#time-estimate")?.remove();
          return c.textContent.replace(/\s+/g, " ").trim();
        })(),
        titles: [...document.querySelectorAll("#panel [data-i18n-title]")].map((e) => e.title).join("\n"),
      }));
      const pt1 = await probe();
      await clickId(page, "lang-tag");
      const en = await probe();
      await clickId(page, "lang-tag");
      const pt2 = await probe();
      if (JSON.stringify(pt1) !== JSON.stringify(pt2)) throw new Error("PT labels did not come back");
      if (en.run === pt1.run || en.group3 === pt1.group3) throw new Error("EN toggle did not change labels");
      for (const o of [pt1, en]) {
        o.panelTextLen = o.panelText.length; o.panelText = sha(o.panelText);
        o.titles = sha(o.titles);
      }
      return { pt: pt1, en };
    });

    // c. DEM load
    await step("c.dem-load", async () => {
      await loadDem(page, F.dem);
      const txt = await uiText(page, ["dem-meta", "src-display", "dst-display"]);
      return { ...txt, map: await mapDigest(page) };
    });

    // d. single-source "from" field (passes are always computed since v68)
    await step("d.from-field", async () => {
      await setValue(page, "mode", "from");
      await clickCell(page, PT_SRC);
      const src = await uiText(page, ["src-display"]);
      if (!/r=60, c=50/.test(src["src-display"])) throw new Error("src not set at expected cell: " + src["src-display"]);
      const run = await runCompute(page);
      const bundle = await exportBundle(page, "d-from");
      return { ...src, ...run, ...(await resultDigest(page)), bundle: bundle.files };
    });

    await step("d.from-field-wasm-off", async () => {
      await setChecked(page, "use-wasm", false);
      const run = await runCompute(page);
      const bundle = await exportBundle(page, "d-from-js");
      await setChecked(page, "use-wasm", true);
      return { ...run, ...(await resultDigest(page)), bundle: bundle.files };
    });

    // e. "to" and "round" (passes/corridors always on)
    for (const mode of ["to", "round"]) {
      await step(`e.${mode}-field`, async () => {
        await setValue(page, "mode", mode);
        const run = await runCompute(page);
        const bundle = await exportBundle(page, "e-" + mode);
        return { ...run, ...(await resultDigest(page)), bundle: bundle.files };
      });
    }

    // f. destination path, string pulling off/on, top-N (N=3) on/off pulling
    await step("f.path-dst", async () => {
      await setValue(page, "mode", "from");
      await setChecked(page, "string-pull", false);
      await clickCell(page, PT_DST);
      const dst = await uiText(page, ["dst-display"]);
      if (!/r=130, c=190/.test(dst["dst-display"])) throw new Error("dst not set at expected cell: " + dst["dst-display"]);
      const run = await runCompute(page);
      const bundle = await exportBundle(page, "f-path");
      return { ...dst, ...run, ...(await resultDigest(page)), bundle: bundle.files };
    });
    await step("f.path-dst-stringpull", async () => {
      await setChecked(page, "string-pull", true);
      const run = await runCompute(page);
      const bundle = await exportBundle(page, "f-path-pull");
      return { ...run, ...(await resultDigest(page)), bundle: bundle.files };
    });
    for (const pull of [true, false]) {
      await step(`f.topn3-stringpull-${pull ? "on" : "off"}`, async () => {
        await setChecked(page, "want-topn", true);
        await setValue(page, "n-routes", 3);
        await setChecked(page, "string-pull", pull);
        const run = await runCompute(page);
        const bundle = await exportBundle(page, "f-topn-" + pull);
        return { ...run, ...(await resultDigest(page)), bundle: bundle.files };
      });
    }

    // g. multi-reference density: wasm on/off x move directions 16/8, with
    //    i. the accessibility KPI block after each run.
    const densityOk = await step("g.density-place-refs", async () => {
      await setChecked(page, "want-topn", false);
      await setChecked(page, "string-pull", false);
      await clickId(page, "clear-points");
      await setChecked(page, "want-density", true);
      await setValue(page, "mode", "from");
      await setValue(page, "n-refs", PT_REFS.length);
      // Pool size 1 for the hashed per-configuration density runs (their
      // digests then compare across any two trees). The 3-worker pool is
      // covered by the equivalence steps below: tolerance against the pool
      // of 1, plus bit-reproducibility of the pool of 3 itself (v83).
      await setValue(page, "max-workers", 1);
      for (const rc of PT_REFS) await clickCell(page, rc);
      const txt = await uiText(page, ["ref-display", "src-display", "dst-display"]);
      if (!new RegExp("\\b" + PT_REFS.length + "\\b").test(txt["ref-display"])) throw new Error("refs not placed: " + txt["ref-display"]);
      return { ...txt, map: await mapDigest(page) };
    });
    if (densityOk) {
      // Pool-of-3 vs pool-of-1 equivalence (wasm on/off, 16 dirs): recorded
      // as booleans + the max relative deviation bucket. Then the pool of 3
      // runs a SECOND time and must reproduce its own bytes (slot-order
      // merge, v83) — its energy/passes hashes go into the report.
      for (const wasm of [true, false]) {
        await step(`g.density-pool3-equivalence-wasm-${wasm ? "on" : "off"}`, async () => {
          await setValue(page, "n-dirs", "16");
          await setChecked(page, "use-wasm", wasm);
          await setValue(page, "max-workers", 1);
          const r1 = await runCompute(page);
          const b1 = await exportBundle(page, `pool1-${wasm}`);
          await setValue(page, "max-workers", 3);
          const created0 = await page.evaluate(() => window.__smoke.created);
          const r3 = await runCompute(page);
          const spawned = (await page.evaluate(() => window.__smoke.created)) - created0;
          const b3 = await exportBundle(page, `pool3-${wasm}`);
          const created1 = await page.evaluate(() => window.__smoke.created);
          await runCompute(page);
          const spawnedAgain = (await page.evaluate(() => window.__smoke.created)) - created1;
          const b3b = await exportBundle(page, `pool3b-${wasm}`);
          await setValue(page, "max-workers", 1);
          for (const name of ["energy.tif", "passes.tif"]) {
            const h1 = b3.files[name]?.sha256, h2 = b3b.files[name]?.sha256;
            if (!h1 || h1 !== h2) throw new Error(`${name}: two identical pool-3 runs gave different bytes (${h1} vs ${h2})`);
          }
          if (spawnedAgain < 3) throw new Error(`second pool-3 run spawned only ${spawnedAgain} worker(s)`);
          const cmp = {};
          for (const name of ["energy.tif", "passes.tif"]) cmp[name] = await compareTifs(b1.buf, b3.buf, name);
          for (const [n, c] of Object.entries(cmp)) if (!c.equivalent) throw new Error(`${n}: pool-3 deviates from pool-1 (${JSON.stringify(c)})`);
          if (spawned < 3) throw new Error(`pool-3 run spawned only ${spawned} worker(s)`);
          return {
            pool1Status: r1.status, pool3Status: r3.status, pool3SpawnedAtLeast3: true, compare: cmp,
            pool3Reproducible: true, pool3: { "energy.tif": b3.files["energy.tif"].sha256, "passes.tif": b3.files["passes.tif"].sha256 },
          };
        });
      }
      for (const [nDirs, wasm] of [["16", true], ["16", false], ["8", true], ["8", false]]) {
        await step(`g.density-ndirs${nDirs}-wasm-${wasm ? "on" : "off"}`, async () => {
          await setValue(page, "n-dirs", nDirs);
          await setChecked(page, "use-wasm", wasm);
          const run = await runCompute(page);
          const kpi = await uiText(page, ["kpi-out1", "kpi-out2", "kpi-meta", "kpi-warn"]);
          const bundle = await exportBundle(page, `g-${nDirs}-${wasm}`);
          return { ...run, ...(await resultDigest(page)), kpi, bundle: bundle.files };
        });
      }
      // i. KPI threshold edit re-evaluates the cache only (no compute).
      await step("i.kpi-threshold-edit", async () => {
        const c0 = await page.evaluate(() => window.__smoke.created);
        await setValue(page, "kpi-pop", 2000000);
        await setValue(page, "kpi-ek", 50);
        await setValue(page, "kpi-ej", 150);
        await waitIdle(page);
        const kpi = await uiText(page, ["kpi-out1", "kpi-out2", "kpi-meta", "kpi-warn"]);
        const c1 = await page.evaluate(() => window.__smoke.created);
        if (c1 !== c0) throw new Error(`KPI edit spawned ${c1 - c0} worker(s)`);
        await setValue(page, "kpi-pop", "");
        await setValue(page, "kpi-ek", 200);
        await setValue(page, "kpi-ej", 600);
        await waitIdle(page);
        return { kpi };
      });
      // j. style-only changes: overlay must change, no compute may start.
      await step("j.style-only", async () => {
        const before = await mapDigest(page);
        const c0 = await page.evaluate(() => ({ created: window.__smoke.created, writes: window.__smoke.metaWrites }));
        await setValue(page, "colormap", "CET_L8");
        await setValue(page, "passes-gamma", "0.5");
        await setValue(page, "vmax", "40");
        await clickId(page, "refresh-style");
        await waitIdle(page);
        const after = await mapDigest(page);
        const c1 = await page.evaluate(() => ({ created: window.__smoke.created, writes: window.__smoke.metaWrites }));
        if (c1.created !== c0.created) throw new Error(`style change spawned ${c1.created - c0.created} worker(s)`);
        if (c1.writes !== c0.writes) throw new Error("style change rewrote result-meta (recompute?)");
        if (JSON.stringify(before.images) === JSON.stringify(after.images)) throw new Error("overlay did not change");
        const cm = await page.evaluate(() => document.getElementById("colormap").value);
        // restore
        await setValue(page, "colormap", "cmo_phase");
        await setValue(page, "passes-gamma", "1");
        await setValue(page, "vmax", "");
        await clickId(page, "refresh-style");
        await waitIdle(page);
        const restored = await mapDigest(page);
        return { colormap: cm, styled: after, restoredEqualsBefore: JSON.stringify(restored.images) === JSON.stringify(before.images) };
      });
      // i. max-density segment (3C.c) on the last density result.
      await step("i.maxseg", async () => {
        const w0 = await page.evaluate(() => window.__smoke.maxsegWrites);
        await setValue(page, "maxseg-len", "3");
        await setValue(page, "maxseg-nseg", "2");
        await clickId(page, "maxseg-run");
        await page.waitForFunction((w0) => {
          const el = document.getElementById("maxseg-meta");
          return window.__smoke.maxsegWrites > w0 && window.__smoke.live === 0 && !/%/.test(el.textContent);
        }, w0, { timeout: STEP_TIMEOUT, polling: 50 });
        await waitIdle(page);
        return { ...(await uiText(page, ["maxseg-meta"])), map: await mapDigest(page) };
      });
    }

    // k. help modal + changelog
    await step("k.help-changelog", async () => {
      await clickId(page, "help-btn");
      await page.waitForFunction(() => document.getElementById("help-modal").classList.contains("active"), null, { timeout: STEP_TIMEOUT });
      await page.evaluate(() => document.querySelector("#changelog > summary").click());
      // Entries may be static HTML or fetched lazily on first open (a
      // "loading…" placeholder <p> first): wait until the first <p> is a
      // version entry ("vNN — …"), which only real entries are.
      await page.waitForFunction(() => {
        const d = document.getElementById("changelog");
        const p0 = d && d.querySelector("p");
        return d.open && !!p0 && /^\s*v\d+/.test(p0.textContent);
      }, null, { timeout: STEP_TIMEOUT });
      const cl = await page.evaluate(() => {
        const ps = [...document.querySelectorAll("#changelog p")];
        const norm = (p) => p.textContent.replace(/\s+/g, " ").trim();
        return { entries: ps.length, versionEntries: ps.filter((p) => /^v\d+/.test(norm(p))).length,
          first80: norm(ps[0]).slice(0, 80), allSha: ps.map(norm).join("\n") };
      });
      cl.allSha = sha(cl.allSha);
      cl.helpTextSha = sha(await page.evaluate(() => {
        const c = document.getElementById("help-modal").cloneNode(true);
        c.querySelector("#changelog")?.remove();
        return c.textContent.replace(/\s+/g, " ").trim();
      }));
      await clickId(page, "help-close");
      return cl;
    });

    // l. bundle export (density, wasm off, nDirs 8 = last run) + re-import into a fresh context.
    let lastBundle = null;
    await step("l.bundle-export", async () => {
      lastBundle = await exportBundle(page, "l-final");
      const md = JSON.parse((await (await JSZip.loadAsync(lastBundle.buf)).file("metadata.jsonld").async("string")));
      const volatilePresent = Object.keys(md).filter((k) => VOLATILE_MD_KEYS.has(k)).sort();
      return { files: lastBundle.files, volatileKeysStripped: volatilePresent };
    });
    if (lastBundle) {
      await step("l.bundle-import-fresh-page", async () => {
        const ctx2 = await newContext(browser, port);
        try {
          const p2 = await ctx2.newPage();
          wirePage(p2, "import");
          await loadApp(p2, port);
          await loadDem(p2, F.dem);
          const w0 = await p2.evaluate(() => window.__smoke.metaWrites);
          await p2.setInputFiles("#bundle-file", lastBundle.file);
          await p2.waitForFunction((w0) => window.__smoke.metaWrites > w0 || !!document.getElementById("status").querySelector('span[style*="ff6b6b"]'),
            w0, { timeout: STEP_TIMEOUT, polling: 50 });
          const err = await p2.evaluate(() => document.getElementById("status").querySelector('span[style*="ff6b6b"]')?.textContent || null);
          if (err) throw new Error("import failed: " + err);
          await waitIdle(p2);
          const ui = await p2.evaluate(() => ({
            mode: document.getElementById("mode").value,
            nDirs: document.getElementById("n-dirs").value,
            wantDensity: document.getElementById("want-density").checked,
            useWasm: document.getElementById("use-wasm").checked,
            colormap: document.getElementById("colormap").value,
            refDisplay: document.getElementById("ref-display").textContent.trim(),
          }));
          const d = await resultDigest(p2, { ui, status: stripTimings(await p2.evaluate(() => document.getElementById("status").textContent)) });
          // re-export from the imported state: the raw rasters must round-trip.
          const re = await exportBundle(p2, "l-reexport");
          const same = {};
          for (const [n, f] of Object.entries(lastBundle.files)) same[n] = re.files[n] ? re.files[n].sha256 === f.sha256 : "missing";
          d.reexport = { files: re.files, sameAsExported: same };
          await p2.close();
          return d;
        } finally {
          await ctx2.close();
        }
      });
    }

    // Worker scripts the app spawned (unique, sorted) — a renamed/moved worker
    // file shows up here.
    report.workerScripts = [...new Set(await page.evaluate(() => window.__smoke.workerUrls).catch(() => ["<page gone>"]))].sort();
  }
}

// ---------------------------------------------------------------- helpers for groups m–s
async function freshPage(browser, port, label, opts = {}) {
  const ctx = await newContext(browser, port, opts);
  const page = await ctx.newPage();
  wirePage(page, label);
  return { ctx, page };
}

// Group prologue: fresh page with the app loaded (and the DEM, unless noDem).
// Recorded as a step so a load failure is reported in the right group.
async function openGroup(browser, port, F, label, opts = {}) {
  const g = await freshPage(browser, port, label, opts);
  const ok = await step(`${label}.open`, async () => {
    await loadApp(g.page, port);
    if (!opts.noDem) await loadDem(g.page, F.dem);
    return { demMeta: opts.noDem ? null : (await uiText(g.page, ["dem-meta"]))["dem-meta"] };
  });
  if (!ok) { await g.ctx.close(); throw new SkipRest(`${label}: app/DEM did not load — group skipped`); }
  return g;
}

// Graph-mode computes write no #result-meta; they finish on the
// "status.graph_done" line, "(grafo: N nós, M arestas)" / "(graph: …)".
async function runGraphCompute(page) {
  await waitIdle(page);
  const w0 = await page.evaluate(() => {
    if (document.getElementById("run").disabled) throw new Error("Compute button is disabled: " + document.getElementById("run").title);
    return window.__smoke.statusWrites;
  });
  await clickId(page, "run");
  await page.waitForFunction((w0) => {
    const st = document.getElementById("status");
    if (st.querySelector('span[style*="ff6b6b"]')) return true;
    return window.__smoke.statusWrites > w0 && /\((grafo|graph): \d+/.test(st.textContent) &&
      window.__smoke.live === 0 && !document.getElementById("progress").classList.contains("active");
  }, w0, { timeout: STEP_TIMEOUT, polling: 50 });
  const err = await page.evaluate(() => document.getElementById("status").querySelector('span[style*="ff6b6b"]')?.textContent || null);
  if (err) throw new Error("graph compute failed: " + err);
  const status = await page.evaluate(() => document.getElementById("status").textContent);
  await waitIdle(page);
  return { status: stripTimings(status) };
}

// Map point (viewport px) of a DEM cell centre, or of an arbitrary lat/lng.
async function cellPoint(page, [r, c]) {
  const [lat, lng] = cellLL(r, c);
  return await page.evaluate(([lat, lng]) => {
    const m = window.__smokeMap;
    const p = m.latLngToContainerPoint([lat, lng]);
    const rect = m.getContainer().getBoundingClientRect();
    return { x: rect.left + p.x, y: rect.top + p.y };
  }, [lat, lng]);
}
// Raw real click (no hit check) — for Geoman vertex markers.
async function rawClickCell(page, rc) {
  const pt = await cellPoint(page, rc);
  await page.mouse.move(pt.x, pt.y, { steps: 4 });
  await page.mouse.click(pt.x, pt.y);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
}
// Finish a Geoman shape the way a user does: a real click ON a vertex marker
// (Line: any vertex; Polygon: the first). Aim at the marker's own DOM icon and
// verify nothing (hint marker, its tooltip) covers it, then wait until Geoman
// has left draw mode.
async function finishOnVertex(page, shape, idx) {
  const pt = await page.evaluate(([shape, idx]) => {
    const mk = window.__smokeMap.pm.Draw[shape]._markers;
    const el = mk[idx < 0 ? mk.length + idx : idx]._icon;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, [shape, idx]);
  await page.mouse.move(pt.x + 30, pt.y + 30, { steps: 3 });
  await page.mouse.move(pt.x, pt.y, { steps: 3 });
  const hit = await page.evaluate(([shape, idx, x, y]) => {
    const mk = window.__smokeMap.pm.Draw[shape]._markers;
    const el = mk[idx < 0 ? mk.length + idx : idx]._icon;
    const h = document.elementFromPoint(x, y);
    return h === el || el.contains(h) ? null : (h ? h.tagName + "." + h.className : "nothing");
  }, [shape, idx, pt.x, pt.y]);
  if (hit) throw new Error(`Geoman ${shape}: vertex marker covered by ${hit}`);
  await page.mouse.click(pt.x, pt.y);
  await page.waitForFunction(() => !window.__smokeMap.pm.globalDrawModeEnabled(), null, { timeout: STEP_TIMEOUT });
}
// Place one Geoman vertex with a real click and wait until the working shape
// has n vertices (a lost click fails here, not as a wrong shape later).
//
// Geoman puts the new vertex at its HINT MARKER, not at the click. The marker
// follows mousemove through a THROTTLED handler (and snaps onto nearby
// geometry), so the last move of a quick gesture can be dropped and the marker
// left at an earlier pointer position — e.g. snapped to the edge of the wall
// the portal line crosses. The vertex then lands there, ~1 run in 10, and
// every digest after it differs. So: keep nudging the pointer (one frame
// apart, so a move falls outside the throttle window) until the hint marker
// is under it, click, and then check where the vertex actually went.
async function placeVertex(page, shape, rc, n) {
  const pt = await cellPoint(page, rc);
  const hintOffset = () => page.evaluate(([shape, x, y]) => {
    const map = window.__smokeMap, hint = map.pm.Draw[shape]?._hintMarker;
    if (!hint) return null;
    const p = map.latLngToContainerPoint(hint.getLatLng()), box = map.getContainer().getBoundingClientRect();
    return Math.hypot(p.x + box.left - x, p.y + box.top - y);
  }, [shape, pt.x, pt.y]);
  await page.mouse.move(pt.x, pt.y, { steps: 4 });
  let off = await hintOffset();
  const frames = (k) => page.evaluate((k) => new Promise((done) => { const tick = () => (--k <= 0 ? done() : requestAnimationFrame(tick)); requestAnimationFrame(tick); }), k);
  for (let tries = 0; off !== null && off > 1.5 && tries < 40; tries++) {
    await page.mouse.move(pt.x + 3, pt.y + 3);
    await frames(3);                       // let the throttle window pass…
    await page.mouse.move(pt.x, pt.y);     // …so THIS move is the one handled
    await frames(1);
    off = await hintOffset();
  }
  if (off === null || off > 1.5) throw new Error(`Geoman ${shape}: hint marker is ${off === null ? "missing" : off.toFixed(1) + " px from the pointer"} at cell ${rc} (snapped to a nearby shape?)`);
  await page.mouse.click(pt.x, pt.y);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
  await page.waitForFunction(([shape, n]) => {
    const l = window.__smokeMap.pm.Draw[shape]?._layer;
    const ll = l && l.getLatLngs();
    return !!ll && ll.length === n;
  }, [shape, n], { timeout: STEP_TIMEOUT }).catch(async () => {
    const got = await page.evaluate((shape) => window.__smokeMap.pm.Draw[shape]?._layer?.getLatLngs().length ?? null, shape);
    throw new Error(`Geoman ${shape}: expected ${n} vertices after clicking cell ${rc}, have ${got}`);
  });
  const placed = await page.evaluate(([shape, n, x, y]) => {
    const map = window.__smokeMap, ll = map.pm.Draw[shape]._layer.getLatLngs()[n - 1];
    const p = map.latLngToContainerPoint(ll), box = map.getContainer().getBoundingClientRect();
    return Math.hypot(p.x + box.left - x, p.y + box.top - y);
  }, [shape, n, pt.x, pt.y]);
  if (placed > 1.5) throw new Error(`Geoman ${shape}: vertex ${n} landed ${placed.toFixed(1)} px from the click at cell ${rc}`);
}

// Capture one download triggered by clicking #id.
async function downloadFrom(page, id) {
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: STEP_TIMEOUT }), clickId(page, id)]);
  return { name: dl.suggestedFilename(), buf: fs.readFileSync(await dl.path()) };
}

// Every input/select in the side panel + the hidden layer-control store
// (id → value/checked), plus language. File inputs excluded.
async function panelState(page) {
  return await page.evaluate(() => {
    const o = { __lang: document.documentElement.lang };
    for (const el of document.querySelectorAll("#panel input[id], #panel select[id], #layer-inputs-store input[id], #layer-inputs-store select[id]")) {
      if (el.type === "file") continue;
      o[el.id] = (el.type === "checkbox" || el.type === "radio") ? el.checked : el.value;
    }
    return o;
  });
}
const stateSha = (o) => sha(JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]])));
function stateDiff(a, b) {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]).sort();
}

async function readTifFromZip(zipBuf, name) {
  const f = (await JSZip.loadAsync(zipBuf)).file(name);
  if (!f) return null;
  return await readTif(await f.async("nodebuffer"));
}
async function readTif(buf) {
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const img = await (await fromArrayBuffer(ab)).getImage();
  return (await img.readRasters())[0];
}
// Count non-finite cells of a raster inside the inclusive cell box.
function nonFiniteIn(arr, r0, r1, c0, c1) {
  let n = 0, tot = 0;
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) { tot++; if (!Number.isFinite(arr[r * DEM.W + c])) n++; }
  return { nonFinite: n, cells: tot };
}
function countNonFinite(arr) { let n = 0; for (const v of arr) if (!Number.isFinite(v)) n++; return n; }

// Wait until #id's text matches `re` (and not `notRe`). Regexes, not
// functions: the app's CSP forbids eval, so predicates can't be shipped as text.
async function waitText(page, id, re, what, notRe = null) {
  await page.waitForFunction(([id, src, flags, nsrc]) => {
    const el = document.getElementById(id);
    if (!el) return false;
    const t = el.textContent;
    return new RegExp(src, flags).test(t) && !(nsrc && new RegExp(nsrc).test(t));
  }, [id, re.source, re.flags, notRe ? notRe.source : null], { timeout: STEP_TIMEOUT, polling: 50 }).catch(async (e) => {
    throw new Error(`waiting for #${id} (${what}) failed: "${(await uiText(page, [id]))[id]}" — ${String(e.message).split("\n")[0]}`);
  });
}

async function singleDigest(page, tag, { compact = false } = {}) {
  const bundle = await exportBundle(page, tag);
  const meta = await page.evaluate(() => {
    const html = document.getElementById("result-meta").innerHTML.replace(/<br\s*\/?>/gi, " | ");
    const d = document.createElement("div"); d.innerHTML = html; return d.textContent;
  });
  return { resultMeta: stripTimings(meta), map: await mapDigest(page, { compact }), bundle: bundle.files, _buf: bundle.buf };
}
const drop = (o, ...keys) => { const r = { ...o }; for (const k of keys) delete r[k]; return r; };

const NET_SRC = [60, 50];          // snaps onto the network
const NET_DST = [130, 190];
const NET_REFS = [[40, 45], [50, 195], [90, 95], [160, 50], [165, 195], [130, 140]];

// (Re)place source + destination. Toggling density mode drops src/dst, so the
// first click after it sets the SOURCE; verify both displays.
async function setSrcDst(page, src, dst) {
  for (const rc of [src, dst]) await clickCell(page, rc);
  const t = await uiText(page, ["src-display", "dst-display"]);
  if (!/^r=\d+, c=\d+$/.test(t["src-display"]) || !/^r=\d+, c=\d+$/.test(t["dst-display"])) {
    throw new Error(`src/dst not set: ${t["src-display"]} / ${t["dst-display"]}`);
  }
}

async function loadNetwork(page, file) {
  const w0 = await page.evaluate(() => document.getElementById("vec-meta").textContent);
  await page.setInputFiles("#vector-file", file);
  await page.waitForFunction((w0) => {
    const m = document.getElementById("vec-meta");
    return (m.textContent !== w0 && /EPSG:/.test(m.textContent)) || !!document.getElementById("status").querySelector('span[style*="ff6b6b"]');
  }, w0, { timeout: STEP_TIMEOUT, polling: 50 });
  const err = await page.evaluate(() => document.getElementById("status").querySelector('span[style*="ff6b6b"]')?.textContent || null);
  if (err) throw new Error("network load failed: " + err);
  await waitIdle(page);
}

// ---------------------------------------------------------------- m. raster network (GeoPackage)
async function groupNet(browser, port, F) {
  const { ctx, page } = await openGroup(browser, port, F, "m.net");
  try {
    await step("m.net-load-gpkg", async () => {
      await setChecked(page, "vec-render", true);
      await loadNetwork(page, F.gpkg);
      return { ...(await uiText(page, ["vec-meta", "status"])),
        bridgeFromNetworkEnabled: await page.evaluate(() => !document.getElementById("bridge-from-network").disabled),
        map: await mapDigest(page, { compact: true }) };
    });
    await step("m.net-from-nointerp", async () => {
      await setValue(page, "mode", "from");
      await setChecked(page, "net-interp", false);
      await clickCell(page, NET_SRC);
      const src = (await uiText(page, ["src-display"]))["src-display"];
      if (!/^r=\d+, c=\d+$/.test(src)) throw new Error("src not set: " + src);
      const run = await runCompute(page);
      const d = await singleDigest(page, "m-from");
      const e = await readTifFromZip(d._buf, "energy.tif");
      return { src, ...run, ...drop(d, "_buf"), unreachableCells: countNonFinite(e) };
    });
    await step("m.net-from-interp", async () => {
      await setChecked(page, "net-interp", true);
      const run = await runCompute(page);
      const d = await singleDigest(page, "m-from-interp");
      const e = await readTifFromZip(d._buf, "energy.tif");
      const n = countNonFinite(e);
      // IDW fills off-network cells within the max distance: far fewer gaps.
      return { ...run, ...drop(d, "_buf"), unreachableCells: n };
    });
    await step("m.net-density", async () => {
      await setChecked(page, "want-density", true);
      await setValue(page, "max-workers", 1);
      await setValue(page, "n-refs", NET_REFS.length);
      for (const rc of NET_REFS) await clickCell(page, rc);
      const refs = (await uiText(page, ["ref-display"]))["ref-display"];
      const run = await runCompute(page);
      const kpi = await uiText(page, ["kpi-out1", "kpi-out2", "kpi-meta", "kpi-warn"]);
      return { refs, ...run, kpi, ...drop(await singleDigest(page, "m-density"), "_buf") };
    });
    await step("m.net-path", async () => {
      await setChecked(page, "want-density", false);
      await setSrcDst(page, NET_SRC, NET_DST);
      const dst = (await uiText(page, ["dst-display"]))["dst-display"];
      const run = await runCompute(page);
      return { dst, ...run, ...drop(await singleDigest(page, "m-path"), "_buf") };
    });
    await step("m.net-topn3", async () => {
      await setChecked(page, "want-topn", true);
      await setValue(page, "n-routes", 3);
      const run = await runCompute(page);
      const d = drop(await singleDigest(page, "m-topn"), "_buf");
      await setChecked(page, "want-topn", false);
      return { ...run, ...d };
    });
    await step("m.net-compare-difference", async () => {
      await setChecked(page, "vec-compare", true);
      const run = await runCompute(page);
      const d = drop(await singleDigest(page, "m-compare"), "_buf");
      if (!d.bundle["energy_difference.tif"] || !d.bundle["energy_unconstrained.tif"]) throw new Error("compare bundle lacks the unconstrained/difference rasters");
      // The displayed-scenario picker is a style switch: re-render, never recompute.
      const views = {};
      const c0 = await page.evaluate(() => window.__smoke.created);
      for (const v of ["unconstrained", "difference", "constrained"]) {
        await setValue(page, "energy-source", v);
        await waitIdle(page);
        views[v] = (await mapDigest(page, { compact: true })).images;
      }
      const c1 = await page.evaluate(() => window.__smoke.created);
      if (c1 !== c0) throw new Error(`scenario picker spawned ${c1 - c0} worker(s)`);
      if (JSON.stringify(views.unconstrained) === JSON.stringify(views.difference)) throw new Error("difference view identical to unconstrained");
      await setChecked(page, "vec-compare", false);
      return { ...run, ...d, views };
    });
    await step("m.net-bridges-from-network", async () => {
      const m0 = (await uiText(page, ["bridge-meta"]))["bridge-meta"];
      await clickId(page, "bridge-from-network");
      await waitText(page, "bridge-meta", /\d/, "bridge count");
      const meta = (await uiText(page, ["bridge-meta"]))["bridge-meta"];
      if (meta === m0) throw new Error("bridge meta unchanged");
      const run = await runCompute(page);
      return { bridgeMeta: meta, ...run, ...drop(await singleDigest(page, "m-bridges"), "_buf") };
    });
    await step("m.net-clear", async () => {
      await clickId(page, "vec-clear");
      await waitIdle(page);
      return { ...(await uiText(page, ["vec-meta", "bridge-meta"])), map: await mapDigest(page, { compact: true }) };
    });
  } finally {
    await ctx.close();
  }
}

// ---------------------------------------------------------------- n. graph mode
async function groupGraph(browser, port, F) {
  const { ctx, page } = await openGroup(browser, port, F, "n.graph");
  const g = async (tag) => {
    const run = await runGraphCompute(page);
    const d = await singleDigest(page, tag, { compact: true });
    if (!d.bundle["graph_edges.geojson"]) throw new Error("graph bundle has no graph_edges.geojson");
    return { ...run, ...drop(d, "_buf", "resultMeta") };
  };
  try {
    await step("n.graph-enable", async () => {
      await loadNetwork(page, F.gpkg);
      await setChecked(page, "vec-graph-mode", true);
      const ui = await page.evaluate(() => ({
        constrainChecked: document.getElementById("vec-constrain").checked,
        constrainLocked: document.getElementById("vec-constrain").disabled,
      }));
      if (!ui.constrainChecked || !ui.constrainLocked) throw new Error("graph mode did not lock 'constrain' on");
      return ui;
    });
    await step("n.graph-from", async () => {
      await setValue(page, "mode", "from");
      await clickCell(page, NET_SRC);
      return { src: (await uiText(page, ["src-display"]))["src-display"], ...(await g("n-from")) };
    });
    for (const mode of ["to", "round"]) {
      await step(`n.graph-${mode}`, async () => { await setValue(page, "mode", mode); return await g("n-" + mode); });
    }
    await step("n.graph-density", async () => {
      await setValue(page, "mode", "from");
      await setChecked(page, "want-density", true);
      await setValue(page, "n-refs", NET_REFS.length);
      for (const rc of NET_REFS) await clickCell(page, rc);
      return { refs: (await uiText(page, ["ref-display"]))["ref-display"], ...(await g("n-density")) };
    });
    await step("n.graph-path", async () => {
      await setChecked(page, "want-density", false);
      await setSrcDst(page, NET_SRC, NET_DST);
      return { dst: (await uiText(page, ["dst-display"]))["dst-display"], ...(await g("n-path")) };
    });
    await step("n.graph-topn3", async () => {
      await setChecked(page, "want-topn", true);
      await setValue(page, "n-routes", 3);
      return await g("n-topn");
    });
  } finally {
    await ctx.close();
  }
}

// ---------------------------------------------------------------- o. drawing tools (Leaflet-Geoman)
// A north-south wall (barrier) rows 20..180 x cols 100..110 between a western
// source and the east; a drawn portal bridge spans it at row 100. Vertices are
// kept > 20 px apart (~3.2 px per cell here): Geoman snaps a click within its
// 20 px snapDistance onto an existing vertex/layer, which silently eats it.
const DRAW_SRC = [100, 20];
const WALL = { r0: 20, r1: 180, c0: 100, c1: 110 };
const PORTAL = [[100, 86], [100, 124]];
const PROBE_EAST = [100, 126];       // a cell just east of the wall / portal end
async function groupDraw(browser, port, F) {
  const { ctx, page } = await openGroup(browser, port, F, "o.draw");
  const fromRun = async (tag) => {
    const run = await runCompute(page);
    const d = await singleDigest(page, tag);
    const e = await readTifFromZip(d._buf, "energy.tif");
    return { run, d, e };
  };
  let base = null;
  try {
    await step("o.draw-baseline", async () => {
      await setValue(page, "mode", "from");
      await clickCell(page, DRAW_SRC);
      base = await fromRun("o-base");
      return { ...base.run, ...drop(base.d, "_buf"), probeEastKJ: base.e[PROBE_EAST[0] * DEM.W + PROBE_EAST[1]] };
    });
    let wallE = null;
    await step("o.draw-barrier", async () => {
      const m0 = (await uiText(page, ["draw-impassable-meta"]))["draw-impassable-meta"];
      await clickId(page, "draw-barrier");
      await page.waitForFunction(() => window.__smokeMap.pm && window.__smokeMap.pm.globalDrawModeEnabled(), null, { timeout: STEP_TIMEOUT });
      const corners = [[WALL.r0, WALL.c0], [WALL.r0, WALL.c1], [WALL.r1, WALL.c1], [WALL.r1, WALL.c0]];
      for (let i = 0; i < corners.length; i++) await placeVertex(page, "Polygon", corners[i], i + 1);
      await finishOnVertex(page, "Polygon", 0);        // click the first vertex = finish
      await waitText(page, "draw-impassable-meta", /\b1\b/, "1 barrier");
      const meta = (await uiText(page, ["draw-impassable-meta"]))["draw-impassable-meta"];
      if (meta === m0) throw new Error("barrier not registered");
      const r = await fromRun("o-barrier");
      wallE = r.e;
      // every cell strictly inside the drawn wall must be unreachable
      const inside = nonFiniteIn(r.e, WALL.r0 + 2, WALL.r1 - 2, WALL.c0 + 1, WALL.c1 - 1);
      if (inside.nonFinite !== inside.cells) throw new Error(`barrier: ${inside.cells - inside.nonFinite} interior cell(s) still reachable`);
      const east = r.e[PROBE_EAST[0] * DEM.W + PROBE_EAST[1]];
      if (!(east > base.e[PROBE_EAST[0] * DEM.W + PROBE_EAST[1]])) throw new Error("barrier did not make the east side costlier");
      return { meta, ...r.run, ...drop(r.d, "_buf"), interior: inside, unreachableCells: countNonFinite(r.e), probeEastKJ: east };
    });
    await step("o.draw-portal", async () => {
      await clickId(page, "draw-portal");
      await page.waitForFunction(() => window.__smokeMap.pm && window.__smokeMap.pm.globalDrawModeEnabled(), null, { timeout: STEP_TIMEOUT });
      await placeVertex(page, "Line", PORTAL[0], 1);
      await placeVertex(page, "Line", PORTAL[1], 2);
      await finishOnVertex(page, "Line", -1);          // click the last vertex = finish
      await waitText(page, "draw-portal-meta", /\b1\b/, "1 portal");
      const r = await fromRun("o-portal");
      const east = r.e[PROBE_EAST[0] * DEM.W + PROBE_EAST[1]];
      if (!(east < wallE[PROBE_EAST[0] * DEM.W + PROBE_EAST[1]])) throw new Error("portal not used: east side not cheaper than with the wall alone");
      return { meta: (await uiText(page, ["draw-portal-meta"]))["draw-portal-meta"], ...r.run, ...drop(r.d, "_buf"), probeEastKJ: east };
    });
    await step("o.draw-clear-restores", async () => {
      await clickId(page, "draw-impassable-clear");
      await clickId(page, "draw-portal-clear");
      await waitIdle(page);
      const r = await fromRun("o-cleared");
      const same = {};
      for (const n of ["energy.tif", "passes.tif"]) same[n] = r.d.bundle[n]?.sha256 === base.d.bundle[n]?.sha256;
      same.overlays = JSON.stringify(r.d.map.images) === JSON.stringify(base.d.map.images);
      for (const [k, v] of Object.entries(same)) if (!v) throw new Error(`after clearing, ${k} differs from the undrawn baseline`);
      return { meta: await uiText(page, ["draw-impassable-meta", "draw-portal-meta"]), sameAsBaseline: same };
    });
  } finally {
    await ctx.close();
  }
}

// ---------------------------------------------------------------- p. config export / reset / import
async function groupConfig(browser, port, F) {
  const { ctx, page } = await openGroup(browser, port, F, "p.config", { noDem: true });
  try {
    let before = null, cfg = null;
    await step("p.config-change-export", async () => {
      const defaults = await panelState(page);
      for (const [id, v] of [["mass", 82], ["crr", "0.006"], ["n-dirs", "32"], ["e-max", 120], ["n-routes", 4],
        ["passes-gamma", "0.7"], ["vec-width", 2], ["net-interp-max-dist", 30], ["colormap", "CET_L8"], ["mode", "round"]]) await setValue(page, id, v);
      await setChecked(page, "want-topn", true);
      await setChecked(page, "string-pull", true);
      await setChecked(page, "use-wasm", false);
      await clickId(page, "lang-tag");                  // -> EN
      before = await panelState(page);
      const changed = stateDiff(defaults, before);
      const dl = await downloadFrom(page, "config-export");
      cfg = dl;
      const json = JSON.parse(dl.buf.toString("utf8"));
      return { file: dl.name, sha256: sha(dl.buf), keys: Object.keys(json).sort(), lang: json.lang,
        changedControls: changed, panelSha: stateSha(before) };
    });
    await step("p.config-reset", async () => {
      page.once("dialog", (d) => d.accept());
      await Promise.all([page.waitForEvent("load", { timeout: STEP_TIMEOUT }), clickId(page, "config-reset")]);
      await page.waitForFunction(() => !!window.__smokeMap && document.getElementById("colormap")?.options.length > 0, null, { timeout: STEP_TIMEOUT });
      await waitIdle(page);
      const after = await panelState(page);
      const diff = stateDiff(before, after);
      if (!diff.length) throw new Error("reset changed nothing");
      return { panelSha: stateSha(after), differsFromChanged: diff };
    });
    await step("p.config-import", async () => {
      const f = path.join(WORK, "config.json");
      fs.writeFileSync(f, cfg.buf);
      const w0 = await page.evaluate(() => window.__smoke.statusWrites);
      await page.setInputFiles("#config-file", f);
      await page.waitForFunction((w0) => window.__smoke.statusWrites > w0, w0, { timeout: STEP_TIMEOUT });
      await waitIdle(page);
      const st = (await uiText(page, ["status"])).status;
      const after = await panelState(page);
      // Compare exactly what the config file carries (its params keys + the
      // language); controls the app does not export are listed, not failed.
      const carried = Object.keys(JSON.parse(cfg.buf.toString("utf8")).params || {});
      const diff = stateDiff(before, after).filter((k) => carried.includes(k) || k === "__lang");
      if (diff.length) throw new Error("imported config differs from the exported state in: " + diff.join(", "));
      const notCarried = stateDiff(before, after).filter((k) => !carried.includes(k) && k !== "__lang");
      return { status: st, carriedControls: carried.length, panelShaCarried: stateSha(Object.fromEntries(carried.map((k) => [k, after[k]]))), changedButNotInConfig: notCarried };
    });
  } finally {
    await ctx.close();
  }
}

// ---------------------------------------------------------------- q. reference geometry (GPX)
async function groupRefgeom(browser, port, F) {
  const { ctx, page } = await openGroup(browser, port, F, "q.refgeom");
  // Hover the middle of the track's 2nd segment; read the sticky tooltip.
  const hoverMetrics = async () => {
    await page.mouse.move(5, 450);                                  // leave the line (closes the tooltip)
    await page.waitForFunction(() => !document.querySelector(".leaflet-tooltip-pane .leaflet-tooltip"), null, { timeout: STEP_TIMEOUT });
    const [a, b] = [fx.GPX_CELLS[1], fx.GPX_CELLS[2]];
    const p = await cellPoint(page, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
    await page.mouse.move(p.x - 3, p.y);
    await page.mouse.move(p.x, p.y);
    await page.waitForSelector(".leaflet-tooltip-pane .leaflet-tooltip", { timeout: STEP_TIMEOUT });
    return await page.evaluate(() => {
      const el = document.querySelector(".leaflet-tooltip-pane .leaflet-tooltip");
      const d = document.createElement("div"); d.innerHTML = el.innerHTML.replace(/<br\s*\/?>/gi, " | ");
      return d.textContent.replace(/\s+/g, " ").trim();
    });
  };
  const load = async (file) => {
    const w0 = await page.evaluate(() => window.__smoke.statusWrites);
    await page.setInputFiles("#refgeom-file", file);
    await page.waitForFunction((w0) => window.__smoke.statusWrites > w0 && /km/.test(document.getElementById("status").textContent) ||
      !!document.getElementById("status").querySelector('span[style*="ff6b6b"]'), w0, { timeout: STEP_TIMEOUT });
    const err = await page.evaluate(() => document.getElementById("status").querySelector('span[style*="ff6b6b"]')?.textContent || null);
    if (err) throw new Error("GPX load failed: " + err);
    await waitIdle(page);
    return (await uiText(page, ["status"])).status;
  };
  try {
    let m1 = null;
    await step("q.gpx-with-ele", async () => {
      const st = await load(F.gpxEle);
      m1 = await hoverMetrics();
      if (!/kJ/.test(m1)) throw new Error("no energy in metrics: " + m1);
      return { status: st, metrics: m1, map: await mapDigest(page, { compact: true }) };
    });
    await step("q.gpx-mass-change", async () => {
      await setValue(page, "mass", 95);
      const m2 = await hoverMetrics();
      if (m2 === m1) throw new Error("energy did not follow the mass change");
      await setValue(page, "mass", 75);
      const m3 = await hoverMetrics();
      if (m3 !== m1) throw new Error("energy did not return with mass 75: " + m3);
      return { metricsMass95: m2 };
    });
    await step("q.gpx-dem-sampled", async () => {
      const st = await load(F.gpxNoEle);
      const m = await hoverMetrics();
      return { status: st, metrics: m, map: await mapDigest(page, { compact: true }) };
    });
  } finally {
    await ctx.close();
  }
}

// ---------------------------------------------------------------- r. impassable mask + dataset export/import
const MASK_SRC = [60, 50];
async function groupMask(browser, port, F) {
  const { ctx, page } = await openGroup(browser, port, F, "r.mask");
  const exported = {};
  let fullBundle = null;
  try {
    await step("r.mask-load", async () => {
      await page.setInputFiles("#impassable-file", F.mask);
      await waitText(page, "imp-meta", /river-mask\.tif/, "mask meta", /Reading/);
      await waitIdle(page);
      return { ...(await uiText(page, ["imp-meta"])) };
    });
    await step("r.mask-from", async () => {
      await setValue(page, "mode", "from");
      await clickCell(page, MASK_SRC);
      const run = await runCompute(page);
      const d = await singleDigest(page, "r-mask");
      const e = await readTifFromZip(d._buf, "energy.tif");
      const B = fx.MASK_BAND;
      const band = nonFiniteIn(e, B.r0, B.r1, 0, B.cGap - 1);
      if (band.nonFinite !== band.cells) throw new Error(`mask band: ${band.cells - band.nonFinite} cell(s) reachable`);
      const ford = nonFiniteIn(e, B.r0, B.r1, B.cGap + 1, DEM.W - 2);
      if (ford.nonFinite) throw new Error("the ford (gap in the mask) is unreachable");
      if (!d.bundle["impassable.tif"]) throw new Error("bundle lacks impassable.tif");
      return { ...run, ...drop(d, "_buf"), band, fordUnreachable: ford.nonFinite };
    });
    await step("r.full-inputs-from", async () => {
      await loadNetwork(page, F.gpkg);
      await clickId(page, "bridge-from-network");
      await waitText(page, "bridge-meta", /\d/, "bridges");
      const run = await runCompute(page);
      const d = await singleDigest(page, "r-full");
      fullBundle = d;
      return { ...(await uiText(page, ["vec-meta", "imp-meta", "bridge-meta"])), ...run, ...drop(d, "_buf") };
    });
    await step("r.dataset-exports", async () => {
      const out = {};
      for (const [id, key] of [["export-dem", "dem"], ["export-network", "network"], ["export-mask", "mask"], ["export-bridges", "bridges"]]) {
        const dl = await downloadFrom(page, id);
        const f = path.join(WORK, "export-" + dl.name);
        fs.writeFileSync(f, dl.buf);
        exported[key] = f;
        // .gpkg carries a wall-clock gpkg_contents.last_change: hash the rows.
        out[key] = /\.gpkg$/i.test(dl.name)
          ? { file: dl.name.replace(/\d{4}-\d\d-\d\dT[\d-]+Z?/g, "<ts>"), featuresSha256: sha(JSON.stringify(await fx.gpkgFeatureDump(dl.buf))) }
          : { file: dl.name.replace(/\d{4}-\d\d-\d\dT[\d-]+Z?/g, "<ts>"), sha256: sha(dl.buf) };
      }
      return out;
    });
  } finally {
    await ctx.close();
  }
  if (!fullBundle || Object.keys(exported).length !== 4) return;
  // Re-import the four exported datasets through group 0's import buttons into
  // a FRESH page; the same compute must reproduce the same rasters.
  const g2 = await freshPage(browser, port, "r.reimport");
  try {
    await step("r.dataset-reimport", async () => {
      const p = g2.page;
      await loadApp(p, port);
      await p.setInputFiles("#io-dem-file", exported.dem);
      await p.waitForFunction(() => !document.getElementById("dem-meta").hasAttribute("data-i18n"), null, { timeout: STEP_TIMEOUT });
      await waitIdle(p);
      const w0 = await p.evaluate(() => document.getElementById("vec-meta").textContent);
      await p.setInputFiles("#io-network-file", exported.network);
      await p.waitForFunction((w0) => document.getElementById("vec-meta").textContent !== w0 && /EPSG:/.test(document.getElementById("vec-meta").textContent), w0, { timeout: STEP_TIMEOUT });
      await waitIdle(p);
      await p.setInputFiles("#io-mask-file", exported.mask);
      await waitText(p, "imp-meta", /\d/, "mask meta", /Reading/);
      const b0 = (await uiText(p, ["bridge-meta"]))["bridge-meta"];
      await p.setInputFiles("#io-bridges-file", exported.bridges);
      await p.waitForFunction((b0) => document.getElementById("bridge-meta").textContent !== b0, b0, { timeout: STEP_TIMEOUT });
      await waitIdle(p);
      const metas = await uiText(p, ["dem-meta", "vec-meta", "imp-meta", "bridge-meta"]);
      await setValue(p, "mode", "from");
      await clickCell(p, MASK_SRC);
      const run = await runCompute(p);
      const d = await singleDigest(p, "r-reimport");
      const same = {};
      for (const n of ["energy.tif", "passes.tif", "network.tif", "impassable.tif"]) same[n] = d.bundle[n]?.sha256 === fullBundle.bundle[n]?.sha256;
      for (const [k, v] of Object.entries(same)) if (!v) throw new Error(`re-imported datasets: ${k} differs from the original run`);
      return { metas, ...run, sameAsOriginal: same };
    });
  } finally {
    await g2.ctx.close();
  }
}

// ---------------------------------------------------------------- s. Overpass street pull (canned response)
async function groupOsm(browser, port, F) {
  const { ctx, page } = await openGroup(browser, port, F, "s.osm", { overpass: fx.overpassResponse() });
  try {
    await step("s.osm-pull", async () => {
      const w0 = await page.evaluate(() => document.getElementById("vec-meta").textContent);
      await clickId(page, "vec-osm");
      await page.waitForFunction((w0) => {
        const t = document.getElementById("vec-meta").textContent;
        return (t !== w0 && /\d/.test(t)) || !!document.getElementById("status").querySelector('span[style*="ff6b6b"]');
      }, w0, { timeout: STEP_TIMEOUT });
      const err = await page.evaluate(() => document.getElementById("status").querySelector('span[style*="ff6b6b"]')?.textContent || null);
      if (err) throw new Error("OSM pull failed: " + err);
      await waitIdle(page);
      return { ...(await uiText(page, ["vec-meta"])),
        bridgeFromNetworkEnabled: await page.evaluate(() => !document.getElementById("bridge-from-network").disabled) };
    });
    // West ramp -> east ramp: the only network link is the layer-1 viaduct.
    await step("s.osm-graph-path", async () => {
      await setChecked(page, "vec-graph-mode", true);
      await setValue(page, "mode", "from");
      await clickCell(page, [140, 30]);
      await clickCell(page, [140, 210]);
      const run = await runGraphCompute(page);
      const d = await singleDigest(page, "s-graph", { compact: true });
      return { pts: await uiText(page, ["src-display", "dst-display"]), ...run, ...drop(d, "_buf", "resultMeta") };
    });
    await step("s.osm-raster-path", async () => {
      await setChecked(page, "vec-graph-mode", false);
      await setChecked(page, "net-interp", false);
      const run = await runCompute(page);
      return { ...run, ...drop(await singleDigest(page, "s-raster", { compact: true }), "_buf") };
    });
  } finally {
    await ctx.close();
  }
}

// ---------------------------------------------------------------- main
async function writeFixtures() {
  const F = {};
  const put = (name, buf) => { const f = path.join(WORK, name); fs.writeFileSync(f, buf); report.fixtures[name] = sha(buf); return f; };
  report.fixtures = {};
  const demBuf = makeDemTiff();
  report.dem.tiffSha256 = sha(demBuf);
  F.dem = put("synthetic-sp.tif", demBuf);
  F.gpkg = put("streets.gpkg", await fx.makeNetworkGpkg());
  F.mask = put("river-mask.tif", fx.makeMaskTiff());
  F.gpxEle = put("track-ele.gpx", fx.makeGpx({ withEle: true }));
  F.gpxNoEle = put("track-noele.gpx", fx.makeGpx({ withEle: false }));
  return F;
}

async function runGroup(name, fn) {
  try { await fn(); }
  catch (err) {
    if (!(err instanceof SkipRest)) throw err;
    report.skipped = (report.skipped || []).concat(`${name}: ${err.message}`);
    console.error("[smoke] " + err.message);
  }
}

async function main() {
  const t0 = Date.now();
  WORK = fs.mkdtempSync(path.join(HERE, "work-"));
  if (ONLY) report.only = ONLY;
  const F = await writeFixtures();

  const server = await startServer(ROOT);
  const port = server.address().port;
  const browser = await chromium.launch({ headless: !HEADED, ...(CHROMIUM ? { executablePath: CHROMIUM } : {}) });
  try {
    if (wantGroup("core")) await runGroup("core", () => groupCore(browser, port, F));
    if (wantGroup("net")) await runGroup("net", () => groupNet(browser, port, F));
    if (wantGroup("graph")) await runGroup("graph", () => groupGraph(browser, port, F));
    if (wantGroup("draw")) await runGroup("draw", () => groupDraw(browser, port, F));
    if (wantGroup("config")) await runGroup("config", () => groupConfig(browser, port, F));
    if (wantGroup("refgeom")) await runGroup("refgeom", () => groupRefgeom(browser, port, F));
    if (wantGroup("mask")) await runGroup("mask", () => groupMask(browser, port, F));
    if (wantGroup("osm")) await runGroup("osm", () => groupOsm(browser, port, F));
  } finally {
    await browser.close().catch(() => {});
    server.close();
  }

  // whitelist summary: host -> count
  const wl = {};
  for (const h of whitelisted) wl[h] = (wl[h] || 0) + 1;
  report.whitelistedConsoleErrors = {
    pattern: "console 'Failed to load resource: net::ERR_BLOCKED_BY_CLIENT' whose location URL is a request this harness aborted (external host)",
    hosts: Object.keys(wl).sort(),
  };
  report.problems = problems;
  report.ok = problems.length === 0;
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + "\n");
  fs.rmSync(WORK, { recursive: true, force: true });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.error(`[smoke] ${report.ok ? "PASS" : "FAIL"} — ${report.steps.filter((s) => s.ok).length}/${report.steps.length} steps ok, ${problems.length} problem(s), ${secs} s${OUT ? " -> " + OUT : ""}`);
  if (!report.ok) for (const p of problems) console.error("[smoke]   problem:", JSON.stringify(p));
  process.exit(report.ok ? 0 : 1);
}

main().catch((err) => {
  console.error("[smoke] harness crash:", err && err.stack || err);
  try {
    report.problems = problems.concat([{ type: "harness-crash", error: String(err && err.message || err) }]);
    report.ok = false;
    if (OUT) fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + "\n");
    fs.rmSync(WORK, { recursive: true, force: true });
  } catch {}
  process.exit(2);
});
