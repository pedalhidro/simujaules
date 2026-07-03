// graph-engine.js — vector-network graph routing for Simujoules ("follow the
// vectors" mode). Pure module: NO DOM, NO worker globals. Loaded two ways:
//   • importScripts("graph-engine.js") inside the classic energy-worker, which
//     exposes `self.GraphEngine`;
//   • `import GraphEngine from "./graph-engine.js"` from test-graph-engine.mjs
//     (Node treats this extension-less-package .js as CommonJS, so the UMD
//     footer's module.exports is what the test receives).
//
// It mirrors energy-worker.js's asymmetric cost model EXACTLY so a graph edge
// that happens to be axis-aligned costs the same as the equivalent grid step
// (test-graph-engine.mjs asserts this parity). The difference is topological:
// routing happens on the real polyline graph instead of an 8-connected raster,
// so passes follow the vectors with no staircase / corner-cutting.
//
// Coordinate convention: the engine works entirely in FRACTIONAL CELL space
// (row, col). app.js converts network vertices (lat/lng or projected) → (r, c)
// before buildGraph, and converts node (r, c) → lat/lng for rendering. Metric
// distances use the DEM's dxM/dyM (metres per cell); elevations come from a
// bilinear sample of the DEM height grid. This keeps the engine agnostic to the
// DEM's CRS — all the projection logic stays in app.js where it already lives.

(function (root) {
  "use strict";

  // ----------------------------------------------------------------- heap ----
  // Monotone radix heap on the raw f64 bits of a non-negative key — the same
  // structure energy-worker.js uses (O(1) push, amortised O(64) pop, EXACT
  // minima). Dijkstra's keys are monotone non-decreasing with ≥0 weights, the
  // one precondition it needs. Factory form so each search gets a fresh heap.
  function makeRadixHeap() {
    const _ub = new ArrayBuffer(8), _uf = new Float64Array(_ub), _u32 = new Uint32Array(_ub);
    const NB = 65;
    const bPri = [], bVal = [], bLen = new Int32Array(NB);
    for (let i = 0; i < NB; i++) { bPri.push(new Float64Array(16)); bVal.push(new Int32Array(16)); }
    let lastHi = 0, lastLo = 0, rlen = 0;
    const bucketOf = (p) => {
      _uf[0] = p; const hi = _u32[1], lo = _u32[0];
      const xh = hi ^ lastHi; if (xh !== 0) return 33 + (31 - Math.clz32(xh));
      const xl = lo ^ lastLo; if (xl === 0) return 0; return 1 + (31 - Math.clz32(xl));
    };
    const h = {
      pri: 0, val: 0,
      clear() { for (let i = 0; i < NB; i++) bLen[i] = 0; lastHi = 0; lastLo = 0; rlen = 0; },
      get size() { return rlen; },
      push(p, v) {
        const b = bucketOf(p); let L = bLen[b];
        if (L >= bPri[b].length) { const a = new Float64Array(L * 2); a.set(bPri[b]); bPri[b] = a; const c = new Int32Array(L * 2); c.set(bVal[b]); bVal[b] = c; }
        bPri[b][L] = p; bVal[b][L] = v; bLen[b] = L + 1; rlen++;
      },
      pop() {
        if (rlen === 0) return false;
        if (bLen[0] === 0) {
          let i = 1; while (bLen[i] === 0) i++;
          const pr = bPri[i], va = bVal[i], L = bLen[i];
          let mn = pr[0]; for (let j = 1; j < L; j++) if (pr[j] < mn) mn = pr[j];
          _uf[0] = mn; lastHi = _u32[1]; lastLo = _u32[0];
          for (let j = 0; j < L; j++) {
            const p = pr[j], v = va[j]; const b = bucketOf(p); let M = bLen[b];
            if (M >= bPri[b].length) { const a = new Float64Array(M * 2); a.set(bPri[b]); bPri[b] = a; const c = new Int32Array(M * 2); c.set(bVal[b]); bVal[b] = c; }
            bPri[b][M] = p; bVal[b][M] = v; bLen[b] = M + 1;
          }
          bLen[i] = 0;
        }
        const L = bLen[0] - 1; this.pri = bPri[0][L]; this.val = bVal[0][L]; bLen[0] = L; rlen--; return true;
      },
    };
    return h;
  }

  // -------------------------------------------------------------- sampling ----
  // Bilinear DEM elevation at fractional (r, c). REGISTRATION: app.js's
  // fractional-cell convention puts cell (r, c)'s DEM value at the cell CENTRE
  // (r + 0.5, c + 0.5) — integer coords are cell CORNERS (see app.js
  // latLngToCellFrac / pixelToLatLng). So we shift by −0.5 into array space
  // (where height[r*W+c] sits at integer (r, c)) before interpolating:
  // sampling a cell centre returns exactly that cell's value, a corner the
  // 4-neighbour average. Mask-aware: corners that are nodata (mask 0) are
  // dropped from the weighted average; if all four are nodata we fall back to
  // the floor cell's raw height (the network shouldn't sit on nodata, but we
  // stay finite rather than poison the cost with NaN).
  function sampleHeight(height, mask, H, W, r, c) {
    r -= 0.5; c -= 0.5; // fractional-cell → array space (values at cell centres)
    if (r < 0) r = 0; else if (r > H - 1) r = H - 1;
    if (c < 0) c = 0; else if (c > W - 1) c = W - 1;
    const r0 = Math.floor(r), c0 = Math.floor(c);
    const r1 = r0 + 1 < H ? r0 + 1 : r0, c1 = c0 + 1 < W ? c0 + 1 : c0;
    const fr = r - r0, fc = c - c0;
    const idx = [r0 * W + c0, r0 * W + c1, r1 * W + c0, r1 * W + c1];
    const wt = [(1 - fr) * (1 - fc), (1 - fr) * fc, fr * (1 - fc), fr * fc];
    let acc = 0, wsum = 0;
    for (let k = 0; k < 4; k++) {
      const i = idx[k];
      if (mask && !mask[i]) continue;
      acc += height[i] * wt[k]; wsum += wt[k];
    }
    if (wsum > 0) return acc / wsum;
    return height[r0 * W + c0];
  }

  // ----------------------------------------------------------- cost model ----
  // ONE step of the v2 per-edge leg-energy cost, identical to energy-worker.js's
  // v2Edge (and backend/src/main.rs::v2_edge). `c` is the cost bundle
  // { aRoll, aAero, beta, climbThr, abRatio, epsOffset }.
  function stepCost(d, dh, c) {
    if (dh >= 0) {
      const aero = (dh < c.climbThr * d) ? c.aAero * d : 0;
      return c.aRoll * d + aero + c.beta * dh;
    }
    const ndh = -dh;
    let eps = c.abRatio * d / ndh;
    if (eps > 1) eps = 1;
    eps -= c.epsOffset;
    if (eps < 0) eps = 0;
    const e = c.aRoll * d + c.aAero * d - eps * c.beta * ndh;
    return e < 0 ? 0 : e;
  }

  // Walk an edge's stored elevation profile (samples h[0..n] from A→B, equal
  // metric steps of stepM) and sum the per-step cost. `forward` false walks
  // B→A. Per-STEP application of the downhill floor is what keeps parity with
  // the grid model (the floor is non-linear, so a closed-form on Σdh is wrong).
  function profileCost(prof, off, n, stepM, forward, c) {
    let total = 0;
    if (forward) {
      for (let i = 0; i < n; i++) total += stepCost(stepM, prof[off + i + 1] - prof[off + i], c);
    } else {
      for (let i = n; i > 0; i--) total += stepCost(stepM, prof[off + i - 1] - prof[off + i], c);
    }
    return total;
  }

  // --------------------------------------------------------- planarization ----
  // Proper intersection of segments (p1→p2) and (p3→p4) in (row,col) space.
  // Returns {t, u} parametric positions in (eps, 1-eps) on each, or null. Shared
  // endpoints (t or u at 0/1) are excluded so touching lines aren't "split".
  function segIntersect(r1, c1, r2, c2, r3, c3, r4, c4, eps) {
    const dr1 = r2 - r1, dc1 = c2 - c1, dr2 = r4 - r3, dc2 = c4 - c3;
    const den = dr1 * dc2 - dc1 * dr2;
    if (den === 0 || Math.abs(den) < 1e-12) return null; // parallel/degenerate
    const t = ((r3 - r1) * dc2 - (c3 - c1) * dr2) / den;
    const u = ((r3 - r1) * dc1 - (c3 - c1) * dr1) / den;
    if (t <= eps || t >= 1 - eps || u <= eps || u >= 1 - eps) return null;
    return { t, u };
  }

  // Phase C — deck CHAINS: OSM often splits one physical bridge into several
  // consecutive ways, and per-way flattening V-dips the deck to the DEM at
  // every shared joint (the per-way endpoints sample the ground UNDER the
  // deck). So: group deck lines that share an endpoint (within snapTol) at the
  // SAME layer into chains, and re-flatten every SIMPLE chain (a path — no
  // 3+-way deck junction, no cycle; those fall back to per-way) as ONE deck:
  // linear between the ground elevations at the chain's two OUTER endpoints,
  // arc-length parameterised across the whole chain. Members keep their
  // per-line { h0, h1, total } shape (h0/h1 become the chain line evaluated at
  // the member's own ends, orientation-corrected), so the flattening in
  // buildGraph's emit loop needs no change. Single-way decks are untouched.
  function chainDeckFlattening(lines, lineMeta, deckOf, snapTol) {
    // Endpoint identity: the same quantisation nodeOf uses, PLUS the layer so
    // decks at different levels never chain through a shared (x, y).
    const keyOf = (li, p) => (lineMeta[li].layer || 0) + "|" + Math.round(p[0] / snapTol) + "|" + Math.round(p[1] / snapTol);
    const ends = new Map(); // key -> [{ li, end }] (end 0 = first vertex, 1 = last)
    const deckLis = [];
    for (let li = 0; li < lines.length; li++) {
      if (!deckOf[li]) continue;
      deckLis.push(li);
      const ln = lines[li];
      for (const end of [0, 1]) {
        const k = keyOf(li, ln[end === 0 ? 0 : ln.length - 1]);
        let a = ends.get(k); if (!a) { a = []; ends.set(k, a); } a.push({ li, end });
      }
    }
    if (deckLis.length < 2) return;
    // Connected components over shared-endpoint adjacency.
    const seen = new Set();
    for (const li0 of deckLis) {
      if (seen.has(li0)) continue;
      const compLines = [], compKeys = new Set(), stack = [li0];
      seen.add(li0);
      while (stack.length) {
        const li = stack.pop();
        compLines.push(li);
        const ln = lines[li];
        for (const p of [ln[0], ln[ln.length - 1]]) {
          const k = keyOf(li, p);
          compKeys.add(k);
          for (const o of ends.get(k)) if (!seen.has(o.li)) { seen.add(o.li); stack.push(o.li); }
        }
      }
      if (compLines.length < 2) continue; // single way — today's behaviour
      // Simple path ⇔ every endpoint has ≤2 incident deck ends AND there are
      // exactly n+1 endpoints for n lines (a cycle has n). Otherwise per-way.
      let simple = compKeys.size === compLines.length + 1;
      let start = null;
      for (const k of compKeys) {
        const deg = ends.get(k).length;
        if (deg > 2) { simple = false; break; }
        if (deg === 1) start = k;
      }
      if (!simple || start === null) continue;
      // Walk the chain from one degree-1 end, recording each member's
      // orientation (forward = entered at its first vertex).
      const walk = []; // { li, forward, len }
      const used = new Set();
      let cur = start;
      while (true) {
        const next = ends.get(cur).find((o) => !used.has(o.li));
        if (!next) break;
        used.add(next.li);
        const ln = lines[next.li];
        walk.push({ li: next.li, forward: next.end === 0, len: deckOf[next.li].total });
        cur = keyOf(next.li, ln[next.end === 0 ? ln.length - 1 : 0]);
      }
      if (walk.length !== compLines.length) continue; // defensive: keep per-way
      // Elevations at the chain's two OUTER endpoints. Reuse the terminal
      // members' OWN (pre-chain) deckOf.h0/h1 rather than re-sampling the
      // DEM: those already prefer a mapped OSM `ele` tag over sampleHeight
      // (see the deckOf construction above), so a chain whose outer ways
      // carry surveyed elevations stays consistent with that preference
      // instead of silently reverting to the DEM. h0 corresponds to the
      // line's own first vertex, h1 to its last — orientation-match via
      // `forward` the same way pA/pB used to (the actual vertex coords,
      // still implicit in `deckOf`'s own h0/h1 assignment).
      const first = walk[0], last = walk[walk.length - 1];
      const gA = first.forward ? deckOf[first.li].h0 : deckOf[first.li].h1;
      const gB = last.forward ? deckOf[last.li].h1 : deckOf[last.li].h0;
      let total = 0; for (const w of walk) total += w.len;
      if (!(total > 0)) total = 1;
      // Rewrite each member's h0/h1 from its position along the chain.
      let arc = 0;
      for (const w of walk) {
        const hIn = gA + (gB - gA) * (arc / total);
        const hOut = gA + (gB - gA) * ((arc + w.len) / total);
        const d = deckOf[w.li];
        if (w.forward) { d.h0 = hIn; d.h1 = hOut; } else { d.h0 = hOut; d.h1 = hIn; }
        arc += w.len;
      }
    }
  }

  // Build the routable graph from network polylines (each line = array of
  // [r, c] or [r, c, z] fractional-cell vertices). junctionMode:
  //   "shared"   — edges connect only where lines share a snapped vertex.
  //   "crossings"— additionally split segments at computed intersections
  //                (spatial-hash candidate search), so at-grade crossings route.
  // opts: { junctionMode, snapTolCells=0.5, stepCells=1, zTol=1, eps=1e-9 }.
  function buildGraph(lines, dem, opts) {
    opts = opts || {};
    const junctionMode = opts.junctionMode === "shared" ? "shared" : "crossings";
    const snapTol = opts.snapTolCells > 0 ? opts.snapTolCells : 0.5;
    const stepCells = opts.stepCells > 0 ? opts.stepCells : 1;
    const zTol = opts.zTol != null ? opts.zTol : 1;
    const eps = opts.eps != null ? opts.eps : 1e-9;
    const { height, mask, H, W, dxM, dyM } = dem;

    // Phase C — per-line bridge/tunnel metadata: lineMeta[li] = { deck, layer }.
    // For each DECK (bridge/tunnel) line, precompute its two ground-endpoint
    // elevations + total cell-length so its edges can be flattened to a straight
    // deck, and use `layer` to suppress false junctions where a deck crosses a
    // way at a different level.
    const lineMeta = opts.lineMeta || null;
    const deckOf = []; // li -> { h0, h1, total } for deck lines, else undefined
    if (lineMeta) {
      for (let li = 0; li < lines.length; li++) {
        const m = lineMeta[li];
        if (!m || !m.deck) continue;
        const ln = lines[li];
        if (ln.length < 2) continue;
        // A mapped OSM `ele` tag (surveyed deck elevation) takes precedence
        // over the DEM sample at the deck's own ends — the DEM can be
        // contaminated under large viaducts (FABDEM leakage), and this keeps
        // the graph engine's deck cost in agreement with the raster portal
        // model (app.js buildPortalAdj also prefers ele over the DEM). Absent
        // ele (undefined/NaN, e.g. the .gpkg live-load path, which never sets
        // eleA/eleB) reproduces today's sampleHeight-only behaviour exactly.
        const h0 = Number.isFinite(m.eleA) ? m.eleA : sampleHeight(height, mask, H, W, ln[0][0], ln[0][1]);
        const h1 = Number.isFinite(m.eleB) ? m.eleB : sampleHeight(height, mask, H, W, ln[ln.length - 1][0], ln[ln.length - 1][1]);
        let total = 0;
        for (let k = 0; k + 1 < ln.length; k++) total += Math.hypot(ln[k + 1][0] - ln[k][0], ln[k + 1][1] - ln[k][1]);
        deckOf[li] = { h0, h1, total: total > 0 ? total : 1 };
      }
      // Multi-way bridges: re-flatten simple same-layer deck chains end-to-end
      // (see chainDeckFlattening) so shared joints don't V-dip to the ground.
      chainDeckFlattening(lines, lineMeta, deckOf, snapTol);
    }

    // Flatten polylines into segments [rA,cA,zA, rB,cB,zB, lineId]; segArc0[s]
    // is the arc-length (cells) at the segment's start along its line (for deck
    // flattening — a globally-linear deck is linear on any sub-segment).
    const segs = [];
    const segArc0 = [];
    let anyZ = false;
    for (let li = 0; li < lines.length; li++) {
      const ln = lines[li];
      let arc = 0;
      for (let k = 0; k + 1 < ln.length; k++) {
        const a = ln[k], b = ln[k + 1];
        if (a[0] === b[0] && a[1] === b[1]) continue; // zero-length
        const za = a.length > 2 ? a[2] : NaN, zb = b.length > 2 ? b[2] : NaN;
        if (!Number.isNaN(za) || !Number.isNaN(zb)) anyZ = true;
        segs.push([a[0], a[1], za, b[0], b[1], zb, li]);
        segArc0.push(arc);
        arc += Math.hypot(b[0] - a[0], b[1] - a[1]);
      }
    }

    // Crossings mode: find intersections via a cell-bucket spatial hash, then
    // record split parameters per segment. Skip crossings whose interpolated Z
    // differs by > zTol on the two segments (bridges/overpasses) when Z exists.
    // Each entry in splits[s] is either a plain number t (proper crossing —
    // both segments split at the SAME computed point, so nodeOf's quantised
    // merge unifies them without help) or an override object { t, or, oc }
    // (T-junction cut — nodeOf must key off the touching ENDPOINT's own
    // coordinates, not the perpendicular projection, or the two can round to
    // different quantised nodes; see the T-JUNCTIONS block below).
    const splits = segs.map(() => []); // per seg: list of t | {t,or,oc} in (0,1)
    if (junctionMode === "crossings") {
      // ---- candidate-pair bucket hash --------------------------------------
      // Packed-integer keys over the segments' OWN bounding box (not an
      // assumed worst case), counting-sorted into flat CSR arrays instead of
      // a Map<string,Array> — at the app's 2M-vertex network cap the old
      // string-keyed Map allocated one JS object PER UNIQUE key (~10-20M of
      // them) plus per-segment Set<string> churn; that per-key object
      // allocation, not the key encoding, was the dominant transient-memory
      // cost. The bbox is bounded by the DEM's own cell count (the app
      // already holds height/mask arrays of that size), so the flat count
      // table costs no more than arrays this app already resident-holds; a
      // stray vertex that blows the bbox out anyway (the caller's
      // bbox-intersection prefilter does not clip individual line geometry)
      // falls back to the safe, unbounded string-keyed Map below rather than
      // risk an oversized typed array or aliasing two distinct cells.
      let rMin = Infinity, rMax = -Infinity, cMin = Infinity, cMax = -Infinity;
      for (let s = 0; s < segs.length; s++) {
        const [r1, c1, , r2, c2] = segs[s];
        if (r1 < rMin) rMin = r1; if (r2 < rMin) rMin = r2;
        if (r1 > rMax) rMax = r1; if (r2 > rMax) rMax = r2;
        if (c1 < cMin) cMin = c1; if (c2 < cMin) cMin = c2;
        if (c1 > cMax) cMax = c1; if (c2 > cMax) cMax = c2;
      }
      // Pad by 2: 1 for floor/ceil rounding at the extremes, 1 more for the
      // 3×3 dilation the rasterisation below adds around each sample.
      const rLo = segs.length ? Math.floor(rMin) - 2 : 0, rHi = segs.length ? Math.ceil(rMax) + 2 : 0;
      const cLo = segs.length ? Math.floor(cMin) - 2 : 0, cHi = segs.length ? Math.ceil(cMax) + 2 : 0;
      const rSpan = rHi - rLo + 1, cSpan = cHi - cLo + 1;
      const nCells = rSpan * cSpan;
      const boundedOk = segs.length === 0 || (Number.isFinite(nCells) && nCells > 0 && nCells <= Math.max(4 * H * W, 1 << 20));

      // Rasterise one segment's dilated sample cells, deduped, calling
      // visit(key) once per unique cell. Run twice (count, then fill) so the
      // flat CSR build needs no per-segment array storage between passes.
      const rasterizeSeg = (s, keyOf, visit) => {
        const [r1, c1, , r2, c2] = segs[s];
        const steps = Math.max(1, Math.ceil(Math.abs(r2 - r1)) + Math.ceil(Math.abs(c2 - c1)));
        const seen = new Set(); // de-dupe this segment's own inserts
        for (let i = 0; i <= steps; i++) {
          const rr = Math.floor(r1 + (r2 - r1) * (i / steps));
          const cc = Math.floor(c1 + (c2 - c1) * (i / steps));
          for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
            const key = keyOf(rr + dr, cc + dc);
            if (key == null || seen.has(key)) continue;
            seen.add(key);
            visit(key);
          }
        }
      };

      let bucketHead, bucketItems; // boundedOk path: CSR over packed integer keys
      let bucketMap;               // fallback path: Map<string,Array> (unbounded extent)
      const packedKey = (rr, cc) => (rr - rLo) * cSpan + (cc - cLo);
      if (boundedOk) {
        const counts = new Uint32Array(nCells);
        for (let s = 0; s < segs.length; s++) rasterizeSeg(s, packedKey, (key) => { counts[key]++; });
        bucketHead = new Uint32Array(nCells + 1);
        for (let k = 0; k < nCells; k++) bucketHead[k + 1] = bucketHead[k] + counts[k];
        const cursor = bucketHead.slice(0, nCells); // per-key write position (pass 2)
        bucketItems = new Int32Array(bucketHead[nCells]);
        for (let s = 0; s < segs.length; s++) rasterizeSeg(s, packedKey, (key) => { bucketItems[cursor[key]++] = s; });
      } else {
        bucketMap = new Map(); // "ri|ci" -> [segIdx,…]
        const addBucket = (key, idx) => { let a = bucketMap.get(key); if (!a) { a = []; bucketMap.set(key, a); } a.push(idx); };
        const strKey = (rr, cc) => rr + "|" + cc;
        for (let s = 0; s < segs.length; s++) rasterizeSeg(s, strKey, (key) => addBucket(key, s));
      }
      // Look up candidate segment indices for a raw (unshifted) cell; returns
      // an array (fresh, safe to iterate/discard) or null if empty/out of range.
      const lookupCell = boundedOk
        ? (rr, cc) => {
            const key = packedKey(rr, cc);
            if (key < 0 || key >= nCells) return null;
            const start = bucketHead[key], end = bucketHead[key + 1];
            return end > start ? bucketItems.subarray(start, end) : null;
          }
        : (rr, cc) => bucketMap.get(rr + "|" + cc) || null;

      const tested = new Set();
      if (boundedOk) {
        for (let k = 0; k < nCells; k++) {
          const start = bucketHead[k], end = bucketHead[k + 1];
          if (end - start < 2) continue;
          for (let i = start; i < end; i++) for (let j = i + 1; j < end; j++) {
            testPair(bucketItems[i], bucketItems[j]);
          }
        }
      } else {
        for (const arr of bucketMap.values()) {
          for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) testPair(arr[i], arr[j]);
        }
      }
      function testPair(a, b) {
        if (segs[a][6] === segs[b][6]) return;          // same polyline
        const pk = a < b ? a * segs.length + b : b * segs.length + a;
        if (tested.has(pk)) return; tested.add(pk);
        const A = segs[a], B = segs[b];
        const hit = segIntersect(A[0], A[1], A[3], A[4], B[0], B[1], B[3], B[4], eps);
        if (!hit) return;
        // Phase C: a deck (bridge/tunnel) crossing a way at a DIFFERENT layer
        // is a vertical separation (overpass), not a junction — don't connect.
        if (lineMeta) {
          const mA = lineMeta[A[6]], mB = lineMeta[B[6]];
          if ((mA?.deck || mB?.deck) && ((mA?.layer || 0) !== (mB?.layer || 0))) return;
        }
        if (anyZ) {
          const zA = A[2] + (A[5] - A[2]) * hit.t, zB = B[2] + (B[5] - B[2]) * hit.u;
          if (Number.isFinite(zA) && Number.isFinite(zB) && Math.abs(zA - zB) > zTol) return;
        }
        splits[a].push(hit.t); splits[b].push(hit.u);
      }
      // T-JUNCTIONS: a line VERTEX (endpoint OR interior) resting on another
      // line's segment INTERIOR is a junction too (non-noded .gpkg /
      // hand-drawn networks), but segIntersect only finds PROPER crossings —
      // the touch has u at 0/1 and is skipped, silently splitting the network
      // into components. For each polyline vertex, find segments of OTHER
      // lines passing within snapTol (candidates via the same bucket hash —
      // the vertex's 3×3 neighbourhood covers the segments' own ±1 dilation)
      // and split them at the perpendicular projection Q. The cut node is
      // placed AT the vertex P's own coordinates (an override carried on the
      // split entry), not at Q, so nodeOf's quantised merge is GUARANTEED to
      // unify P with the cut — P and Q can be up to snapTol apart and round
      // to different quantised keys on a per-axis coin flip if the cut were
      // placed at Q instead. Every polyline vertex (not just the two
      // endpoints) is checked: an interior vertex resting on another line's
      // interior is the same failure class one vertex inward, and the emit
      // loop already creates a node at every vertex regardless.
      for (let li = 0; li < lines.length; li++) {
        const ln = lines[li];
        if (ln.length < 2) continue;
        for (let vi = 0; vi < ln.length; vi++) {
          const P = ln[vi];
          const pr = P[0], pc = P[1], pz = P.length > 2 ? P[2] : NaN;
          const rr = Math.floor(pr), cc = Math.floor(pc);
          const cand = new Set();
          for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
            const arr = lookupCell(rr + dr, cc + dc);
            if (arr) for (const s of arr) cand.add(s);
          }
          for (const s of cand) {
            const S = segs[s];
            if (S[6] === li) continue;                      // same polyline
            // Phase C: same suppression rule as the crossing scan — an
            // endpoint touching across DIFFERENT layers (deck over street) is
            // a vertical separation, not a junction.
            if (lineMeta) {
              const mA = lineMeta[li], mB = lineMeta[S[6]];
              if ((mA?.deck || mB?.deck) && ((mA?.layer || 0) !== (mB?.layer || 0))) continue;
            }
            const dr1 = S[3] - S[0], dc1 = S[4] - S[1];
            const len2 = dr1 * dr1 + dc1 * dc1;
            if (len2 === 0) continue;                       // degenerate segment
            const t = ((pr - S[0]) * dr1 + (pc - S[1]) * dc1) / len2;
            if (t <= eps || t >= 1 - eps) continue;         // vertex touch → nodeOf merges already
            const qr = S[0] + dr1 * t, qc = S[1] + dc1 * t;
            const d2 = (pr - qr) * (pr - qr) + (pc - qc) * (pc - qc);
            if (d2 > snapTol * snapTol) continue;
            if (anyZ) {                                     // same z rule as crossings
              const zS = S[2] + (S[5] - S[2]) * t;
              if (Number.isFinite(pz) && Number.isFinite(zS) && Math.abs(pz - zS) > zTol) continue;
            }
            splits[s].push({ t, or: pr, oc: pc });          // cut AT P, not at Q
          }
        }
      }
    }

    // Node identity: snap (r,c) to a quantised grid so coincident endpoints
    // (and intersection points) merge into one node.
    const nodeMap = new Map(); const nodeR = [], nodeC = [];
    const nodeOf = (r, c) => {
      const key = Math.round(r / snapTol) + "|" + Math.round(c / snapTol);
      let id = nodeMap.get(key);
      if (id === undefined) { id = nodeR.length; nodeR.push(r); nodeC.push(c); nodeMap.set(key, id); }
      return id;
    };

    // Emit (sub)edges, deduped by node pair. Each sub-segment is straight, so
    // its rendered geometry is just its two endpoints.
    const edgeMap = new Map(); const edgeA = [], edgeB = [];
    const pushEdge = (na, nb) => {
      if (na === nb) return -1;
      const key = na < nb ? na + "_" + nb : nb + "_" + na;
      let e = edgeMap.get(key);
      if (e === undefined) { e = edgeA.length; edgeA.push(na); edgeB.push(nb); edgeMap.set(key, e); }
      return e;
    };
    // Phase C: deck flattening bookkeeping — nodeDeck holds the deck elevation
    // at each node on a bridge/tunnel line; deckEdges lists those edges so their
    // DEM-sampled profile can be overridden with a straight deck below.
    const nodeDeck = new Map();
    const deckEdges = [];
    for (let s = 0; s < segs.length; s++) {
      const [r1, c1, , r2, c2] = segs[s];
      const deck = deckOf[segs[s][6]];
      const segLenCells = deck ? Math.hypot(r2 - r1, c2 - c1) : 0;
      const ts = splits[s];
      // Normalise mixed plain-number (crossing, no override) / {t,or,oc}
      // (T-junction, override coords = the touching vertex) entries to a
      // common shape, then sort by t; the segment's own endpoints (t=0/1)
      // carry no override — nodeOf must key off the segment's own vertices
      // there, which it already does via the fallback below.
      let cuts;
      if (ts.length === 0) cuts = [{ t: 0 }, { t: 1 }];
      else {
        cuts = ts.map((v) => (typeof v === "number" ? { t: v } : v));
        cuts.sort((x, y) => x.t - y.t);
        cuts.unshift({ t: 0 }); cuts.push({ t: 1 });
      }
      for (let k = 0; k + 1 < cuts.length; k++) {
        const ca = cuts[k], cb = cuts[k + 1];
        const ta = ca.t, tb = cb.t;
        if (tb - ta < eps) continue;
        // T-junction cuts place the node AT the touching vertex's own
        // coordinates (ca.or/oc) — geometrically equivalent (within snapTol
        // of the true perpendicular projection) but GUARANTEED to quantise to
        // the same nodeOf key as that vertex, unlike the projection itself.
        const na = nodeOf(ca.or ?? (r1 + (r2 - r1) * ta), ca.oc ?? (c1 + (c2 - c1) * ta));
        const nb = nodeOf(cb.or ?? (r1 + (r2 - r1) * tb), cb.oc ?? (c1 + (c2 - c1) * tb));
        const e = pushEdge(na, nb);
        if (deck && e >= 0) {
          const arcA = segArc0[s] + ta * segLenCells, arcB = segArc0[s] + tb * segLenCells;
          nodeDeck.set(na, deck.h0 + (deck.h1 - deck.h0) * (arcA / deck.total));
          nodeDeck.set(nb, deck.h0 + (deck.h1 - deck.h0) * (arcB / deck.total));
          deckEdges.push(e);
        }
      }
    }

    const nNodes = nodeR.length, nEdges = edgeA.length;
    const NR = new Float64Array(nodeR), NC = new Float64Array(nodeC);
    const NH = new Float32Array(nNodes);
    // A node is valid only inside the DEM extent AND on a non-nodata cell — the
    // graph analogue of the grid mask. Invalid nodes are never traversed or
    // drawn, so passes/energy can't leak past the DEM (network lines often run
    // off the tile edge).
    const nodeValid = new Uint8Array(nNodes);
    for (let i = 0; i < nNodes; i++) {
      NH[i] = sampleHeight(height, mask, H, W, NR[i], NC[i]);
      const ri = Math.floor(NR[i]), ci = Math.floor(NC[i]);
      const inB = ri >= 0 && ri < H && ci >= 0 && ci < W;
      nodeValid[i] = (inB && (!mask || mask[ri * W + ci])) ? 1 : 0;
    }

    // Per-edge metric length + densified elevation profile (A→B order).
    const EA = new Int32Array(edgeA), EB = new Int32Array(edgeB);
    const edgeLenM = new Float64Array(nEdges);
    const profOff = new Int32Array(nEdges + 1);
    const edgeStepM = new Float64Array(nEdges);
    const tmpProf = [];
    let totalSamples = 0;
    for (let e = 0; e < nEdges; e++) {
      const a = EA[e], b = EB[e];
      const dr = NR[b] - NR[a], dc = NC[b] - NC[a];
      const lenM = Math.hypot(dr * dyM, dc * dxM);
      edgeLenM[e] = lenM;
      const lenCells = Math.hypot(dr, dc);
      const n = Math.max(1, Math.ceil(lenCells / stepCells));
      edgeStepM[e] = lenM / n;
      const samples = new Float32Array(n + 1);
      for (let i = 0; i <= n; i++) samples[i] = sampleHeight(height, mask, H, W, NR[a] + dr * (i / n), NC[a] + dc * (i / n));
      tmpProf.push(samples);
      profOff[e] = totalSamples; totalSamples += n + 1;
    }
    profOff[nEdges] = totalSamples;
    const profH = new Float32Array(totalSamples);
    for (let e = 0; e < nEdges; e++) profH.set(tmpProf[e], profOff[e]);
    // Phase C: override deck (bridge/tunnel) edges with a straight profile
    // between their endpoint deck elevations, so the deck reads ~flat instead of
    // following the valley/hill the DEM shows beneath it.
    for (let di = 0; di < deckEdges.length; di++) {
      const e = deckEdges[di];
      const dA = nodeDeck.get(EA[e]), dB = nodeDeck.get(EB[e]);
      if (dA === undefined || dB === undefined) continue;
      const off = profOff[e], n = profOff[e + 1] - off - 1;
      for (let i = 0; i <= n; i++) profH[off + i] = dA + (dB - dA) * (i / n);
    }

    // CSR adjacency over directed half-edges (both directions of each edge).
    const csrHead = new Int32Array(nNodes + 1);
    for (let e = 0; e < nEdges; e++) { csrHead[EA[e] + 1]++; csrHead[EB[e] + 1]++; }
    for (let i = 0; i < nNodes; i++) csrHead[i + 1] += csrHead[i];
    const nHE = 2 * nEdges;
    const csrSource = new Int32Array(nHE), csrTarget = new Int32Array(nHE);
    const csrEdge = new Int32Array(nHE), csrAtoB = new Uint8Array(nHE);
    const fill = new Int32Array(nNodes);
    const place = (u, v, e, atob) => { const p = csrHead[u] + fill[u]++; csrSource[p] = u; csrTarget[p] = v; csrEdge[p] = e; csrAtoB[p] = atob; };
    for (let e = 0; e < nEdges; e++) { place(EA[e], EB[e], e, 1); place(EB[e], EA[e], e, 0); }

    return {
      nNodes, nEdges, junctionMode,
      nodeR: NR, nodeC: NC, nodeH: NH, nodeValid,
      edgeA: EA, edgeB: EB, edgeLenM, edgeStepM, profOff, profH,
      csrHead, csrSource, csrTarget, csrEdge, csrAtoB,
    };
  }

  // ----------------------------------------------------------- directed cost --
  // Per-run directed costs for every edge from the params, read straight off the
  // stored profiles (raw energy — the maximize mode is a separate layered DP).
  function directedCosts(g, params) {
    const c = params.cost;
    const costAB = new Float64Array(g.nEdges), costBA = new Float64Array(g.nEdges);
    for (let e = 0; e < g.nEdges; e++) {
      const off = g.profOff[e], n = g.profOff[e + 1] - off - 1, stepM = g.edgeStepM[e];
      costAB[e] = profileCost(g.profH, off, n, stepM, true, c);
      costBA[e] = profileCost(g.profH, off, n, stepM, false, c);
    }
    return { costAB, costBA };
  }

  // --------------------------------------------------------------- dijkstra ---
  // Budget-limited Dijkstra over the graph. seeds = node ids. reverse=true pays
  // the opposite edge direction (energy TO the seed, i.e. transpose graph).
  function dijkstra(g, costAB, costBA, seeds, eMax, reverse) {
    const nN = g.nNodes;
    const E = new Float64Array(nN).fill(Infinity);
    const settled = new Uint8Array(nN);
    const parentHE = new Int32Array(nN).fill(-1);
    const order = new Int32Array(nN); let ol = 0;
    const heap = makeRadixHeap();
    // E is freshly Infinity-filled, so the old `E[s] !== 0` clause was always
    // true (dead); a duplicate seed in `seeds` is already absorbed by the
    // settled check in the pop loop, so no extra dedupe guard is needed.
    for (let i = 0; i < seeds.length; i++) { const s = seeds[i]; if (s >= 0 && s < nN && g.nodeValid[s]) { E[s] = 0; heap.push(0, s); } }
    while (heap.pop()) {
      const g0 = heap.pri, u = heap.val;
      if (settled[u]) continue;
      settled[u] = 1; order[ol++] = u;
      for (let he = g.csrHead[u]; he < g.csrHead[u + 1]; he++) {
        const v = g.csrTarget[he]; if (settled[v] || !g.nodeValid[v]) continue;
        const e = g.csrEdge[he], atob = g.csrAtoB[he];
        const w = reverse ? (atob ? costBA[e] : costAB[e]) : (atob ? costAB[e] : costBA[e]);
        const t = g0 + w;
        if (eMax > 0 && t > eMax) continue;
        if (t < E[v]) { E[v] = t; parentHE[v] = he; heap.push(t, v); }
      }
    }
    return { E, settled, parentHE, order, orderLen: ol };
  }

  // Accumulate per-edge passes from a search tree: each edge carries the size of
  // the subtree hanging below its child endpoint (mirrors the grid `passes`).
  function accumulatePasses(g, tree, edgePass, keep) {
    const { order, orderLen, parentHE } = tree;
    const nodePass = new Float64Array(g.nNodes);
    for (let j = 0; j < orderLen; j++) { const v = order[j]; nodePass[v] = keep ? (keep[v] ? 1 : 0) : 1; }
    for (let j = orderLen - 1; j >= 0; j--) {
      const v = order[j], he = parentHE[v];
      if (he < 0) continue;
      const u = g.csrSource[he];
      nodePass[u] += nodePass[v];
      edgePass[g.csrEdge[he]] += nodePass[v];
    }
    return nodePass;
  }

  // Reconstruct a path (node ids + edge ids) by following parentHE from `target`
  // back to a seed (parentHE = -1). `forwardFromSeed` controls orientation.
  function reconstructPath(g, tree, target) {
    const nodes = [], edges = [];
    let v = target;
    if (tree.parentHE[v] < 0 && !(tree.settled && tree.settled[v])) return null;
    let guard = 0;
    while (v >= 0 && guard++ <= g.nNodes) {
      nodes.push(v);
      const he = tree.parentHE[v];
      if (he < 0) break;
      edges.push(g.csrEdge[he]);
      v = g.csrSource[he];
    }
    return { nodes, edges };
  }

  function edgeEnergyFromNodes(g, nodeEnergy) {
    const ee = new Float32Array(g.nEdges);
    for (let e = 0; e < g.nEdges; e++) {
      const a = nodeEnergy[g.edgeA[e]], b = nodeEnergy[g.edgeB[e]];
      const fa = Number.isFinite(a), fb = Number.isFinite(b);
      ee[e] = fa && fb ? (a + b) / 2 : (fa ? a : (fb ? b : NaN));
    }
    return ee;
  }

  // ---------------------------------------------------------------- top-N -----
  // N progressively-penalised shortest paths src→dst (route diversity). The
  // penalty multiplies the distance-cost component of an edge by penalty^usedCount
  // — the graph analogue of energy-worker's per-cell repulsion. Under v2 the
  // distance-cost coefficient is `distCoeff = aRoll + aAero` (flat-resistance,
  // the analogue of v1's alpha). (linear/square repulsion are grid distance-
  // transform modes; on a graph they reduce to this per-edge form for now — see
  // the README note.) Route energies are reported UN-penalised (true energy);
  // sharedEdges counts edges shared with other routes. `reverse` mirrors the
  // raster A* top-N fix (energy-worker.js reverse: mode === "to"): mode "to"
  // must score/settle in the true travel direction (energy TO dst, paid on
  // the reverse-direction edge costs), not always forward from src.
  function topN(g, costAB, costBA, src, dst, eMax, nRoutes, penalty, distCoeff, reverse) {
    const used = new Int32Array(g.nEdges);
    const pAB = new Float64Array(g.nEdges), pBA = new Float64Array(g.nEdges);
    const pen = penalty > 1 ? penalty : 1;
    const routes = [];
    const globalUse = new Int32Array(g.nEdges);
    for (let i = 0; i < nRoutes; i++) {
      for (let e = 0; e < g.nEdges; e++) {
        const bump = (Math.pow(pen, used[e]) - 1) * distCoeff * g.edgeLenM[e];
        pAB[e] = costAB[e] + bump; pBA[e] = costBA[e] + bump;
      }
      const tree = dijkstra(g, pAB, pBA, [src], eMax, reverse);
      if (!tree.settled[dst]) break;
      const path = reconstructPath(g, tree, dst);
      if (!path || !path.edges.length) break;
      let lenM = 0; for (let k = 0; k < path.edges.length; k++) lenM += g.edgeLenM[path.edges[k]];
      const energy = pathEnergy(g, costAB, costBA, path, reverse);
      routes.push({ nodes: path.nodes, edges: path.edges, lengthM: lenM, energy, sharedEdges: 0 });
      for (let k = 0; k < path.edges.length; k++) { used[path.edges[k]]++; globalUse[path.edges[k]]++; }
    }
    for (const rt of routes) { let s = 0; for (const e of rt.edges) if (globalUse[e] > 1) s++; rt.sharedEdges = s; }
    return { routes, globalUse };
  }

  // ------------------------------------------------------------- maximize -----
  // Layered DP: the maximum-energy walk of EXACTLY L edges from src (revisits
  // allowed, like energy-worker's maxCostPathOfLength). dp[k][v] = max energy to
  // reach v in k edges; reconstruct via the per-layer half-edge that achieved it.
  // `reverse` mirrors dijkstra's reverse flag (mode "to": score edges in the
  // opposite travel direction, i.e. energy TO src) — the graph analogue of the
  // raster maxCostPathOfLength's `reverse` (energy-worker.js, dh flip).
  function maximizeWalk(g, costAB, costBA, src, L, dst, reverse) {
    const nN = g.nNodes;
    const NEG = -Infinity;
    let dpPrev = new Float64Array(nN).fill(NEG); dpPrev[src] = 0;
    const par = []; // par[k][v] = half-edge taken into v at layer k (k=1..L)
    const bestNode = new Float64Array(nN).fill(NEG); bestNode[src] = 0;
    for (let k = 1; k <= L; k++) {
      const dpCur = new Float64Array(nN).fill(NEG);
      const pk = new Int32Array(nN).fill(-1);
      for (let u = 0; u < nN; u++) {
        if (dpPrev[u] === NEG) continue;
        for (let he = g.csrHead[u]; he < g.csrHead[u + 1]; he++) {
          const v = g.csrTarget[he], e = g.csrEdge[he], atob = g.csrAtoB[he];
          const w = reverse ? (atob ? costBA[e] : costAB[e]) : (atob ? costAB[e] : costBA[e]);
          const nd = dpPrev[u] + w;
          if (nd > dpCur[v]) { dpCur[v] = nd; pk[v] = he; }
        }
      }
      par.push(pk);
      for (let v = 0; v < nN; v++) if (dpCur[v] > bestNode[v]) bestNode[v] = dpCur[v];
      dpPrev = dpCur;
    }
    // End node: dst if given & reachable in L, else the global argmax at layer L.
    let end = -1, endVal = NEG;
    if (dst >= 0 && dpPrev[dst] > NEG) { end = dst; endVal = dpPrev[dst]; }
    else for (let v = 0; v < nN; v++) if (dpPrev[v] > endVal) { endVal = dpPrev[v]; end = v; }
    if (end < 0) return { path: null, bestNode };
    const nodes = [end], edges = [];
    let v = end;
    for (let k = L; k >= 1; k--) {
      const he = par[k - 1][v]; if (he < 0) break;
      edges.push(g.csrEdge[he]); v = g.csrSource[he]; nodes.push(v);
    }
    let lenM = 0; for (const e of edges) lenM += g.edgeLenM[e];
    return { path: { nodes, edges, lengthM: lenM, energy: endVal }, bestNode };
  }

  // -------------------------------------------------------------- dispatch ----
  // computeGraph(graph, params) -> result. Modes: density, from, to, round,
  // plus wantTopN (route diversity) and maximize (layered-DP walk of L edges).
  // params: {mode, cost, eMax, eMaxMode, srcNode, dstNode, refNodes,
  //  wantPath, wantTopN, nRoutes, penalty, maximize, maximizeLength}.
  //  cost = the v2 bundle { aRoll, aAero, beta, climbThr, abRatio, epsOffset }.
  function computeGraph(g, params) {
    const t0 = nowMs();
    const { costAB, costBA } = directedCosts(g, params);
    const eMax = params.eMax > 0 ? params.eMax : 0;
    const totalCap = params.eMaxMode === "total" && eMax > 0 ? eMax : 0;
    const edgePass = new Float64Array(g.nEdges);
    let edgeEnergy = null, nodeEnergy = null, path = null;

    // maximize: layered-DP max-energy walk of L edges (its own path + field).
    // mode "to" mirrors the non-maximize "from"/"to" branch below and the raster
    // maxCostPathOfLength fix (energy-worker.js): score the walk in the true
    // travel direction (energy TO srcNode), not always forward from it.
    if (params.maximize) {
      const L = params.maximizeLength > 0 ? params.maximizeLength : 1;
      const mw = maximizeWalk(g, costAB, costBA, params.srcNode, L, params.dstNode != null ? params.dstNode : -1, params.mode === "to");
      nodeEnergy = new Float32Array(g.nNodes).fill(NaN);
      for (let v = 0; v < g.nNodes; v++) if (mw.bestNode[v] > -Infinity) nodeEnergy[v] = mw.bestNode[v];
      if (mw.path) for (let k = 0; k < mw.path.edges.length; k++) edgePass[mw.path.edges[k]] = 1;
      return {
        edgePasses: edgePass, edgeEnergy: edgeEnergyFromNodes(g, nodeEnergy), nodeEnergy,
        path: mw.path, routes: null, elapsedMs: nowMs() - t0,
      };
    }

    // top-N: base field + passes from src, then diverse penalised routes.
    // mode "to" mirrors the non-topN "from"/"to" branch below (and the v49
    // raster A* fix): score/settle in the TRUE travel direction, not always
    // forward from srcNode.
    if (params.wantTopN && params.dstNode >= 0) {
      const rev = params.mode === "to";
      const base = dijkstra(g, costAB, costBA, [params.srcNode], eMax, rev);
      accumulatePasses(g, base, edgePass, null);
      nodeEnergy = new Float32Array(g.nNodes).fill(NaN);
      for (let j = 0; j < base.orderLen; j++) { const v = base.order[j]; nodeEnergy[v] = base.E[v]; }
      const { routes } = topN(g, costAB, costBA, params.srcNode, params.dstNode, eMax, params.nRoutes > 0 ? params.nRoutes : 1, params.penalty, params.cost.aRoll + params.cost.aAero, rev);
      const best = routes.length ? routes[0] : null;
      return {
        edgePasses: edgePass, edgeEnergy: edgeEnergyFromNodes(g, nodeEnergy), nodeEnergy,
        path: best, routes, elapsedMs: nowMs() - t0,
      };
    }

    if (params.mode === "density") {
      const refs = params.refNodes || [];
      const eSum = new Float64Array(g.nNodes), eCnt = new Int32Array(g.nNodes);
      for (let k = 0; k < refs.length; k++) {
        const ref = refs[k]; if (ref < 0) continue;
        if (params.densityMode === "round") {
          const fwd = dijkstra(g, costAB, costBA, [ref], eMax, false);
          const bwd = dijkstra(g, costAB, costBA, [ref], eMax, true);
          const keep = new Uint8Array(g.nNodes);
          for (let v = 0; v < g.nNodes; v++) {
            const fi = fwd.E[v], bi = bwd.E[v];
            const ok = Number.isFinite(fi) && Number.isFinite(bi) && !(totalCap > 0 && fi + bi > totalCap);
            keep[v] = ok ? 1 : 0;
            if (ok) { eSum[v] += fi + bi; eCnt[v]++; }
          }
          accumulatePasses(g, fwd, edgePass, keep);
          accumulatePasses(g, bwd, edgePass, keep);
        } else {
          const tree = dijkstra(g, costAB, costBA, [ref], eMax, params.densityMode === "to");
          accumulatePasses(g, tree, edgePass, null);
          for (let j = 0; j < tree.orderLen; j++) { const v = tree.order[j]; eSum[v] += tree.E[v]; eCnt[v]++; }
        }
      }
      nodeEnergy = new Float32Array(g.nNodes).fill(NaN);
      for (let v = 0; v < g.nNodes; v++) if (eCnt[v] > 0) nodeEnergy[v] = eSum[v] / eCnt[v];
      edgeEnergy = edgeEnergyFromNodes(g, nodeEnergy);
    } else if (params.mode === "round") {
      const src = params.srcNode;
      const fwd = dijkstra(g, costAB, costBA, [src], eMax, false);
      const bwd = dijkstra(g, costAB, costBA, [src], eMax, true);
      nodeEnergy = new Float32Array(g.nNodes).fill(NaN);
      const keep = new Uint8Array(g.nNodes);
      for (let v = 0; v < g.nNodes; v++) {
        const fi = fwd.E[v], bi = bwd.E[v];
        const ok = Number.isFinite(fi) && Number.isFinite(bi) && !(totalCap > 0 && fi + bi > totalCap);
        keep[v] = ok ? 1 : 0; if (ok) nodeEnergy[v] = fi + bi;
      }
      accumulatePasses(g, fwd, edgePass, keep);
      accumulatePasses(g, bwd, edgePass, keep);
      edgeEnergy = edgeEnergyFromNodes(g, nodeEnergy);
      if (params.wantPath && params.dstNode >= 0) path = reconstructPath(g, fwd, params.dstNode);
    } else { // "from" | "to"
      const reverse = params.mode === "to";
      const tree = dijkstra(g, costAB, costBA, [params.srcNode], eMax, reverse);
      accumulatePasses(g, tree, edgePass, null);
      nodeEnergy = new Float32Array(g.nNodes).fill(NaN);
      for (let j = 0; j < tree.orderLen; j++) { const v = tree.order[j]; nodeEnergy[v] = tree.E[v]; }
      edgeEnergy = edgeEnergyFromNodes(g, nodeEnergy);
      if (params.wantPath && params.dstNode >= 0) path = reconstructPath(g, tree, params.dstNode);
    }

    let pathOut = null;
    if (path && path.nodes.length) {
      let lenM = 0, en = 0;
      for (let i = 0; i < path.edges.length; i++) lenM += g.edgeLenM[path.edges[i]];
      // energy along the path = sum of directed costs in travel order — EXCEPT
      // round mode, where the shown path is only the outbound leg (the return
      // leg is ambiguous, mirroring energy-worker.js's round dispatch: "the
      // path is ambiguous... report the outbound path for visualisation") but
      // the reported energy must be the ROUND-TRIP total already computed in
      // nodeEnergy (fwd + bwd), not the outbound leg's own cost alone.
      en = params.mode === "round" ? nodeEnergy[path.nodes[0]] : pathEnergy(g, costAB, costBA, path, params.mode === "to");
      pathOut = { nodes: path.nodes, edges: path.edges, lengthM: lenM, energy: en };
    }

    return {
      edgePasses: edgePass,
      edgeEnergy,
      nodeEnergy,
      path: pathOut,
      routes: null,
      elapsedMs: nowMs() - t0,
    };
  }

  // Energy of a reconstructed path, paying each edge in actual travel direction.
  function pathEnergy(g, costAB, costBA, path, reverse) {
    // path.nodes is target→…→seed (reconstruct walks parents); edges[i] links
    // nodes[i] and nodes[i+1]. Travel direction depends on the search.
    let total = 0;
    for (let i = 0; i < path.edges.length; i++) {
      const e = path.edges[i];
      const from = path.nodes[i + 1], to = path.nodes[i];
      const atob = g.edgeA[e] === from;
      const fwdCost = atob ? costAB[e] : costBA[e];
      const bwdCost = atob ? costBA[e] : costAB[e];
      total += reverse ? bwdCost : fwdCost;
    }
    return total;
  }

  // Nearest node to a fractional (r, c) — linear scan (callers snap a handful of
  // points; app.js can pre-bucket if it ever needs many).
  function nearestNode(g, r, c) {
    let best = -1, bestD = Infinity;
    for (let i = 0; i < g.nNodes; i++) {
      if (g.nodeValid && !g.nodeValid[i]) continue; // snap only to in-extent nodes
      const dr = g.nodeR[i] - r, dc = g.nodeC[i] - c, d = dr * dr + dc * dc;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  function nowMs() {
    return (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
  }

  const api = { makeRadixHeap, sampleHeight, stepCost, buildGraph, directedCosts, dijkstra, topN, maximizeWalk, computeGraph, nearestNode };
  root.GraphEngine = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
