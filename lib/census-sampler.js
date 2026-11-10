// lib/census-sampler.js — quasi-Monte-Carlo sequences and the polygon
// helpers behind reference-point placement (random/Sobol/Halton and the
// census population-weighted sampler). Pure; shared by app.js and
// census/test-census-sampler.mjs. Moved verbatim out of app.js.

// ---- Quasi-Monte-Carlo point sets for reference placement ----------------
// Low-discrepancy sequences cover the DEM evenly (no clumps/gaps), so the
// density field converges with fewer reference points than pseudo-random
// placement. Both generators are indexed (stateless given i), and the app
// keeps a persistent counter (state.qmcIndex) so successive "Place random"
// clicks CONTINUE the sequence — re-starting at i=0 every click would drop
// the same points on top of the previous batch.

// Bit-reversal of a u32 = van der Corput base-2 radical inverse, which is
// both the Halton base-2 axis and Sobol dimension 1.
export function bitReverse32(x) {
  x = ((x & 0x55555555) << 1) | ((x >>> 1) & 0x55555555);
  x = ((x & 0x33333333) << 2) | ((x >>> 2) & 0x33333333);
  x = ((x & 0x0f0f0f0f) << 4) | ((x >>> 4) & 0x0f0f0f0f);
  x = ((x & 0x00ff00ff) << 8) | ((x >>> 8) & 0x00ff00ff);
  return ((x << 16) | (x >>> 16)) >>> 0;
}

// Sobol dimension-2 direction numbers (primitive polynomial x²+x+1; the
// recurrence reproduces the canonical m = 1, 3, 5, 15, 17, … table).
export const SOBOL_DIM2_V = (() => {
  const v = new Uint32Array(32);
  v[0] = 0x80000000;
  for (let j = 1; j < 32; j++) v[j] = (v[j - 1] ^ (v[j - 1] >>> 1)) >>> 0;
  return v;
})();

// i-th 2-D Sobol point, i ≥ 1 (i = 0 is the degenerate (0,0) corner).
// First points: (.5,.5) (.25,.75) (.75,.25) (.125,.625) …
export function sobolPoint2D(i) {
  const u = bitReverse32(i >>> 0) / 2 ** 32;
  let x = 0;
  for (let j = 0; j < 32; j++) {
    if ((i >>> j) & 1) x = (x ^ SOBOL_DIM2_V[j]) >>> 0;
  }
  return [u, x / 2 ** 32];
}

// i-th 2-D Halton point (bases 2 and 3), i ≥ 1.
export function haltonPoint2D(i) {
  const u = bitReverse32(i >>> 0) / 2 ** 32;
  let v = 0, f = 1 / 3, k = i;
  while (k > 0) {
    v += (k % 3) * f;
    k = (k / 3) | 0;
    f /= 3;
  }
  return [u, v];
}

// 1-D Sobol / van der Corput scalar in [0,1) — the first axis of sobolPoint2D.
export function sobolScalar1D(i) { return bitReverse32(i >>> 0) / 2 ** 32; }

// Ray-cast (even-odd) point-in-ring test; ring = [[lng,lat], …].
export function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (((yi > y) !== (yj > y)) &&
        (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
// A polygon is [outerRing, hole1, …]: inside the outer ring and outside holes.
export function pointInPolygon(x, y, rings) {
  if (!rings.length || !pointInRing(x, y, rings[0])) return false;
  for (let h = 1; h < rings.length; h++) if (pointInRing(x, y, rings[h])) return false;
  return true;
}

// Shoelace ring area (abs; works on open or closed rings). lon/lat units — we
// only ever use the clipped/full RATIO, which is valid in any consistent CRS.
export function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return Math.abs(a) / 2;
}
export function polyArea(rings) {        // outer − holes
  let a = rings.length ? ringArea(rings[0]) : 0;
  for (let h = 1; h < rings.length; h++) a -= ringArea(rings[h]);
  return Math.max(0, a);
}

// Sutherland–Hodgman clip of a ring against the axis-aligned DEM bbox; returns
// the clipped vertex list (possibly empty). Used only for the area ratio.
export function clipRingToBbox(ring, bb) {
  let poly = ring;
  if (poly.length > 1) {         // drop the duplicate closing vertex if present
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
export function clippedPolyArea(rings, bb) {
  if (!rings.length) return 0;
  let a = ringArea(clipRingToBbox(rings[0], bb));
  for (let h = 1; h < rings.length; h++) a -= ringArea(clipRingToBbox(rings[h], bb));
  return Math.max(0, a);
}
