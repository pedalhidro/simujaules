// Unit tests for the OSM water-mask rasterisation helpers.
//
// These four functions are PURE (no DOM / no state) MIRRORS of the ones in
// app.js — keep them in sync (like backend/main.rs mirrors energy-worker.js).
// They validate the parts that can't be eyeballed: the sea-flood ORIENTATION
// (OSM coastline = land-left/water-right), even-odd hole handling, supercover
// 4-connectivity, and the assembleRings closed-ring gate.
//
//   node test-water-raster.mjs

// ---- mirrored from app.js ------------------------------------------------
function fillRingsEvenOdd(rings, out, W, H) {
  let yMin = Infinity, yMax = -Infinity;
  for (const r of rings) for (const p of r) { if (p[1] < yMin) yMin = p[1]; if (p[1] > yMax) yMax = p[1]; }
  if (!Number.isFinite(yMin)) return;
  const r0 = Math.max(0, Math.floor(yMin)), r1 = Math.min(H - 1, Math.floor(yMax));
  const xs = [];
  for (let ry = r0; ry <= r1; ry++) {
    const yc = ry + 0.5;
    xs.length = 0;
    for (const ring of rings) {
      const n = ring.length;
      if (n < 3) continue;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const yi = ring[i][1], yj = ring[j][1];
        if ((yi > yc) !== (yj > yc)) xs.push(ring[i][0] + (yc - yi) / (yj - yi) * (ring[j][0] - ring[i][0]));
      }
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    const base = ry * W;
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const cA = Math.max(0, Math.ceil(xs[k] - 0.5));
      const cB = Math.min(W - 1, Math.floor(xs[k + 1] - 0.5));
      for (let c = cA; c <= cB; c++) out[base + c] = 1;
    }
  }
}
function rasterPolylineSupercover(pts, out, W, H) {
  const mark = (cx, cy) => { if (cx >= 0 && cx < W && cy >= 0 && cy < H) out[cy * W + cx] = 1; };
  for (let s = 0; s + 1 < pts.length; s++) {
    const x0 = pts[s][0], y0 = pts[s][1], x1 = pts[s + 1][0], y1 = pts[s + 1][1];
    const dX = x1 - x0, dY = y1 - y0;
    let ix = Math.floor(x0), iy = Math.floor(y0);
    const ixe = Math.floor(x1), iye = Math.floor(y1);
    const stepX = dX > 0 ? 1 : (dX < 0 ? -1 : 0);
    const stepY = dY > 0 ? 1 : (dY < 0 ? -1 : 0);
    const tdX = dX !== 0 ? Math.abs(1 / dX) : Infinity;
    const tdY = dY !== 0 ? Math.abs(1 / dY) : Infinity;
    let tmX = dX !== 0 ? ((stepX > 0 ? ix + 1 : ix) - x0) / dX : Infinity;
    let tmY = dY !== 0 ? ((stepY > 0 ? iy + 1 : iy) - y0) / dY : Infinity;
    mark(ix, iy);
    let guard = Math.abs(ixe - ix) + Math.abs(iye - iy) + 4;
    while ((ix !== ixe || iy !== iye) && guard-- > 0) {
      if (tmX < tmY) { tmX += tdX; ix += stepX; } else { tmY += tdY; iy += stepY; }
      mark(ix, iy);
    }
  }
}
function assembleRings(segments) {
  const tol = 1e-7;
  const near = (a, b) => Math.abs(a[0] - b[0]) < tol && Math.abs(a[1] - b[1]) < tol;
  const rings = [], open = [];
  for (const s of segments) {
    if (s.length >= 3 && near(s[0], s[s.length - 1])) rings.push(s);
    else if (s.length >= 2) open.push(s.slice());
  }
  while (open.length) {
    let chain = open.pop();
    let grew = true;
    while (grew && !near(chain[0], chain[chain.length - 1])) {
      grew = false;
      for (let i = 0; i < open.length; i++) {
        const s = open[i], head = chain[0], tail = chain[chain.length - 1];
        if (near(tail, s[0]))               chain = chain.concat(s.slice(1));
        else if (near(tail, s[s.length - 1])) chain = chain.concat(s.slice().reverse().slice(1));
        else if (near(head, s[s.length - 1])) chain = s.slice(0, -1).concat(chain);
        else if (near(head, s[0]))          chain = s.slice().reverse().slice(0, -1).concat(chain);
        else continue;
        open.splice(i, 1); grew = true; break;
      }
    }
    if (chain.length >= 3 && near(chain[0], chain[chain.length - 1])) rings.push(chain);
  }
  return rings;
}
function fillSeaFromCoastlines(coastlines, data, W, H) {
  if (!coastlines || !coastlines.length) return 0;
  for (const line of coastlines) rasterPolylineSupercover(line, data, W, H);
  const xs = [];
  for (let ry = 0; ry < H; ry++) {
    const yc = ry + 0.5;
    xs.length = 0;
    for (const line of coastlines) for (let i = 0; i + 1 < line.length; i++) {
      const y0 = line[i][1], y1 = line[i + 1][1];
      if ((y0 > yc) !== (y1 > yc)) { const x0 = line[i][0], x1 = line[i + 1][0];
        xs.push({ p: x0 + (yc - y0) / (y1 - y0) * (x1 - x0), sea: y1 < y0 }); }
    }
    if (!xs.length) continue;
    xs.sort((a, b) => a.p - b.p);
    const base = ry * W;
    let k = -1;
    for (let c = 0; c < W; c++) {
      const cx = c + 0.5;
      while (k + 1 < xs.length && xs[k + 1].p <= cx) k++;
      if (k >= 0 ? xs[k].sea : !xs[0].sea) data[base + c] = 1;
    }
  }
  for (let cx = 0; cx < W; cx++) {
    const xc = cx + 0.5;
    xs.length = 0;
    for (const line of coastlines) for (let i = 0; i + 1 < line.length; i++) {
      const x0 = line[i][0], x1 = line[i + 1][0];
      if ((x0 > xc) !== (x1 > xc)) { const y0 = line[i][1], y1 = line[i + 1][1];
        xs.push({ p: y0 + (xc - x0) / (x1 - x0) * (y1 - y0), sea: x1 > x0 }); }
    }
    if (!xs.length) continue;
    xs.sort((a, b) => a.p - b.p);
    let k = -1;
    for (let r = 0; r < H; r++) {
      const cy = r + 0.5;
      while (k + 1 < xs.length && xs[k + 1].p <= cy) k++;
      if (k >= 0 ? xs[k].sea : !xs[0].sea) data[r * W + cx] = 1;
    }
  }
  let filled = 0; for (let i = 0, N = W * H; i < N; i++) if (data[i]) filled++;
  return filled;
}

// ---- harness -------------------------------------------------------------
let passed = 0, failed = 0;
const ok = (cond, msg) => { if (cond) { passed++; } else { failed++; console.error("  FAIL:", msg); } };
const at = (d, W, c, r) => d[r * W + c];

// 1. supercover diagonal is 4-connected (no diagonal-only gap a route could slip through)
{
  const W = 8, H = 8, d = new Uint8Array(W * H);
  rasterPolylineSupercover([[0.5, 0.5], [6.5, 6.5]], d, W, H);
  // a 45° diagonal supercover marks ~2N cells (both corner cells at each step)
  let n = 0; for (const v of d) n += v;
  ok(n >= 12, `diagonal supercover marks 4-connected band (got ${n})`);
  // verify 4-connectivity: every marked cell has a 4-neighbour marked (except ends)
  let lonely = 0;
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) if (at(d, W, c, r)) {
    const nb = (at(d, W, c - 1, r) || 0) + (at(d, W, c + 1, r) || 0) + (c >= 0 && r > 0 ? at(d, W, c, r - 1) : 0) + (r < H - 1 ? at(d, W, c, r + 1) : 0);
    if (!nb) lonely++;
  }
  ok(lonely === 0, `no isolated barrier cell (lonely=${lonely})`);
}

// 2. even-odd fills a square interior
{
  const W = 12, H = 12, d = new Uint8Array(W * H);
  fillRingsEvenOdd([[[2, 2], [9, 2], [9, 9], [2, 9]]], d, W, H);
  ok(at(d, W, 5, 5) === 1, "square interior filled");
  ok(at(d, W, 0, 0) === 0, "outside square not filled");
}

// 3. even-odd with an inner ring leaves a hole (island)
{
  const W = 20, H = 20, d = new Uint8Array(W * H);
  fillRingsEvenOdd([[[2, 2], [17, 2], [17, 17], [2, 17]], [[8, 8], [11, 8], [11, 11], [8, 11]]], d, W, H);
  ok(at(d, W, 4, 4) === 1, "water band (between rings) filled");
  ok(at(d, W, 9, 9) === 0, "island interior (inner ring) is a hole");
}

// 4. assembleRings: unclosed leftover dropped; a proper closed loop kept
{
  const openL = assembleRings([[[0, 0], [4, 0]], [[4, 0], [4, 4]]]); // L-shape, never closes
  ok(openL.length === 0, `unclosed chain dropped (got ${openL.length} rings)`);
  const sq = assembleRings([[[0, 0], [4, 0]], [[4, 0], [4, 4]], [[4, 4], [0, 4]], [[0, 4], [0, 0]]]);
  ok(sq.length === 1 && sq[0].length >= 4, `4 segments stitch into 1 closed ring (got ${sq.length})`);
  const d = new Uint8Array(8 * 8); fillRingsEvenOdd(sq, d, 8, 8);
  ok(at(d, 8, 2, 2) === 1, "stitched ring fills its interior");
}

// 5. SEA-FLOOD ORIENTATION — the load-bearing test.
//    OSM coastline: walking the way, LAND on the LEFT, WATER on the RIGHT.
//    Grid is y-down, so the sea-side normal is (-Dgy, Dgx).
{
  // Coastline running SOUTH (grid down): direction (0,+1) → sea on the WEST.
  const W = 20, H = 10, d = new Uint8Array(W * H);
  const filled = fillSeaFromCoastlines([[[10.5, 0], [10.5, H]]], d, W, H);
  ok(filled > 0, `south-going coastline floods a sea region (got ${filled})`);
  ok(at(d, W, 2, 5) === 1, "WEST of a south-going coastline is sea (right-hand rule)");
  ok(at(d, W, 17, 5) === 0, "EAST of a south-going coastline stays land");

  // Reverse direction (grid up): direction (0,-1) → sea on the EAST.
  const d2 = new Uint8Array(W * H);
  fillSeaFromCoastlines([[[10.5, H], [10.5, 0]]], d2, W, H);
  ok(at(d2, W, 17, 5) === 1, "EAST of a north-going coastline is sea (orientation flips)");
  ok(at(d2, W, 2, 5) === 0, "WEST of a north-going coastline stays land");
}

// 6. closed-loop coastlines — the winding decides which side is water (y-down:
//    sea on the right of travel). Both windings tested end-to-end.
{
  const W = 24, H = 24;
  // CW in y-down → top edge goes east → right normal points south (inward) →
  // water INSIDE (a lake): interior fills, outside stays land.
  const lake = new Uint8Array(W * H);
  fillSeaFromCoastlines([[[6, 6], [18, 6], [18, 18], [6, 18], [6, 6]]], lake, W, H);
  ok(at(lake, W, 12, 12) === 1, "lake winding: enclosed water fills");
  ok(at(lake, W, 1, 1) === 0, "lake winding: outside stays land");
  // Reverse winding → water OUTSIDE (an island): interior stays land, sea beside
  // it (a row that the island crosses) fills. (Far-field corners in rows the
  // coastline never crosses are out of scope — they need surrounding context.)
  const island = new Uint8Array(W * H);
  fillSeaFromCoastlines([[[6, 6], [6, 18], [18, 18], [18, 6], [6, 6]]], island, W, H);
  ok(at(island, W, 1, 12) === 1, "island winding: sea beside the island fills");
  ok(at(island, W, 12, 12) === 0, "island winding: island interior stays land");
}

// 7. border-wall containment — a coastline from the WEST edge to the SOUTH edge
//    cuts off the SW corner as sea. Without the border wall the corner sea would
//    wrap around the open boundary into the bulk; with it, it's contained.
{
  const W = 20, H = 20, d = new Uint8Array(W * H);
  fillSeaFromCoastlines([[[0, 12], [8, 20]]], d, W, H); // sea-side normal points into the SW corner
  ok(at(d, W, 2, 17) === 1, "SW corner (sea side) fills");
  ok(at(d, W, 15, 5) === 0, "NE bulk (land) is NOT leaked into (border wall holds)");
}

console.log(`\n${failed ? "FAIL" : "ALL PASS"} — ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
