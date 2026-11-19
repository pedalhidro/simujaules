// Unit tests for the OSM water-mask rasterisation helpers.
//
// The functions under test are the REAL implementations, imported from
// lib/water-raster.js (the module the app uses — no copy to keep in sync).
// They validate the parts that can't be eyeballed: the sea-fill ORIENTATION
// (OSM coastline = land-left/water-right), its FAR FIELD (cells whose row and
// column both miss the coastline — a whole corner of the grid on a convex
// coast), the in-grid-only rule, even-odd hole handling, supercover
// 4-connectivity, and the assembleRings closed-ring gate.
//
//   node test-water-raster.mjs

import {
  fillRingsEvenOdd, rasterPolylineSupercover, assembleRings, fillSeaFromCoastlines, seaSweepSteps,
} from "./lib/water-raster.js";

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
  // it (a row that the island crosses) fills — and so do the four far-field
  // corners, whose rows AND columns never cross the island (until v84 they
  // stayed open: no sweep sees them).
  const island = new Uint8Array(W * H);
  fillSeaFromCoastlines([[[6, 6], [6, 18], [18, 18], [18, 6], [6, 6]]], island, W, H);
  ok(at(island, W, 1, 12) === 1, "island winding: sea beside the island fills");
  ok(at(island, W, 12, 12) === 0, "island winding: island interior stays land");
  for (const [c, r] of [[1, 1], [22, 1], [1, 22], [22, 22]]) {
    ok(at(island, W, c, r) === 1, `island winding: far-field corner (${c},${r}) is sea`);
    ok(at(lake, W, c, r) === 0, `lake winding: far-field corner (${c},${r}) stays land`);
  }
  let land = 0; for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) if (!at(island, W, c, r)) land++;
  ok(land === 11 * 11, `island: exactly the interior stays land (got ${land} cells; cols/rows 7..17 = 121 — the shore ring is stamped)`);
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

// 8. FAR FIELD on a convex coast — the Fortaleza case. Sea to the NORTH and
//    EAST of a cape: the coastline runs north up the east coast, then west along
//    the north shore (land on the left throughout), leaving through the south
//    and west edges. Every cell north of the coast's northernmost point AND
//    east of its easternmost one has no crossing in its row or its column, so
//    neither sweep sees it; it must still come out as sea.
{
  const W = 40, H = 40, d = new Uint8Array(W * H);
  const cape = [[30, 40], [28, 20], [10, 16], [0, 14]];
  fillSeaFromCoastlines([cape], d, W, H);
  ok(at(d, W, 35, 5) === 1, "cape: NE corner (uncrossed row × uncrossed column) is sea");
  ok(at(d, W, 39, 0) === 1 && at(d, W, 30, 13) === 1, "cape: the whole NE block is sea, corner to corner");
  ok(at(d, W, 5, 5) === 1, "cape: sea north of the north shore (vertical sweep)");
  ok(at(d, W, 36, 30) === 1, "cape: sea east of the east coast (horizontal sweep)");
  ok(at(d, W, 5, 30) === 0 && at(d, W, 20, 35) === 0, "cape: land SW of the coast stays land");
  // Cell-exact against the land polygon (coast closed through the SW corner),
  // away from the stamped shore.
  const landPoly = new Uint8Array(W * H), shore = new Uint8Array(W * H);
  fillRingsEvenOdd([[...cape, [0, 40]]], landPoly, W, H);
  rasterPolylineSupercover(cape, shore, W, H);
  let wrong = 0;
  for (let i = 0; i < W * H; i++) if (!shore[i] && d[i] === landPoly[i]) wrong++;
  ok(wrong === 0, `cape: sea ≡ complement of the land polygon off the shore (${wrong} cells differ)`);
  // Same coast, the other three ways round (rotate the grid by 90° steps): the
  // far-field block moves to each corner in turn.
  for (let q = 1; q < 4; q++) {
    const rot = (p) => { let [x, y] = p; for (let k = 0; k < q; k++) [x, y] = [W - y, x]; return [x, y]; };
    const dq = new Uint8Array(W * H), lp = new Uint8Array(W * H), sh = new Uint8Array(W * H);
    const line = cape.map(rot);
    fillSeaFromCoastlines([line], dq, W, H);
    fillRingsEvenOdd([[...line, rot([0, 40])]], lp, W, H);
    rasterPolylineSupercover(line, sh, W, H);
    let bad = 0, sea = 0;
    for (let i = 0; i < W * H; i++) { sea += dq[i]; if (!sh[i] && dq[i] === lp[i]) bad++; }
    ok(bad === 0 && sea > W * H / 2, `cape rotated ${q * 90}°: sea ≡ complement of the land polygon (${bad} cells differ)`);
  }
}

// 9. far field is resolved per CELL, not per block: beyond the open END of a
//    coastline the shore carries straight on (it neither floods nor dries the
//    whole block).
{
  const W = 20, H = 20, d = new Uint8Array(W * H);
  fillSeaFromCoastlines([[[0, 10], [10, 10]]], d, W, H); // east-going → sea to the SOUTH; ends mid-grid
  ok(at(d, W, 4, 15) === 1 && at(d, W, 4, 4) === 0, "open-ended coast: sea south / land north where it is mapped");
  ok(at(d, W, 15, 15) === 1, "open-ended coast: sea continues south of the line beyond its end");
  ok(at(d, W, 15, 4) === 0, "open-ended coast: land continues north of the line beyond its end");
}

// 10. IN-GRID ONLY. A bbox query returns whole ways, so outside the grid the
//     coastline is a set of loose ends. Here the shore runs west just ABOVE the
//     grid (sea to the north — the whole grid is land) and only dips into it at
//     a tiny inlet near x=17, which is why its way is returned at all. Further
//     west a groyne leans across column 10: out leg north-west, return leg
//     south-east, and the returned way ENDS at the groyne's foot — the way that
//     carries the shore's next crossing of that column lies outside the grid and
//     was not returned. The last crossing left on column 10 is the return leg's
//     ("sea to the south"), and trusting it painted the column as sea from top
//     to bottom: a one-cell wall across the land (seen near Fortaleza).
{
  const W = 20, H = 20, d = new Uint8Array(W * H);
  const shore = [[19.9, -1], [17.2, -1], [17, 0.8], [16.8, -1], [10.7, -1], [10.3, -6], [10.6, -1.2]];
  fillSeaFromCoastlines([shore], d, W, H);
  let col = 0; for (let r = 0; r < H; r++) col += at(d, W, 10, r);
  ok(col === 0, `out-of-grid crossing ignored: no "sea" wall down column 10 (${col} of ${H} cells marked)`);
  let marked = 0; for (const v of d) marked += v;
  ok(marked === 2 && at(d, W, 16, 0) === 1 && at(d, W, 17, 0) === 1,
    `out-of-grid crossing ignored: only the inlet's two shore cells are marked (${marked} cells)`);
}

// 11. nothing to go by → nothing marked: no coastline, and a coastline that
//     never crosses a row or column centre inside the grid.
{
  const W = 12, H = 12;
  ok(fillSeaFromCoastlines([], new Uint8Array(W * H), W, H) === 0, "no coastline: nothing filled");
  ok(fillSeaFromCoastlines(null, new Uint8Array(W * H), W, H) === 0, "null coastlines: nothing filled");
  const d = new Uint8Array(W * H);
  fillSeaFromCoastlines([[[5.6, 5.6], [5.9, 5.9]]], d, W, H); // inside one cell, crosses no centre line
  let n = 0; for (const v of d) n += v;
  ok(n === 1, `sub-cell coastline: only its own shore cell is stamped (got ${n})`);
}

// 12. the far field is decided by the SWEEPS' states, not by what is already in
//     the mask: lakes/rivers rasterised before the sea fill must not leak.
{
  const W = 40, H = 40, d = new Uint8Array(W * H), ref = new Uint8Array(W * H);
  const cape = [[30, 40], [28, 20], [10, 16], [0, 14]];
  fillSeaFromCoastlines([cape], ref, W, H);
  for (let r = 25; r < 30; r++) for (let c = 5; c < 12; c++) d[r * W + c] = 1; // a lake on land
  fillSeaFromCoastlines([cape], d, W, H);
  let diff = 0;
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    const lake = r >= 25 && r < 30 && c >= 5 && c < 12;
    if (at(d, W, c, r) !== (lake ? 1 : at(ref, W, c, r))) diff++;
  }
  ok(diff === 0, `pre-marked water does not change the sea fill (${diff} cells differ)`);
}

// 13. ONE implementation: the generator the app drains in time slices and the
//     synchronous driver give the same bytes, and the generator does yield.
{
  const W = 40, H = 40, a = new Uint8Array(W * H), b = new Uint8Array(W * H);
  const lines = [[[30, 40], [28, 20], [10, 16], [0, 14]], [[33, 6], [33, 9], [36, 9], [36, 6], [33, 6]]]; // cape + an islet
  fillSeaFromCoastlines(lines, a, W, H);
  let steps = 0;
  for (const _step of seaSweepSteps(lines, b, W, H)) steps++;
  let diff = 0; for (let i = 0; i < W * H; i++) if (a[i] !== b[i]) diff++;
  ok(diff === 0, `seaSweepSteps ≡ fillSeaFromCoastlines (${diff} cells differ)`);
  ok(steps >= W + H, `seaSweepSteps yields between scan lines (${steps} steps)`);
  ok(at(a, W, 34, 7) === 0 && at(a, W, 38, 2) === 1, "islet off the cape: interior land, far-field sea around it");
}

console.log(`\n${failed ? "FAIL" : "ALL PASS"} — ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
