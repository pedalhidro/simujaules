// lib/water-raster.js — pure grid rasterisers behind the OSM water →
// impassable mask (group 1C): even-odd ring fill, supercover polyline,
// ring assembly and the coastline sea sweep. Grid coords in, marks out; no
// DOM, no app state. Shared by app.js and test-water-raster.mjs. The async
// time-sliced …Chunked variants stay in app.js (they yield to the main
// thread) and must keep the same per-row/per-sweep math as these.

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
// impassable too. Pure over grid coords (unit-tested).
export function fillSeaFromCoastlines(coastlines, data, W, H) {
  if (!coastlines || !coastlines.length) return 0;
  for (const line of coastlines) rasterPolylineSupercover(line, data, W, H); // shore = impassable edge
  const xs = []; // crossings of the current scan: { p = position along scan, sea = state past it }
  // Horizontal sweep: per ROW, a crossing sets the state to its EAST
  // (north-going coast, grid y decreasing → sea to the east).
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
  // Vertical sweep: per COLUMN, a crossing sets the state to its SOUTH
  // (east-going coast, x increasing → sea to the south).
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
