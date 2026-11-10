// Unit tests for the OSM water-mask rasterisation helpers.
//
// The four functions under test are the REAL implementations, imported from
// lib/water-raster.js (the module app.js uses — no copy to keep in sync).
// They validate the parts that can't be eyeballed: the sea-flood ORIENTATION
// (OSM coastline = land-left/water-right), even-odd hole handling, supercover
// 4-connectivity, and the assembleRings closed-ring gate.
//
//   node test-water-raster.mjs

import {
  fillRingsEvenOdd, rasterPolylineSupercover, assembleRings, fillSeaFromCoastlines,
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
