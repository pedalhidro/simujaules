// Entry 26 harness (bicycling-energy-model journal, 2026-07-24 pre-registration):
//   Experiment 1 (Q1) — the SHIPPED direction ladder (buildMoves nDirs 8/16/32/
//     64/128, profile-integrated long edges, the v57 path) on the Entry-19
//     corpus's REAL ride endpoint pairs, sq128 as reference.
//   Experiment 2B (Q2B) — OSM bridge/tunnel portals (the shipped v19
//     buildPortalAdj machinery) in the discretized scenario: nDirs 8 and 16
//     WITH vs WITHOUT portals on the same pairs.
//
// Unlike grid-sens.mjs this harness does NOT reimplement the ladder: every
// field is produced by the REAL energy-worker.js run in a sandbox (kind:"run",
// mode:"from", nDirs, portalU/V/lenM) — the exact shipped v57/v19 code paths.
// The grid-sens mirrors kept here are only for (a) the UI-default cost bundle,
// (b) the v55 σ=10 m pre-smoothing, and (c) the independent 8-move Dijkstra
// used by the non-negotiable validation gate: before any reporting, the
// mirror's 8-move field must be BIT-IDENTICAL (max|Δ| = 0, zero finite
// mismatches) to the real worker's on the first crop, or the run aborts.
//
// Inputs (sibling repo, all gitignored there — endpoints are GPS-derived,
// nothing with coordinates is committed anywhere):
//   ../bicycling-energy-model/results/e26_pairs.json
//     [{ pair_id, corpus, lat_a, lon_a, lat_b, lon_b, straight_m, n_rides }]
//   If missing: 3 synthetic pairs derived from dem/sampa_centro.tif's center
//     (smoke-only fallback; corpus "synthetic").
// DEM: ../dem/sampa_geral.tif (the deployed IGC-SP ~5 m raster). Per pair the
//   crop is the endpoint bbox + 2 km margin, capped at ~16 M cells (log+skip).
// Overpass responses are cached under
//   ../bicycling-energy-model/results/e26_osm_cache/ so reruns are offline.
// Output: appends per-pair rows to
//   ../bicycling-energy-model/results/e26_grid.csv   (resume-safe: pair_ids
//   already present are skipped; smoke mode writes e26_grid_smoke.csv instead
//   so a smoke row never blocks the full run).
//
// Usage:  cd docs && node grid-e26.mjs          (full: nDirs 8/16/32/64/128)
//         E26_SMOKE=1 node grid-e26.mjs         (first 5 pairs, nDirs 8/16/128)
// Needs census/node_modules (npm install in census/ — geotiff).
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, unlinkSync } from "fs";
import { createRequire } from "module";
import { createHash } from "crypto";
const require = createRequire(new URL("../census/noop.js", import.meta.url));
const GeoTIFF = require("geotiff");

const SMOKE = process.env.E26_SMOKE === "1";
// Physics bundle — Experiment 1's declared conditions: bundle 1 = UI defaults
// (the Entry 23/25 bundle), bundle 2 = an Entry-20 calibrated rider set, as the
// sensitivity leg.  Each bundle writes its OWN CSV (same pattern as SMOKE), so
// rows never mix and resume-on-pair_id stays correct within a condition.
const BUNDLE = process.env.E26_BUNDLE === "cal" ? "cal" : "ui";
const SIB_RESULTS = "/Users/danlessa/repos/pedalhidro/bicycling-energy-model/results";
const PAIRS_PATH = `${SIB_RESULTS}/e26_pairs.json`;
const CSV_PATH = `${SIB_RESULTS}/${SMOKE ? "e26_grid_smoke" : "e26_grid"}${BUNDLE === "cal" ? "_cal" : ""}.csv`;
const CACHE_DIR = `${SIB_RESULTS}/e26_osm_cache`;
// Span cache namespace: tiles of a FIXED grid over the whole DEM, never a
// pair-derived bbox (see the privacy note at overpassTile).
const TILE_DEG = 0.1;
const DEM_PATH = new URL("../dem/sampa_geral.tif", import.meta.url);
const CENTRO_PATH = new URL("../dem/sampa_centro.tif", import.meta.url);
// Mirror rotation: the app uses only overpass-api.de, but for this offline
// cached harness any OSM-complete Overpass instance returns the same data;
// the main instance 504s under load, so retries walk this list.
const OVERPASS_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];
const MARGIN_M = 2000;          // crop margin around the endpoint bbox
const MAX_CELLS = 16e6;         // crop area cap (log + skip beyond)
const SNAP_R = 20;              // endpoint snap radius, cells (~100 m at 5 m)
const LADDER = SMOKE ? [8, 16, 128] : [8, 16, 32, 64, 128];
const CSV_HEADER = "pair_id,corpus,straight_m,n_rides,crop_cells," +
  "e8,e16,e32,e64,e128,reach8,reach16,t8,t16,t32,t64,t128," +
  "portals_n,e8_portal,e16_portal,reach8_portal,reach16_portal";

// ---- v2Edge mirror (energy-worker.js) — gate Dijkstra + portal-cost check --
function v2Edge(dist, dh, c) {
  if (dh >= 0) {
    const aero = (dh < c.climbThr * dist) ? c.aAero * dist : 0;
    return c.aRoll * dist + aero + c.beta * dh;
  }
  const ndh = -dh;
  let eps = c.abRatio * dist / ndh;
  if (eps > 1) eps = 1;
  eps -= c.epsOffset;
  if (eps < 0) eps = 0;
  const e = c.aRoll * dist + c.aAero * dist - eps * c.beta * ndh;
  return e < 0 ? 0 : e;
}

// ---- deriveCost mirror (census/census-density.mjs ← app.js readCost) -------
// UI-default physics bundle — identical to grid-sens.mjs / Entry 23/25.
// G_SP — Sao Paulo's local gravity (IAG-USP absolute gravimetry), NOT the
// textbook 9.81: mirrors app.js's G_SP, re-baselined in v63 (long note there).
// The Entry 23/25/26 numbers in the research notes were produced at 9.81, so a
// re-run now reads ~0.24% lower in absolute energy; the ratios they conclude on
// are gravity-insensitive. Kept in step with the app deliberately: a mirror at a
// different gravity would no longer describe what the app computes.
const G_SP = 9.7864;
function flatEqSpeed(P, m, crr, cda, rho, keff) {
  const a = crr * m * G_SP, b = 0.5 * rho * cda;
  let lo = 0, hi = 40;
  for (let k = 0; k < 60; k++) {
    const v = (lo + hi) / 2;
    if ((a + b * v * v) * v < keff * P) lo = v; else hi = v;
  }
  return (lo + hi) / 2;
}
// Bundle 1 (ui)  — the app's UI defaults, identical to grid-sens.mjs / Entry 23/25.
// Bundle 2 (cal) — Experiment 1's declared sensitivity leg: P. Paz's Entry-20
//   calibrated set (CdA 0.206, Crr 0.0142, kSmooth 0.548 at σ*=10 m; mass frozen
//   at that entry's 74.3 kg).  P_flat stays the planning-mode 80 W — a routing
//   field has no ride to read a flat power from, so only the rider constants
//   move.  kSmooth enters as the engine's k_s, scaling β only (never abRatio,
//   which is a grade-geometry quantity — the app's own rule).  These are
//   EFFECTIVE constants, not physical ones (Entry 20's caveat), and they shift
//   the climb-dominance ratio β/(aRoll+aAero) that Entry 25 §7 names as the
//   driver of the grid bias — which is exactly what the sensitivity leg probes.
const BUNDLES = {
  ui: { m: 75, crr: 0.008, cda: 0.45, rho: 1.1, keff: 0.97, pFlat: 80, ks: 1 },
  cal: { m: 74.3, crr: 0.0142, cda: 0.206, rho: 1.13, keff: 0.98, pFlat: 80, ks: 0.548 },
};
function deriveCost() {
  const { m, crr, cda, rho, keff, pFlat, ks } = BUNDLES[BUNDLE];
  const vf = flatEqSpeed(pFlat, m, crr, cda, rho, keff);
  const g = G_SP, mg = m * g, KJ = 1000;   // local SP gravity — see G_SP above
  const aeroCoef = 0.5 * rho * cda * vf * vf;
  return {
    aRoll: mg * crr / keff / KJ,
    aAero: aeroCoef / keff / KJ,
    beta: mg * ks / keff / KJ,
    climbThr: 0.02,
    abRatio: crr + aeroCoef / mg,
    epsOffset: 0.13,
  };
}

// ---- smoothHeightsInPlace mirror (test-dem-smoothing.mjs / app.js v55) -----
function smoothHeightsInPlace(height, mask, H, W, dxM, dyM, sigmaM) {
  const axes = [
    { pix: dxM, stride: 1, lines: H, len: W, lineStride: W },
    { pix: dyM, stride: W, lines: W, len: H, lineStride: 1 },
  ];
  const maxLen = Math.max(W, H);
  const src = new Float64Array(maxLen);
  const val = new Float64Array(maxLen);
  const wgt = new Float64Array(maxLen);
  for (const { pix, stride, lines, len, lineStride } of axes) {
    const sigmaPx = sigmaM / pix;
    if (!(sigmaPx > 0.3)) continue;
    const R = Math.max(1, Math.round(3 * sigmaPx));
    const kern = new Float64Array(2 * R + 1);
    for (let k = -R; k <= R; k++) kern[k + R] = Math.exp(-(k * k) / (2 * sigmaPx * sigmaPx));
    for (let ln = 0; ln < lines; ln++) {
      const base = ln * lineStride;
      for (let i = 0; i < len; i++) src[i] = height[base + i * stride];
      val.fill(0, 0, len); wgt.fill(0, 0, len);
      for (let i = 0; i < len; i++) {
        if (!mask[base + i * stride]) continue;
        const lo = Math.max(0, i - R), hi = Math.min(len - 1, i + R);
        for (let j = lo; j <= hi; j++) {
          if (!mask[base + j * stride]) continue;
          const w = kern[j - i + R];
          val[i] += w * src[j];
          wgt[i] += w;
        }
      }
      for (let i = 0; i < len; i++) {
        if (mask[base + i * stride] && wgt[i] > 0) height[base + i * stride] = val[i] / wgt[i];
      }
    }
  }
}

// ---- gate Dijkstra (grid-sens.mjs mirror, used with the classic 8 only) ----
// Mirrors the worker's relax rules: f32 E storage, f64 heap keys, settled-byte
// staleness filter, settled neighbors never relaxed.
function sqOffsets8() {
  const set = new Map();
  for (const [a, b] of [[1, 0], [1, 1]])
    for (const [dr, dc] of [[a, b], [b, a]])
      for (const sr of [1, -1])
        for (const sc of [1, -1])
          set.set(`${dr * sr || 0},${dc * sc || 0}`, [dr * sr || 0, dc * sc || 0]);
  return [...set.values()];
}
function dijkstra8(height, mask, H, W, dxM, dyM, cost, seedR, seedC) {
  const offs = sqOffsets8();
  const N = H * W;
  const E = new Float32Array(N).fill(Infinity);
  const settled = new Uint8Array(N);
  const K = offs.length;
  const dIdx = new Int32Array(K);
  const dist = new Float64Array(K);
  for (let k = 0; k < K; k++) {
    const [dr, dc] = offs[k];
    dIdx[k] = dr * W + dc;
    dist[k] = Math.hypot(dr * dyM, dc * dxM);
  }
  let heapP = new Float64Array(1 << 16), heapV = new Int32Array(1 << 16), hn = 0;
  const push = (p, v) => {
    if (hn === heapP.length) {
      const p2 = new Float64Array(hn * 2); p2.set(heapP); heapP = p2;
      const v2 = new Int32Array(hn * 2); v2.set(heapV); heapV = v2;
    }
    let i = hn++;
    heapP[i] = p; heapV[i] = v;
    while (i > 0) {
      const par = (i - 1) >> 1;
      if (heapP[par] <= heapP[i]) break;
      const tp = heapP[par], tv = heapV[par];
      heapP[par] = heapP[i]; heapV[par] = heapV[i];
      heapP[i] = tp; heapV[i] = tv;
      i = par;
    }
  };
  const pop = () => {
    const p = heapP[0], v = heapV[0];
    hn--;
    heapP[0] = heapP[hn]; heapV[0] = heapV[hn];
    let i = 0;
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      if (l < hn && heapP[l] < heapP[m]) m = l;
      if (r < hn && heapP[r] < heapP[m]) m = r;
      if (m === i) break;
      const tp = heapP[m], tv = heapV[m];
      heapP[m] = heapP[i]; heapV[m] = heapV[i];
      heapP[i] = tp; heapV[i] = tv;
      i = m;
    }
    return [p, v];
  };
  const seed = seedR * W + seedC;
  E[seed] = 0; push(0, seed);
  while (hn > 0) {
    const [g, idx] = pop();
    if (settled[idx]) continue;
    settled[idx] = 1;
    const r = (idx / W) | 0, c = idx - r * W, hHere = height[idx];
    const inner = r >= 1 && r < H - 1 && c >= 1 && c < W - 1;
    for (let k = 0; k < K; k++) {
      let nIdx;
      if (inner) nIdx = idx + dIdx[k];
      else {
        const nr = r + offs[k][0], nc = c + offs[k][1];
        if (nr < 0 || nr >= H || nc < 0 || nc >= W) continue;
        nIdx = nr * W + nc;
      }
      if (!mask[nIdx] || settled[nIdx]) continue;
      const t = g + v2Edge(dist[k], height[nIdx] - hHere, cost);
      if (t < E[nIdx]) { E[nIdx] = t; push(t, nIdx); }
    }
  }
  return E;
}

// ---- real-worker sandbox (grid-sens.mjs pattern) ---------------------------
function loadWorker() {
  const src = readFileSync(new URL("../energy-worker.js", import.meta.url), "utf8");
  const messages = [];
  const sandbox = { postMessage: (m) => messages.push(m), self: {}, performance, console };
  new Function(...Object.keys(sandbox), src)(...Object.values(sandbox));
  return (msg) => {
    messages.length = 0;
    sandbox.self.onmessage({ data: msg });
    const err = messages.find((m) => m.kind === "error");
    if (err) throw new Error(err.message);
    return messages.find((m) => m.kind === "done");
  };
}

// ---- stats helpers ----------------------------------------------------------
const q = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
function pctStats(vals) {
  const v = [...vals].sort((a, b) => a - b);
  const mean = v.reduce((s, x) => s + x, 0) / v.length;
  return { n: v.length, mean, med: q(v, 0.5), p90: q(v, 0.9), min: v[0], max: v[v.length - 1] };
}
const fmtPct = (s) =>
  `n=${s.n}  mean=${(100 * s.mean).toFixed(2)}%  med=${(100 * s.med).toFixed(2)}%  p90=${(100 * s.p90).toFixed(2)}%  max=${(100 * s.max).toFixed(2)}%`;

// ---- Overpass (cached) -------------------------------------------------------
// Mirrors app.js loadOsmBridges' query: bridge=* (not "no") highway ways +
// tunnel=yes highway ways, with geometry. The `ele` node pull is omitted:
// portalHU/HV are not sent, so buildPortalAdj falls back to the DEM height at
// each abutment cell — byte-identical to an app pull without mapped `ele`.
// PRIVACY (load-bearing): the request geometry must NOT depend on the ride
// endpoints.  Overpass is a third party, and a crop bbox built from a pair's
// endpoints + a fixed margin inverts back to those endpoints — which are often
// homes.  So spans are pulled per TILE of a fixed lat/lon grid spanning the
// WHOLE DEM (what the Entry 26 pre-registration actually specified: "spans
// pulled for the sampa_geral bbox"), unconditionally and once, then filtered to
// each crop in memory.  Every request is therefore a function of the DEM extent
// alone.  (An earlier revision of this harness pulled per-pair bboxes; those
// runs were discarded and the deviation is disclosed in the journal entry.)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function overpassTile(ilat, ilon) {
  const south = ilat * TILE_DEG, west = ilon * TILE_DEG;
  const north = south + TILE_DEG, east = west + TILE_DEG;
  const bbox = `${south.toFixed(6)},${west.toFixed(6)},${north.toFixed(6)},${east.toFixed(6)}`;
  const cachePath = `${CACHE_DIR}/tile_${TILE_DEG}_${ilat}_${ilon}.json`;
  let json;
  if (existsSync(cachePath)) {
    json = JSON.parse(readFileSync(cachePath, "utf8"));
  } else {
    const parts = `way["bridge"]["bridge"!="no"]["highway"](${bbox});` +
                  `way["tunnel"="yes"]["highway"](${bbox});`;
    const query = `[out:json][timeout:90];(${parts});out geom;`;
    let lastErr = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        if (attempt > 0) await sleep(10000 * attempt);
        const resp = await fetch(OVERPASS_URLS[attempt % OVERPASS_URLS.length], {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            // overpass-api.de's Apache 406s node's default UA — identify per etiquette
            "User-Agent": "grid-e26-harness/1.0 (simujaules research; danilo.lessa@gmail.com)",
          },
          body: "data=" + encodeURIComponent(query),
        });
        if (!resp.ok) throw new Error(`Overpass HTTP ${resp.status}`);
        json = await resp.json();
        lastErr = null;
        break;
      } catch (err) { lastErr = err; }
    }
    if (lastErr) throw lastErr;
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(cachePath, JSON.stringify(json));
    await sleep(1000); // politeness between live Overpass hits
  }
  // A soft-failed Overpass response (HTTP 200 + `remark: runtime error …`) must
  // never be cached as if complete: drop the cache file and fail loudly.
  if (json && typeof json.remark === "string" && /error|timed out/i.test(json.remark)) {
    try { unlinkSync(cachePath); } catch { /* not cached yet */ }
    throw new Error(`Overpass soft-failure for tile ${ilat},${ilon}: ${json.remark}`);
  }
  const ways = [];
  for (const el of json.elements || []) {
    if (el.type !== "way" || !Array.isArray(el.geometry) || el.geometry.length < 2) continue;
    ways.push(el.geometry.map((p) => [p.lat, p.lon]));
  }
  return ways;
}

// Pull every tile of the fixed grid covering the DEM once, union the spans, and
// keep a bbox per way so per-crop filtering is a cheap in-memory pass.
async function loadAllSpans(south, west, north, east) {
  const i0 = Math.floor(south / TILE_DEG), i1 = Math.floor(north / TILE_DEG);
  const j0 = Math.floor(west / TILE_DEG), j1 = Math.floor(east / TILE_DEG);
  const spans = [];
  let nTiles = 0, nCached = 0, nFailed = 0;
  for (let i = i0; i <= i1; i++) {
    for (let j = j0; j <= j1; j++) {
      nTiles++;
      const cached = existsSync(`${CACHE_DIR}/tile_${TILE_DEG}_${i}_${j}.json`);
      let ways;
      try { ways = await overpassTile(i, j); } catch (err) {
        nFailed++;
        console.log(`  ! tile ${i},${j} failed: ${err.message} — spans there are MISSING from this run`);
        continue;
      }
      if (cached) nCached++;
      for (const w of ways) {
        let s = 90, n = -90, wl = 180, e = -180;
        for (const [la, lo] of w) {
          if (la < s) s = la; if (la > n) n = la;
          if (lo < wl) wl = lo; if (lo > e) e = lo;
        }
        spans.push({ w, s, n, wl, e });
      }
    }
  }
  console.log(`spans: ${spans.length} bridge/tunnel ways over ${nTiles} fixed tiles `
    + `(${nCached} cached, ${nTiles - nCached - nFailed} pulled, ${nFailed} FAILED) `
    + `— tile grid spans the whole DEM, independent of any ride endpoint`);
  return spans;
}

const spansInBbox = (spans, s, w, n, e) =>
  spans.filter((x) => x.n >= s && x.s <= n && x.e >= w && x.wl <= e).map((x) => x.w);

// Portals on the crop grid, exactly the app's installBridgesFromWays →
// buildPortals shape: endA/endB = first/last way-node cells (OSM splits a
// bridge way at its abutments), deckLenM = the way's polyline length in cell
// metric; spans whose endpoints leave the crop, coincide, or land on invalid
// cells are skipped.
function buildCropPortals(ways, geo, mask, H, W) {
  const { oy, ox, degX, degY, r0, c0, dxM, dyM } = geo;
  const llToCell = (lat, lon) => [
    Math.floor((oy - lat) / degY) - r0,
    Math.floor((lon - ox) / degX) - c0,
  ];
  const inB = (rc) => rc[0] >= 0 && rc[0] < H && rc[1] >= 0 && rc[1] < W;
  const u = [], v = [], lenM = [];
  let skipped = 0;
  for (const pts of ways) {
    const a = llToCell(pts[0][0], pts[0][1]);
    const z = llToCell(pts[pts.length - 1][0], pts[pts.length - 1][1]);
    if (!inB(a) || !inB(z)) { skipped++; continue; }
    const endA = a[0] * W + a[1], endB = z[0] * W + z[1];
    if (endA === endB || !mask[endA] || !mask[endB]) { skipped++; continue; }
    let deckLenM = 0, prev = a;
    for (let i = 1; i < pts.length; i++) {
      const cur = llToCell(pts[i][0], pts[i][1]);
      deckLenM += Math.hypot((cur[0] - prev[0]) * dyM, (cur[1] - prev[1]) * dxM);
      prev = cur;
    }
    if (!(deckLenM > 0)) { skipped++; continue; }
    u.push(endA); v.push(endB); lenM.push(deckLenM);
  }
  return {
    u: Int32Array.from(u), v: Int32Array.from(v), lenM: Float64Array.from(lenM),
    n: u.length, skipped,
  };
}

// ---- endpoint snap (nearest passable cell within SNAP_R) --------------------
function snapToMask(r, c, mask, H, W) {
  if (r >= 0 && r < H && c >= 0 && c < W && mask[r * W + c]) return [r, c];
  let best = null, bestD = Infinity;
  for (let R = 1; R <= SNAP_R; R++) {
    for (let dr = -R; dr <= R; dr++) {
      for (let dc = -R; dc <= R; dc++) {
        if (Math.max(Math.abs(dr), Math.abs(dc)) !== R) continue;
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || rr >= H || cc < 0 || cc >= W || !mask[rr * W + cc]) continue;
        const d = dr * dr + dc * dc;
        if (d < bestD) { bestD = d; best = [rr, cc]; }
      }
    }
    if (best) return best; // ring R done and something found — nearest enough
  }
  return null;
}

// ---- pairs -------------------------------------------------------------------
async function loadPairs() {
  if (existsSync(PAIRS_PATH)) {
    return { pairs: JSON.parse(readFileSync(PAIRS_PATH, "utf8")), synthetic: false };
  }
  // Fallback: 3 synthetic pairs derived from sampa_centro.tif's center
  // (its extent is a crop of sampa_geral, so the coordinates are valid).
  console.log(`NOTE: ${PAIRS_PATH} missing — using 3 synthetic smoke pairs from sampa_centro.tif`);
  const tif = await GeoTIFF.fromArrayBuffer(toAB(readFileSync(CENTRO_PATH)));
  const img = await tif.getImage();
  const [ox, oy] = img.getOrigin();
  const [degX, degYneg] = img.getResolution();
  const degY = Math.abs(degYneg);
  const cLat = oy - (img.getHeight() / 2) * degY;
  const cLon = ox + (img.getWidth() / 2) * degX;
  const mLat = 1 / 110574, mLon = 1 / (111320 * Math.cos(cLat * Math.PI / 180));
  const mk = (id, dlatA, dlonA, dlatB, dlonB) => {
    const latA = cLat + dlatA * mLat, lonA = cLon + dlonA * mLon;
    const latB = cLat + dlatB * mLat, lonB = cLon + dlonB * mLon;
    const straight = Math.hypot((latA - latB) / mLat, (lonA - lonB) / mLon);
    return { pair_id: id, corpus: "synthetic", lat_a: latA, lon_a: lonA,
             lat_b: latB, lon_b: lonB, straight_m: straight, n_rides: 0 };
  };
  return {
    pairs: [
      mk("synth1", 0, -1000, 0, 1000),
      mk("synth2", -1200, -1200, 1300, 1500),
      mk("synth3", 1800, -400, -1600, 900),
    ],
    synthetic: true,
  };
}
const toAB = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

// ---- CSV ---------------------------------------------------------------------
function doneIds() {
  if (!existsSync(CSV_PATH)) return new Set();
  const lines = readFileSync(CSV_PATH, "utf8").trim().split("\n").slice(1);
  return new Set(lines.map((l) => l.split(",")[0]).filter(Boolean));
}
function appendRow(row) {
  if (!existsSync(CSV_PATH)) writeFileSync(CSV_PATH, CSV_HEADER + "\n");
  appendFileSync(CSV_PATH, row + "\n");
}

// ---- main ---------------------------------------------------------------------
const cost = deriveCost();
console.log(`grid-e26 ${SMOKE ? "[SMOKE: 5 pairs, nDirs {8,16,128}]" : "[FULL: nDirs {8,16,32,64,128}]"}`);
console.log(`cost bundle [${BUNDLE}]: aRoll=${cost.aRoll.toExponential(3)} aAero=${cost.aAero.toExponential(3)} `
  + `beta=${cost.beta.toExponential(3)}  climb-dominance β/(aRoll+aAero)=${(cost.beta / (cost.aRoll + cost.aAero)).toFixed(1)}:1`
  + `  (${BUNDLE === "ui" ? "UI defaults" : "Entry-20 calibrated rider set"})`);

const { pairs: allPairs, synthetic } = await loadPairs();
const pairs = SMOKE ? allPairs.slice(0, 5) : allPairs;
console.log(`pairs: ${pairs.length} of ${allPairs.length} (${synthetic ? "SYNTHETIC fallback" : "e26_pairs.json"})  → ${CSV_PATH}`);

const tif = await GeoTIFF.fromArrayBuffer(toAB(readFileSync(DEM_PATH)));
const img = await tif.getImage();
const fullW = img.getWidth(), fullH = img.getHeight();
const [ox, oy] = img.getOrigin();
const [degX, degYneg] = img.getResolution();
const degY = Math.abs(degYneg);
console.log(`DEM: sampa_geral.tif ${fullH}×${fullW}`);

// Whole-DEM span pull, once, before any pair is touched (privacy: see overpassTile)
const SPANS = await loadAllSpans(
  oy - fullH * degY, ox, oy, ox + fullW * degX);

const runWorker = loadWorker();
const done = doneIds();
let gated = false;                 // bit-identity + portal-no-op gates run once
let nDone = 0, nSkip = 0;
// worst observed E_with − E_without over all cells (should be f32 noise only;
// see the tolerance note at the portal assert)
const portalOverMax = { abs: 0, rel: 0, n: 0 };
const tAll = Date.now();

for (const P of pairs) {
  if (done.has(P.pair_id)) { console.log(`- ${P.pair_id}: already in CSV, skipped (resume)`); continue; }
  const t0 = Date.now();

  // --- crop window: endpoint bbox + 2 km margin -----------------------------
  const latMin = Math.min(P.lat_a, P.lat_b), latMax = Math.max(P.lat_a, P.lat_b);
  const lonMin = Math.min(P.lon_a, P.lon_b), lonMax = Math.max(P.lon_a, P.lon_b);
  const mLat = MARGIN_M / 110574;
  const mLon = MARGIN_M / (111320 * Math.cos(((latMin + latMax) / 2) * Math.PI / 180));
  const r0 = Math.max(0, Math.floor((oy - (latMax + mLat)) / degY));
  const r1 = Math.min(fullH, Math.ceil((oy - (latMin - mLat)) / degY));
  const c0 = Math.max(0, Math.floor(((lonMin - mLon) - ox) / degX));
  const c1 = Math.min(fullW, Math.ceil(((lonMax + mLon) - ox) / degX));
  const H = r1 - r0, W = c1 - c0;
  if (!(H > 0 && W > 0)) { console.log(`- ${P.pair_id}: outside DEM coverage, skipped`); nSkip++; continue; }
  if (H * W > MAX_CELLS) {
    console.log(`- ${P.pair_id} (${P.corpus}): crop ${H}×${W} = ${(H * W / 1e6).toFixed(1)} M cells > ${(MAX_CELLS / 1e6).toFixed(0)} M cap, skipped`);
    nSkip++; continue;
  }
  const latMid = oy - (r0 + H / 2) * degY;
  const dxM = degX * 111320 * Math.cos(latMid * Math.PI / 180);
  const dyM = degY * 110574;

  const ras = await img.readRasters({ window: [c0, r0, c1, r1], interleave: true });
  const height = new Float32Array(H * W);
  const mask = new Uint8Array(H * W);
  let nBad = 0;
  for (let i = 0; i < H * W; i++) {
    const val = ras[i];
    if (Number.isFinite(val) && val > -100 && val < 9000) { height[i] = val; mask[i] = 1; }
    else { height[i] = 0; nBad++; }
  }
  // v55 app-side pre-smoothing (auto: σ = 10 m when min pixel ≤ 10 m)
  if (Math.min(dxM, dyM) <= 10) smoothHeightsInPlace(height, mask, H, W, dxM, dyM, 10);

  // --- endpoints on the crop grid --------------------------------------------
  const rcA = snapToMask(Math.floor((oy - P.lat_a) / degY) - r0, Math.floor((P.lon_a - ox) / degX) - c0, mask, H, W);
  const rcB = snapToMask(Math.floor((oy - P.lat_b) / degY) - r0, Math.floor((P.lon_b - ox) / degX) - c0, mask, H, W);
  if (!rcA || !rcB) { console.log(`- ${P.pair_id}: endpoint unsnappable (nodata), skipped`); nSkip++; continue; }
  const idxB = rcB[0] * W + rcB[1];
  console.log(`- ${P.pair_id} (${P.corpus}, ${(P.straight_m / 1000).toFixed(1)} km): crop ${H}×${W} = ${(H * W / 1e6).toFixed(2)} M cells, nodata ${nBad}`);

  const baseMsg = () => ({
    kind: "run", H, W, dx: dxM, dy: dyM, cost,
    seedR: rcA[0], seedC: rcA[1], goalR: -1, goalC: -1, mode: "from", eMax: 0,
    height: new Float32Array(height), mask: new Uint8Array(mask),
  });

  // --- validation gates (once, on the first processed crop) ------------------
  if (!gated) {
    const tg = Date.now();
    const ref = runWorker({ ...baseMsg(), nDirs: 8 });
    const mine = dijkstra8(height, mask, H, W, dxM, dyM, cost, rcA[0], rcA[1]);
    let maxD = 0, mismatch = 0;
    for (let i = 0; i < H * W; i++) {
      const a = ref.energy[i], b = mine[i];
      if (Number.isFinite(a) !== Number.isFinite(b)) mismatch++;
      else if (Number.isFinite(a)) maxD = Math.max(maxD, Math.abs(a - b));
    }
    console.log(`  GATE bit-identity vs energy-worker.js (8-move): max|Δ|=${maxD.toExponential(2)} kJ, finite-mismatch=${mismatch} (${((Date.now() - tg) / 1000).toFixed(1)} s)`);
    if (maxD !== 0 || mismatch) { console.error("  VALIDATION FAILED — aborting"); process.exit(1); }
    // v19 no-op invariant: empty portal arrays ≡ no portals, bit-identical
    const noop = runWorker({ ...baseMsg(), nDirs: 8,
      portalU: new Int32Array(0), portalV: new Int32Array(0), portalLenM: new Float64Array(0) });
    let maxD2 = 0, mm2 = 0;
    for (let i = 0; i < H * W; i++) {
      const a = ref.energy[i], b = noop.energy[i];
      if (Number.isFinite(a) !== Number.isFinite(b)) mm2++;
      else if (Number.isFinite(a)) maxD2 = Math.max(maxD2, Math.abs(a - b));
    }
    console.log(`  GATE portal no-op (empty portal set ≡ none): max|Δ|=${maxD2.toExponential(2)} kJ, finite-mismatch=${mm2}`);
    if (maxD2 !== 0 || mm2) { console.error("  PORTAL NO-OP GATE FAILED — aborting"); process.exit(1); }
    gated = true;
  }

  // --- Q1: the direction ladder (real worker, shipped v57 path) --------------
  const eAt = {}, tSec = {}, fields = {};
  let bad = false;
  for (const n of LADDER) {
    const tr = Date.now();
    const out = runWorker({ ...baseMsg(), nDirs: n });
    tSec[n] = (Date.now() - tr) / 1000;
    eAt[n] = out.energy[idxB];
    if (n === 8 || n === 16) fields[n] = out.energy;
    if (!Number.isFinite(eAt[n])) { bad = true; break; }
  }
  if (bad) { console.log(`  E[B] unreachable at some nDirs — pair skipped`); nSkip++; continue; }
  console.log(`  ladder E[B] kJ: ${LADDER.map((n) => `E${n}=${eAt[n].toFixed(2)}`).join(" ")}  (t: ${LADDER.map((n) => `${tSec[n].toFixed(1)}s`).join("/")})`);

  // --- secondary: budget-reach within the median of the pair's own E8 field --
  const finE = [];
  const E8 = fields[8], E16 = fields[16];
  for (let i = 0; i < H * W; i++) if (mask[i] && Number.isFinite(E8[i])) finE.push(E8[i]);
  finE.sort((a, b) => a - b);
  const b50 = q(finE, 0.5);
  let reach8 = 0, reach16 = 0;
  for (let i = 0; i < H * W; i++) {
    if (!mask[i]) continue;
    if (Number.isFinite(E8[i]) && E8[i] <= b50) reach8++;
    if (Number.isFinite(E16[i]) && E16[i] <= b50) reach16++;
  }
  // Q2B's "budget-reach gain" endpoint needs the SAME budget b50 counted on the
  // with-portal fields; filled in the portal block below (carried over when a
  // crop has no spans, by the v19 no-op invariant).
  let reach8p = reach8, reach16p = reach16;
  const countReach = (E) => {
    let k = 0;
    for (let i = 0; i < H * W; i++) if (mask[i] && Number.isFinite(E[i]) && E[i] <= b50) k++;
    return k;
  };

  // --- Q2B: portals (spans filtered from the whole-DEM pull; no network I/O
  // here, so nothing about this pair is ever transmitted) --------------------
  let portals;
  try {
    const ways = spansInBbox(SPANS,
      oy - r1 * degY, ox + c0 * degX, oy - r0 * degY, ox + c1 * degX);
    portals = buildCropPortals(ways, { oy, ox, degX, degY, r0, c0, dxM, dyM }, mask, H, W);
  } catch (err) {
    console.log(`  portal build failed (${err.message}) — pair deferred to a rerun`);
    nSkip++; continue;
  }
  // sanity: every portal edge cost ≥ 0 (both directions, DEM-height decks)
  for (let i = 0; i < portals.n; i++) {
    const dh = height[portals.v[i]] - height[portals.u[i]];
    const fwd = v2Edge(portals.lenM[i], dh, cost), bwd = v2Edge(portals.lenM[i], -dh, cost);
    if (!(fwd >= 0 && bwd >= 0)) { console.error(`  NEGATIVE PORTAL COST (portal ${i}) — aborting`); process.exit(1); }
  }
  let e8p = eAt[8], e16p = eAt[16];
  if (portals.n > 0) {
    const pm = { portalU: portals.u, portalV: portals.v, portalLenM: portals.lenM };
    for (const n of [8, 16]) {
      const out = runWorker({ ...baseMsg(), nDirs: n, ...pm });
      const Ew = out.energy, Ewo = fields[n];
      // Machine-assert: extra edges can only help a shortest path, so
      // E_with <= E_without — but only up to FLOAT32 ACCUMULATION.  The engine
      // stores E in f32 (f64 heap keys); adding portal edges changes the order
      // in which equal-or-better paths are relaxed, so a settled value can move
      // in its last f32 bit without the optimal path changing.  Assert the
      // inequality at a few f32 eps (rel 4e-7 + 1e-6 kJ absolute floor for tiny
      // energies) and REPORT the worst residual instead of pretending it is 0.
      // A violation beyond that tolerance is a real defect and still aborts.
      // (Disclosed amendment to the Entry 26 pre-registration, which wrote the
      // assert as an exact "ΔE <= 0".)
      const TOL_REL = 4e-7, TOL_ABS = 1e-6;
      for (let i = 0; i < H * W; i++) {
        if (!mask[i]) continue;
        const a = Ew[i], b = Ewo[i];
        if (!Number.isFinite(b)) continue;
        if (!Number.isFinite(a)) {
          console.error(`  PORTAL ASSERT FAILED at cell ${i}, nDirs=${n}: with=${a} (non-finite) vs without=${b} — aborting`);
          process.exit(1);
        }
        const over = a - b;
        if (over > 0) {
          const rel = over / Math.max(Math.abs(b), 1e-12);
          if (over > portalOverMax.abs) { portalOverMax.abs = over; portalOverMax.rel = rel; portalOverMax.n = n; }
          if (over > TOL_ABS + TOL_REL * Math.abs(b)) {
            console.error(`  PORTAL ASSERT FAILED at cell ${i}, nDirs=${n}: with=${a} > without=${b}`
              + ` (over=${over.toExponential(3)} kJ, rel=${rel.toExponential(3)} — beyond f32 tolerance) — aborting`);
            process.exit(1);
          }
        }
      }
      if (n === 8) { e8p = Ew[idxB]; reach8p = countReach(Ew); }
      else { e16p = Ew[idxB]; reach16p = countReach(Ew); }
    }
    console.log(`  portals: n=${portals.n} (skipped ${portals.skipped})  ΔE8[B]=${(e8p - eAt[8]).toFixed(3)} kJ  ΔE16[B]=${(e16p - eAt[16]).toFixed(3)} kJ`
      + `  reach8 ${reach8}→${reach8p} (${(100 * (reach8p / Math.max(1, reach8) - 1)).toFixed(2)}%)`);
  } else {
    // no usable spans in this crop: the with-portal run is the no-portal run
    // (v19 no-op invariant, gate-checked above) — values carried over.
    console.log(`  portals: n=0 (skipped ${portals.skipped}) — with ≡ without (no-op invariant)`);
  }

  // --- CSV row -----------------------------------------------------------------
  const col = (n, o) => (n in o ? (o === tSec ? o[n].toFixed(2) : o[n].toFixed(4)) : "");
  appendRow([
    P.pair_id, P.corpus, P.straight_m.toFixed(1), P.n_rides, H * W,
    col(8, eAt), col(16, eAt), col(32, eAt), col(64, eAt), col(128, eAt),
    reach8, reach16,
    col(8, tSec), col(16, tSec), col(32, tSec), col(64, tSec), col(128, tSec),
    portals.n, e8p.toFixed(4), e16p.toFixed(4), reach8p, reach16p,
  ].join(","));
  nDone++;
  console.log(`  pair done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

console.log(`\nrun: ${nDone} pairs computed, ${nSkip} skipped, ${((Date.now() - tAll) / 1000).toFixed(0)} s total`);

// ---- aggregate block (over ALL rows now in the CSV) --------------------------
if (!existsSync(CSV_PATH)) { console.log("no CSV rows — nothing to aggregate"); process.exit(0); }
const rows = readFileSync(CSV_PATH, "utf8").trim().split("\n").slice(1).map((l) => {
  const p = l.split(",");
  return {
    pair_id: p[0], corpus: p[1],
    e: { 8: +p[5], 16: +p[6], 32: p[7] === "" ? NaN : +p[7], 64: p[8] === "" ? NaN : +p[8], 128: +p[9] },
    reach8: +p[10], reach16: +p[11],
    portals_n: +p[17], e8p: +p[18], e16p: +p[19],
    reach8p: p[20] === undefined || p[20] === "" ? NaN : +p[20],
    reach16p: p[21] === undefined || p[21] === "" ? NaN : +p[21],
  };
});
console.log(`\n== Entry 26 aggregate (${rows.length} pairs in ${CSV_PATH.split("/").pop()}) ==`);
console.log(`== Q1: E_opt(n)/E_opt(128) − 1 at B (per-pair; sq128 reference) ==`);
const corpora = [...new Set(rows.map((r) => r.corpus))].sort();
for (const n of [8, 16, 32, 64]) {
  const vals = rows.map((r) => r.e[n] / r.e[128] - 1).filter(Number.isFinite);
  if (!vals.length) continue;
  console.log(`  nDirs=${String(n).padEnd(3)} pooled   ${fmtPct(pctStats(vals))}`);
  for (const cp of corpora) {
    const cv = rows.filter((r) => r.corpus === cp).map((r) => r.e[n] / r.e[128] - 1).filter(Number.isFinite);
    if (cv.length) console.log(`             ${cp.padEnd(9)} ${fmtPct(pctStats(cv))}`);
  }
}
{
  const rv = rows.filter((r) => r.reach8 > 0).map((r) => r.reach16 / r.reach8 - 1);
  if (rv.length) console.log(`== reach16/reach8 − 1 (budget = median of the pair's own E8 field): ${fmtPct(pctStats(rv))}`);
  // Q2B endpoint: budget-reach GAIN from portals, same budget, same nDirs
  for (const [nm, a, b] of [["nDirs=8 ", "reach8p", "reach8"], ["nDirs=16", "reach16p", "reach16"]]) {
    const g = rows.filter((r) => r.portals_n > 0 && r[b] > 0 && Number.isFinite(r[a]))
      .map((r) => r[a] / r[b] - 1);
    if (g.length) console.log(`== Q2B reach gain from portals, ${nm} (same budget): ${fmtPct(pctStats(g))}`
      + `  improved ${g.filter((x) => x > 1e-12).length}/${g.length}`);
  }
}
console.log(`== Q2B: portal ΔE at B (with − without, kJ; negative = portals help) ==`);
for (const [nm, get, getBase] of [["nDirs=8 ", (r) => r.e8p, (r) => r.e[8]], ["nDirs=16", (r) => r.e16p, (r) => r.e[16]]]) {
  const withP = rows.filter((r) => r.portals_n > 0);
  if (!withP.length) { console.log(`  ${nm}: no pairs with portals`); continue; }
  const dAbs = withP.map((r) => get(r) - getBase(r));
  const dRel = withP.map((r) => get(r) / getBase(r) - 1);
  const sA = pctStats(dAbs), sR = pctStats(dRel);
  const improved = dAbs.filter((d) => d < -1e-9).length;
  console.log(`  ${nm}: n=${sA.n} pairs w/ portals, improved ${improved} (${(100 * improved / sA.n).toFixed(0)}%)  ` +
    `ΔkJ med=${sA.med.toFixed(3)} mean=${sA.mean.toFixed(3)} min=${sA.min.toFixed(3)}  ` +
    `Δ% med=${(100 * sR.med).toFixed(2)}% min=${(100 * sR.min).toFixed(2)}%`);
}
{
  const pn = rows.map((r) => r.portals_n).sort((a, b) => a - b);
  console.log(`== portals per crop: med=${q(pn, 0.5)} p90=${q(pn, 0.9)} max=${pn[pn.length - 1]}, pairs with ≥1: ${pn.filter((x) => x > 0).length}/${pn.length}`);
  console.log(`== GATE portals-only-help: worst E_with − E_without over all cells this session`
    + ` = ${portalOverMax.abs.toExponential(3)} kJ (rel ${portalOverMax.rel.toExponential(3)}`
    + `${portalOverMax.n ? `, nDirs=${portalOverMax.n}` : ""}) — f32 accumulation noise;`
    + ` structural violations abort the run`);
}
