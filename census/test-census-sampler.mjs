#!/usr/bin/env node
// Regression test for the in-browser census sampler (app.js placeCensusRefPoints
// and its helpers). The helpers are imported from lib/census-sampler.js — the
// same module app.js uses, so these tests exercise the real implementation.
//
// Run: node test-census-sampler.mjs
//
// Asserts: (1) population weighting — over many draws the share of points in a
// high-pop setor matches its weight share; (2) placement validity — every placed
// point is inside its setor polygon and the DEM bbox; (3) clip-area ratio — the
// pop weight for an edge-straddling setor uses the correct clipped/full fraction.

import assert from "node:assert";
import {
  sobolPoint2D, sobolScalar1D, pointInPolygon, polyArea, clippedPolyArea,
} from "../lib/census-sampler.js";

// A closed square ring [x0,y0]-[x1,y1].
const sq = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

console.log("census sampler (lib/census-sampler.js) tests");

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
