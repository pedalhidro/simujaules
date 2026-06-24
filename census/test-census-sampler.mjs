#!/usr/bin/env node
// Regression test for the in-browser census sampler (app.js placeCensusRefPoints
// and its helpers). app.js is a browser module and can't be imported in node, so
// the helpers below are HAND-KEPT MIRRORS of app.js — keep them in lockstep with
// it (same convention as test-water-raster.mjs mirroring app.js's water helpers,
// and backend/main.rs mirroring energy-worker.js).
//
// Run: node test-census-sampler.mjs
//
// Asserts: (1) population weighting — over many draws the share of points in a
// high-pop setor matches its weight share; (2) placement validity — every placed
// point is inside its setor polygon and the DEM bbox; (3) clip-area ratio — the
// pop weight for an edge-straddling setor uses the correct clipped/full fraction.

import assert from "node:assert";

// ---- MIRRORS OF app.js (keep in sync) ------------------------------------
function bitReverse32(x) {
  x = ((x & 0x55555555) << 1) | ((x >>> 1) & 0x55555555);
  x = ((x & 0x33333333) << 2) | ((x >>> 2) & 0x33333333);
  x = ((x & 0x0f0f0f0f) << 4) | ((x >>> 4) & 0x0f0f0f0f);
  x = ((x & 0x00ff00ff) << 8) | ((x >>> 8) & 0x00ff00ff);
  return ((x << 16) | (x >>> 16)) >>> 0;
}
const SOBOL_DIM2_V = (() => {
  const v = new Uint32Array(32);
  v[0] = 0x80000000;
  for (let j = 1; j < 32; j++) v[j] = (v[j - 1] ^ (v[j - 1] >>> 1)) >>> 0;
  return v;
})();
function sobolPoint2D(i) {
  const u = bitReverse32(i >>> 0) / 2 ** 32;
  let x = 0;
  for (let j = 0; j < 32; j++) if ((i >>> j) & 1) x = (x ^ SOBOL_DIM2_V[j]) >>> 0;
  return [u, x / 2 ** 32];
}
function sobolScalar1D(i) { return bitReverse32(i >>> 0) / 2 ** 32; }

function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (((yi > y) !== (yj > y)) &&
        (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
function pointInPolygon(x, y, rings) {
  if (!rings.length || !pointInRing(x, y, rings[0])) return false;
  for (let h = 1; h < rings.length; h++) if (pointInRing(x, y, rings[h])) return false;
  return true;
}
function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return Math.abs(a) / 2;
}
function polyArea(rings) {
  let a = rings.length ? ringArea(rings[0]) : 0;
  for (let h = 1; h < rings.length; h++) a -= ringArea(rings[h]);
  return Math.max(0, a);
}
function clipRingToBbox(ring, bb) {
  let poly = ring;
  if (poly.length > 1) {
    const a = poly[0], b = poly[poly.length - 1];
    if (a[0] === b[0] && a[1] === b[1]) poly = poly.slice(0, -1);
  }
  const ix = (p, q, x) => { const t = (x - p[0]) / (q[0] - p[0]); return [x, p[1] + t * (q[1] - p[1])]; };
  const iy = (p, q, y) => { const t = (y - p[1]) / (q[1] - p[1]); return [p[0] + t * (q[0] - p[0]), y]; };
  const clip = (pts, inside, cut) => {
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const cur = pts[i], prev = pts[(i + pts.length - 1) % pts.length];
      const ci = inside(cur), pi = inside(prev);
      if (ci) { if (!pi) out.push(cut(prev, cur)); out.push(cur); }
      else if (pi) out.push(cut(prev, cur));
    }
    return out;
  };
  poly = clip(poly, (p) => p[0] >= bb.xmin, (p, q) => ix(p, q, bb.xmin)); if (!poly.length) return poly;
  poly = clip(poly, (p) => p[0] <= bb.xmax, (p, q) => ix(p, q, bb.xmax)); if (!poly.length) return poly;
  poly = clip(poly, (p) => p[1] >= bb.ymin, (p, q) => iy(p, q, bb.ymin)); if (!poly.length) return poly;
  poly = clip(poly, (p) => p[1] <= bb.ymax, (p, q) => iy(p, q, bb.ymax));
  return poly;
}
function clippedPolyArea(rings, bb) {
  if (!rings.length) return 0;
  let a = ringArea(clipRingToBbox(rings[0], bb));
  for (let h = 1; h < rings.length; h++) a -= ringArea(clipRingToBbox(rings[h], bb));
  return Math.max(0, a);
}
// ---- end mirrors ---------------------------------------------------------

// A closed square ring [x0,y0]-[x1,y1].
const sq = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

console.log("census sampler (mirror) tests");

// --- 1. population-weighted setor selection -------------------------------
check("weighting: ~90% of draws land in the pop-90 setor", () => {
  const bb = { xmin: 0, ymin: 0, xmax: 2, ymax: 1 };
  const setores = [
    { parts: [[sq(0, 0, 1, 1)]], pop: 10 },   // left
    { parts: [[sq(1, 0, 2, 1)]], pop: 90 },   // right
  ].map((s) => {
    let full = 0, clip = 0;
    for (const rings of s.parts) { full += polyArea(rings); clip += clippedPolyArea(rings, bb); }
    return { ...s, w: s.pop * Math.min(1, clip / full) };
  });
  const totalW = setores.reduce((a, s) => a + s.w, 0);
  assert.strictEqual(totalW, 100, `totalW=${totalW}`);
  const cdf = [];
  let acc = 0;
  for (const s of setores) { acc += s.w; cdf.push(acc / totalW); }
  const searchsorted = (u) => {
    let lo = 0, hi = cdf.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (cdf[m] < u) lo = m + 1; else hi = m; }
    return lo;
  };
  const N = 4000;
  let inB = 0;
  for (let k = 0; k < N; k++) if (searchsorted(sobolScalar1D(k + 1)) === 1) inB++;
  const frac = inB / N;
  assert.ok(frac > 0.88 && frac < 0.92, `share in pop-90 setor = ${frac.toFixed(3)} (want ~0.90)`);
});

// --- 2. placement validity ------------------------------------------------
check("placement: every point lands inside its setor polygon and the bbox", () => {
  const bb = { xmin: 0, ymin: 0, xmax: 2, ymax: 1 };
  // An L-shaped setor (concave) to exercise PIP rejection: union of two squares.
  const Lshape = { parts: [[sq(0, 0, 1, 1)], [sq(1, 0, 2, 0.4)]], pop: 50 };
  let placed = 0;
  let ctr = 0;
  const { parts } = Lshape;
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const rings of parts) for (const p of rings[0]) {
    minx = Math.min(minx, p[0]); maxx = Math.max(maxx, p[0]);
    miny = Math.min(miny, p[1]); maxy = Math.max(maxy, p[1]);
  }
  for (let k = 0; k < 500; k++) {
    let pt = null;
    for (let tries = 0; tries < 64; tries++) {
      const [qx, qy] = sobolPoint2D(++ctr);
      const lng = minx + qx * (maxx - minx);
      const lat = miny + qy * (maxy - miny);
      if (parts.some((rings) => pointInPolygon(lng, lat, rings))) { pt = [lng, lat]; break; }
    }
    assert.ok(pt, `rejection cap hit at k=${k}`);
    assert.ok(parts.some((r) => pointInPolygon(pt[0], pt[1], r)), "point not in setor");
    assert.ok(pt[0] >= bb.xmin && pt[0] <= bb.xmax && pt[1] >= bb.ymin && pt[1] <= bb.ymax, "point outside bbox");
    placed++;
  }
  assert.strictEqual(placed, 500);
});

// --- 3. clip-area ratio for an edge-straddling setor ----------------------
check("clip ratio: setor half-inside the DEM bbox gets weight halved", () => {
  const rings = [sq(0, 0, 2, 2)];      // full area 4
  const bb = { xmin: 0, ymin: 0, xmax: 1, ymax: 2 };  // keeps left half (area 2)
  const full = polyArea(rings);
  const clip = clippedPolyArea(rings, bb);
  assert.strictEqual(full, 4, `full=${full}`);
  assert.ok(Math.abs(clip - 2) < 1e-9, `clip=${clip} (want 2)`);
  assert.ok(Math.abs(clip / full - 0.5) < 1e-9, `ratio=${clip / full} (want 0.5)`);
});

// --- 4. polygon with a hole (area = outer − hole) -------------------------
check("polyArea subtracts holes", () => {
  const rings = [sq(0, 0, 4, 4), sq(1, 1, 2, 2)];   // 16 − 1
  assert.strictEqual(polyArea(rings), 15);
});

if (failures) { console.error(`\n${failures} test(s) FAILED`); process.exit(1); }
console.log("\nall census sampler tests passed");
