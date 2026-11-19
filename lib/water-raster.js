// lib/water-raster.js — pure grid rasterisers behind the OSM water →
// impassable mask (group 1C): even-odd ring fill, supercover polyline,
// ring assembly and the coastline sea sweep. Grid coords in, marks out; no
// DOM, no app state. Shared by the app (app/water.js) and
// test-water-raster.mjs. The sea sweep is ONE implementation (a generator the
// app drains in time slices); the app still keeps a hand-mirrored async
// fillRingsEvenOddChunked, which must keep the same per-row math as
// fillRingsEvenOdd here.

// Even-odd scanline fill of a BODY's rings (each [[gx,gy],…]) into `out`
// (1=impassable). All rings of one body fill together, so inner rings (islands)
// cut holes by crossing parity. Clamped to the body's row span; edges/vertices
// outside the grid still contribute correct crossings (only the marks clip).
export function fillRingsEvenOdd(rings, out, W, H) {
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

// Supercover (4-connected) rasterisation of a polyline — every cell the line
// crosses (Amanatides–Woo), so an 8-connected route can't slip across it.
export function rasterPolylineSupercover(pts, out, W, H) {
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

// Stitch open polyline segments (relation members) into closed rings by matching
// endpoints. Already-closed members pass through; even-odd fill wraps the rest.
export function assembleRings(segments) {
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
    // Only emit a CLOSED ring — an unclosed leftover (broken/truncated relation,
    // or a member without geometry) is not a valid area boundary; filling it
    // would fabricate a phantom closing edge and over-mark cells.
    if (chain.length >= 3 && near(chain[0], chain[chain.length - 1])) rings.push(chain);
  }
  return rings;
}

// The open sea/ocean is NOT a fillable polygon in OSM — it's implied by
// natural=coastline ways (directed so LAND is on the LEFT, WATER on the RIGHT).
// Real coastline data has open ends and gaps (river mouths, bbox edges), so a
// flood-fill leaks catastrophically. Instead, fill the sea with orientation
// SWEEPS: each crossing SETS the sea/land state on one side from the crossing's
// travel direction. State is SET locally per span (not toggled), so a missing/
// extra crossing corrupts at most one span instead of cascading. A single sweep
// is blind to coast PARALLEL to it (a N–S scanline can't see an E–W beach), so
// we run BOTH a horizontal and a vertical sweep and UNION them — each resolves
// the coast perpendicular to it (H → bays, V → open ocean). The shore is stamped
// impassable too.
//
// FAR FIELD. A cell whose row AND column both miss every coastline is seen by
// neither sweep — and on a convex coast that is a whole corner of the grid
// (Fortaleza: sea to the north AND east of the Mucuripe cape; the block north
// of the coast's northernmost point × east of its easternmost one stayed open
// sea until v84). Those cells form rectangular blocks (a run of uncrossed rows
// × a run of uncrossed columns) that no coastline enters, and nothing separates
// a block from the crossed lines around it, so each cell takes the state of the
// nearest crossed line on each side — the row above/below (horizontal sweep)
// and the column left/right (vertical sweep) — by majority, a tie going to sea
// like the union above. Per CELL, not per block: beyond the open end of a
// coastline this continues the shore straight on instead of flooding or drying
// the whole block.
//
// IN-GRID ONLY. A crossing outside the grid is ignored. A bbox query returns
// every coastline way that touches the grid, each with its FULL geometry — so
// inside the grid the coastline is complete, but outside it is a set of loose
// ends: the way that carries the next crossing of a scan line may simply not
// have been returned. Trusting such a crossing painted a 1-cell "sea" wall down
// the whole grid (measured near Fortaleza: a groyne at the top edge whose
// return leg was in a way just outside the DEM). Scan lines left without an
// in-grid crossing are far field, resolved from complete data like the rest.
//
// ONE implementation, two drivers: seaSweepSteps is a generator that yields
// between scan lines; fillSeaFromCoastlines drains it synchronously, and the
// app drains the same generator with time-sliced awaits (a big mask must not
// freeze the tab). Pure over grid coords (unit-tested).

// One orientation sweep. axis 0: per ROW, a crossing sets the state to its EAST
// (north-going coast, grid y decreasing → sea to the east). axis 1: per COLUMN,
// a crossing sets the state to its SOUTH (east-going coast, x increasing → sea
// to the south). Returns the runs of scan lines that no coastline crosses, each
// with the sea/land state (1/0 along the line) of the crossed line just before
// and just after it — null at a grid edge.
function* sweepAxis(coastlines, data, W, H, axis) {
  const nScan = axis ? W : H, nAlong = axis ? H : W;
  const s = axis ? 0 : 1, a = 1 - s;            // point index of the scan / along coordinate
  const scanStride = axis ? 1 : W, alongStride = axis ? W : 1;
  const xs = [];                                // crossings of the current scan: { p = position along it, sea = state past it }
  const runs = [];
  const state = new Uint8Array(nAlong);         // state of the last crossed scan line
  let have = false, open = null;
  for (let i = 0; i < nScan; i++) {
    const sc = i + 0.5;
    xs.length = 0;
    for (const line of coastlines) for (let k = 0; k + 1 < line.length; k++) {
      const s0 = line[k][s], s1 = line[k + 1][s];
      if ((s0 > sc) !== (s1 > sc)) { const a0 = line[k][a], a1 = line[k + 1][a];
        const p = a0 + (sc - s0) / (s1 - s0) * (a1 - a0);
        if (p >= 0 && p <= nAlong) xs.push({ p, sea: axis ? s1 > s0 : s1 < s0 }); } // in-grid crossings only — see IN-GRID ONLY
    }
    if (!xs.length) {
      if (open) open.b = i;
      else open = { a: i, b: i, before: have ? state.slice() : null, after: null };
    } else {
      xs.sort((u, v) => u.p - v.p);
      const base = i * scanStride;
      let k = -1;
      for (let j = 0; j < nAlong; j++) {
        const cj = j + 0.5;
        while (k + 1 < xs.length && xs[k + 1].p <= cj) k++;
        const sea = (k >= 0 ? xs[k].sea : !xs[0].sea) ? 1 : 0;
        state[j] = sea;
        if (sea) data[base + j * alongStride] = 1;
      }
      have = true;
      if (open) { open.after = state.slice(); runs.push(open); open = null; }
    }
    yield;
  }
  if (open) runs.push(open);
  return runs;
}

// The whole sea fill as a generator (see the note above). Marks `data` in
// place; yields after each coastline stamp, scan line and far-field row.
export function* seaSweepSteps(coastlines, data, W, H) {
  if (!coastlines || !coastlines.length) return;
  for (const line of coastlines) { rasterPolylineSupercover(line, data, W, H); yield; } // shore = impassable edge
  const rowRuns = yield* sweepAxis(coastlines, data, W, H, 0);
  const colRuns = yield* sweepAxis(coastlines, data, W, H, 1);
  // Far field: uncrossed rows × uncrossed columns.
  for (const rr of rowRuns) for (const cr of colRuns) {
    const nRow = (rr.before ? 1 : 0) + (rr.after ? 1 : 0);
    const nCol = (cr.before ? 1 : 0) + (cr.after ? 1 : 0);
    const n = nRow + nCol;
    if (!n) continue;                           // no crossed line on any side: nothing to go by
    for (let r = rr.a; r <= rr.b; r++) {
      const base = r * W;
      const side = (cr.before ? cr.before[r] : 0) + (cr.after ? cr.after[r] : 0);
      for (let c = cr.a; c <= cr.b; c++) {
        const sea = side + (rr.before ? rr.before[c] : 0) + (rr.after ? rr.after[c] : 0);
        if (2 * sea >= n) data[base + c] = 1;
      }
      yield;
    }
  }
}

// Synchronous driver. Returns the number of marked cells in `data`.
export function fillSeaFromCoastlines(coastlines, data, W, H) {
  if (!coastlines || !coastlines.length) return 0;
  for (const _ of seaSweepSteps(coastlines, data, W, H)) { /* run to completion */ }
  let filled = 0; for (let i = 0, N = W * H; i < N; i++) if (data[i]) filled++;
  return filled;
}
