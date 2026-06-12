// energy-worker.js — runs Dijkstra in a Web Worker so the UI stays responsive.
//
// Cost model per directed edge u -> v, dh = h_v - h_u:
//   if dh >= 0: cost = alpha * dist + beta * dh
//   else:       cost = max(0, alpha * dist - eta * beta * |dh|)
//
// Modes: "from" | "to" | "round"
// Always returns a Float32Array of energies (Infinity for unreachable).
// If a destination cell is given, also returns the reconstructed path
// (array of [r, c] pairs) and its energy/length.

// ------- Binary heap on a flat typed array (priority, payload) -------
// We pack each entry as two Float64 + Int32 in parallel arrays.
// Heap ordered by `priorities[i]`.
function createHeap(initialCapacity = 1024) {
  return {
    priorities: new Float64Array(initialCapacity),
    payloads: new Int32Array(initialCapacity),
    size: 0,
    capacity: initialCapacity,
  };
}
function heapGrow(h) {
  const newCap = h.capacity * 2;
  const np = new Float64Array(newCap);
  const nl = new Int32Array(newCap);
  np.set(h.priorities);
  nl.set(h.payloads);
  h.priorities = np;
  h.payloads = nl;
  h.capacity = newCap;
}
// Both sift loops move a "hole" instead of swapping pairs — one write per
// level instead of four — and the pop path allocates nothing: callers read
// the top via h.priorities[0] / h.payloads[0], then call heapRemoveTop(h).
// (The old heapPop returned a fresh {priority, payload} object per call,
// which is millions of short-lived allocations over one Dijkstra run.)
function heapPush(h, priority, payload) {
  if (h.size >= h.capacity) heapGrow(h);
  const pr = h.priorities, pl = h.payloads;
  let i = h.size++;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (pr[parent] <= priority) break;
    pr[i] = pr[parent];
    pl[i] = pl[parent];
    i = parent;
  }
  pr[i] = priority;
  pl[i] = payload;
}
function heapRemoveTop(h) {
  const n = --h.size;
  if (n <= 0) return;
  const pr = h.priorities, pl = h.payloads;
  const movedP = pr[n];
  const movedV = pl[n];
  let i = 0;
  while (true) {
    let child = 2 * i + 1;
    if (child >= n) break;
    if (child + 1 < n && pr[child + 1] < pr[child]) child++;
    if (pr[child] >= movedP) break;
    pr[i] = pr[child];
    pl[i] = pl[child];
    i = child;
  }
  pr[i] = movedP;
  pl[i] = movedV;
}

// ------- Dijkstra -------
// height: Float32Array of length H*W (row-major)
// mask:   Uint8Array of length H*W, 1 = passable
// seedR, seedC: integer pixel coords of anchor
// reverse: if true, score forward edge nbr->here (i.e. compute energy TO seed)
// trackParents: keep parent links for path reconstruction
// wantPasses:   also compute the per-cell "passes count" (route-density /
//               subtree size in the shortest-path tree), as in the QGIS
//               energy-and-passes plugin. Forces parent + settle-order
//               tracking and runs a reverse-walk subtree accumulation at
//               the end. Returns a Float64Array (counts can exceed 2^24).
// wantTree:     keep parents + settle order, skip the passes accumulation —
//               the caller runs subtreePasses() itself, optionally with an
//               include mask (round mode filters endpoints by combined-leg
//               feasibility, which a single run can't know).
// Returns { E, parents, passes, order, orderLen }; parents/passes/order may
// be null depending on the flags.
function dijkstra(opts) {
  const {
    height, mask, H, W,
    seedR, seedC,
    alpha, beta, eta,
    dx, dy,
    reverse, trackParents,
    wantPasses,
    // wantTree: keep parents + settle order and return them WITHOUT the
    // passes accumulation. Round mode uses this so the caller can compute
    // FILTERED passes after combining both legs' energies (the filter —
    // "is this cell's round trip within budget?" — isn't knowable inside
    // a single leg's run).
    wantTree = false,
    eMax = 0,                  // 0 = no budget; >0 = stop expanding past this
    // Reverse-optimisation: when true, every edge cost is replaced with
    // (maxEdgeCost − cost) before relaxation. Dijkstra then finds the
    // "least inverted-cost" path, which is the same as "most original-
    // cost" path among same-length paths.
    maximize = false,
    maxEdgeCost = 0,
    // Per-cell progress messages get scaled into the range
    // [progressBase, progressBase + progressScale]. Default = full range,
    // i.e. one Dijkstra spans the whole bar. The density loop overrides
    // these to keep the overall compute monotonic 0→1 across N refs.
    progressBase = 0,
    progressScale = 1,
  } = opts;

  const N = H * W;
  const diag = Math.hypot(dx, dy);

  // 8-neighbor offsets and their ground distances. Typed arrays (not JS
  // arrays) so the relax loop reads unboxed values, plus precomputed
  // flat-index deltas: interior cells (~99% of the grid) skip the per-
  // neighbor row/col bounds arithmetic entirely.
  const drs = new Int32Array([-1, -1, -1, 0, 0, 1, 1, 1]);
  const dcs = new Int32Array([-1, 0, 1, -1, 1, -1, 0, 1]);
  const dists = new Float64Array([diag, dy, diag, dx, dx, diag, dy, diag]);
  const dIdx = new Int32Array(8);
  for (let k = 0; k < 8; k++) dIdx[k] = drs[k] * W + dcs[k];

  const E = new Float32Array(N);
  E.fill(Infinity);
  const seedIdx = seedR * W + seedC;
  E[seedIdx] = 0;

  // wantPasses/wantTree need parent links for the subtree walk.
  const keepParents = trackParents || wantPasses || wantTree;
  const parents = keepParents ? new Int32Array(N).fill(-1) : null;
  // `settled` filters stale heap entries. Using a boolean per-cell flag
  // instead of `g > E[idx]` because E is f32 and heap priorities are f64
  // (JS Number) — the precision mismatch would let multiple non-stale
  // entries pop for the same cell, blowing up the heap and capping the
  // reachable field at ~200 m before the heap drained.
  const settled = new Uint8Array(N);
  // Sequence of cells in pop order; required for the passes accumulation.
  const order = (wantPasses || wantTree) ? new Int32Array(N) : null;
  let orderLen = 0;

  const heap = createHeap(Math.min(N, 1 << 16));
  heapPush(heap, 0, seedIdx);

  let progressed = 0;
  const reportEvery = Math.max(1000, Math.floor(N / 50));

  while (heap.size > 0) {
    const g = heap.priorities[0];
    const idx = heap.payloads[0];
    heapRemoveTop(heap);
    if (settled[idx]) continue;
    settled[idx] = 1;
    if (order) order[orderLen++] = idx;

    progressed++;
    if (progressed % reportEvery === 0) {
      // Coarse progress: fraction of mask cells settled (approximation),
      // scaled into the caller's slice of the overall progress bar.
      const local = progressed / N;
      postMessage({ kind: "progress", progress: progressBase + local * progressScale });
    }

    const r = (idx / W) | 0;
    const c = idx - r * W;
    const hHere = height[idx];
    const inner = r > 0 && r < H - 1 && c > 0 && c < W - 1;

    for (let k = 0; k < 8; k++) {
      let nIdx;
      if (inner) {
        nIdx = idx + dIdx[k];
      } else {
        const nr = r + drs[k];
        const nc = c + dcs[k];
        if (nr < 0 || nr >= H || nc < 0 || nc >= W) continue;
        nIdx = nr * W + nc;
      }
      if (!mask[nIdx]) continue;
      // Symmetric guard to the settled-flag staleness check: don't even
      // attempt to relax an already-settled neighbour. f32 storage of E
      // means `tentative < E[nIdx]` can spuriously fire on a settled cell
      // and corrupt its `parents[nIdx]` (overwriting it to point at a cell
      // that was settled AFTER nIdx) — which strands that cell's subtree
      // contribution during the passes-count reverse walk.
      if (settled[nIdx]) continue;

      const hNbr = height[nIdx];
      const dh = reverse ? hHere - hNbr : hNbr - hHere;
      const dist = dists[k];

      let edge;
      if (dh >= 0) {
        edge = alpha * dist + beta * dh;
      } else {
        edge = alpha * dist - eta * beta * (-dh);
        if (edge < 0) edge = 0;
      }

      // Reverse the optimisation by inverting against the global cap.
      if (maximize) {
        edge = maxEdgeCost - edge;
        if (edge < 0) edge = 0; // belt-and-suspenders guard
      }

      const tentative = g + edge;
      // Energy budget: skip cells beyond the allowance. Settled-but-out-of-
      // budget cells just stay at E=Infinity (treated as "unreachable" by
      // the renderer / passes-count subtree walk).
      if (eMax > 0 && tentative > eMax) continue;
      if (tentative < E[nIdx]) {
        E[nIdx] = tentative;
        if (parents) parents[nIdx] = idx;
        heapPush(heap, tentative, nIdx);
      }
    }
  }

  const passes = (wantPasses && order)
    ? subtreePasses(parents, order, orderLen, N, null)
    : null;

  return {
    E,
    parents: (trackParents || wantTree) ? parents : null,
    passes,
    order: wantTree ? order : null,
    orderLen,
  };
}

// Subtree accumulation for the passes count: walk the settle order in
// reverse, adding each cell's count to its parent. Result: passes[c] =
// number of counted cells whose shortest path to the seed traverses c.
// `include` (optional Uint8Array of 0/1) selects which cells count as
// trajectory ENDPOINTS — round mode passes the "round trip is within
// budget / both legs reachable" mask, so only displayed destinations
// contribute. Intermediate cells need no filtering: a corridor cell over
// the budget still carries optimal legs serving within-budget cells.
function subtreePasses(parents, order, orderLen, N, include) {
  const passes = new Float64Array(N);
  for (let j = 0; j < orderLen; j++) {
    const idx = order[j];
    passes[idx] = include ? include[idx] : 1;
  }
  for (let j = orderLen - 1; j >= 0; j--) {
    const idx = order[j];
    const p = parents[idx];
    if (p >= 0) passes[p] += passes[idx];
  }
  return passes;
}

// ------- A* with iterative-penalization for top-N routes -------
// Single shortest path from `start` to `goal` under the asymmetric cost
// model, with a per-cell penalty multiplier on the alpha*dist component:
//   mult = penalty ^ usedCount[v];
//   edge += (mult - 1) * alpha * dist
// Penalty applies to the destination cell of each edge. The gravitational
// (beta * dh) term is NOT penalized — climb is unavoidable.
//
// Heuristic: alpha * straight-line + beta * max(0, h_goal - h_here).
// Admissible because both bounds are required by any feasible path.
function astar(opts) {
  const {
    height, mask, H, W,
    startR, startC, goalR, goalC,
    alpha, beta, eta,
    dx, dy,
    penalty, usedCount,
    repulsionMode = "per-cell",   // "per-cell" | "linear" | "square"
    distUsed = null,               // Float32Array of distance-to-nearest-used
    eMax = 0,                      // 0 = no budget; >0 abandon past this
    maximize = false,              // invert edge cost against maxEdgeCost
    maxEdgeCost = 0,
  } = opts;
  const N = H * W;
  const diag = Math.hypot(dx, dy);
  const drs = new Int32Array([-1, -1, -1, 0, 0, 1, 1, 1]);
  const dcs = new Int32Array([-1, 0, 1, -1, 1, -1, 0, 1]);
  const dists = new Float64Array([diag, dy, diag, dx, dx, diag, dy, diag]);
  const dIdx = new Int32Array(8);
  for (let k = 0; k < 8; k++) dIdx[k] = drs[k] * W + dcs[k];

  const startIdx = startR * W + startC;
  const goalIdx = goalR * W + goalC;
  // Bounds check is hard, but mask check is soft: if start/goal aren't on
  // the (effective) mask the search can still run — relaxation refuses to
  // step *through* off-mask cells, but we let the seed itself sit there.
  // This matches dijkstra() and means top-N still produces routes when the
  // user dropped src/dst before loading a vector network constraint.
  if (startIdx < 0 || startIdx >= N || goalIdx < 0 || goalIdx >= N) {
    return { path: null, energy: Infinity, length: 0 };
  }

  const E = new Float32Array(N); E.fill(Infinity);
  const L = new Float32Array(N); L.fill(Infinity);
  const parents = new Int32Array(N).fill(-1);
  const settled = new Uint8Array(N);

  const hGoal = height[goalIdx];
  // In maximize mode we don't have a useful admissible heuristic for the
  // inverted cost (it would be an upper bound on the remaining path,
  // which depends on path length). Falling back to h=0 makes A* behave
  // as Dijkstra — slower, but correctness is preserved.
  const heuristic = maximize ? (() => 0) : (idx) => {
    const r = (idx / W) | 0;
    const c = idx - r * W;
    const dr = (r - goalR) * dy;
    const dc = (c - goalC) * dx;
    const straight = Math.hypot(dr, dc);
    const climb = Math.max(0, hGoal - height[idx]);
    return alpha * straight + beta * climb;
  };

  E[startIdx] = 0;
  L[startIdx] = 0;
  const heap = createHeap(Math.min(N, 1 << 16));
  // Heap key is f = g + h; we encode (f<<32) -- but JS numbers are f64 so just
  // push (f, packed) where packed encodes g and idx. Simpler: push f as priority,
  // store idx in payload. We re-derive g from E[idx] when popped.
  heapPush(heap, heuristic(startIdx), startIdx);

  while (heap.size > 0) {
    const idx = heap.payloads[0];
    heapRemoveTop(heap);
    if (settled[idx]) continue;
    settled[idx] = 1;
    if (idx === goalIdx) break;

    const g = E[idx];
    const r = (idx / W) | 0;
    const c = idx - r * W;
    const hHere = height[idx];
    const inner = r > 0 && r < H - 1 && c > 0 && c < W - 1;

    for (let k = 0; k < 8; k++) {
      let nIdx;
      if (inner) {
        nIdx = idx + dIdx[k];
      } else {
        const nr = r + drs[k];
        const nc = c + dcs[k];
        if (nr < 0 || nr >= H || nc < 0 || nc >= W) continue;
        nIdx = nr * W + nc;
      }
      if (!mask[nIdx] || settled[nIdx]) continue;

      const hNbr = height[nIdx];
      const dh = hNbr - hHere;
      const dist = dists[k];

      let edge;
      if (dh >= 0) edge = alpha * dist + beta * dh;
      else {
        edge = alpha * dist - eta * beta * (-dh);
        if (edge < 0) edge = 0;
      }

      // Reverse-optimisation: invert the base cost before the repulsion
      // penalty is layered on. The penalty itself still ADDS to the
      // (already inverted) cost — that keeps repulsion behaving as
      // "avoid already-used cells" in both directions of optimisation.
      if (maximize) {
        edge = maxEdgeCost - edge;
        if (edge < 0) edge = 0;
      }

      // Apply the repulsion penalty. Three modes:
      //   per-cell:  multiplier = penalty^used_count[v], applied to alpha*dist.
      //              Sharp edges; only cells you've already traversed are
      //              expensive. Same as the QGIS plugin.
      //   linear:    extra cost = (penalty / (d + 1)) * alpha * dist, where d
      //              is the cell's Euclidean distance (in cells) to the
      //              nearest previously-used cell. Soft 1/r decay; pushes
      //              the route away from prior corridors even where they
      //              don't directly overlap.
      //   square:    extra cost = (penalty / (d² + 1)) * alpha * dist —
      //              same idea but with 1/r² (point-charge-like) falloff.
      if (repulsionMode === "per-cell") {
        const used = usedCount[nIdx] | 0;
        if (used > 0) {
          const mult = Math.pow(penalty, used);
          edge += (mult - 1) * alpha * dist;
        }
      } else if (distUsed) {
        const d = distUsed[nIdx];
        if (Number.isFinite(d)) {
          const denom = repulsionMode === "square" ? d * d + 1 : d + 1;
          edge += (penalty / denom) * alpha * dist;
        }
      }

      const tentative = g + edge;
      if (eMax > 0 && tentative > eMax) continue;
      if (tentative < E[nIdx]) {
        E[nIdx] = tentative;
        L[nIdx] = L[idx] + dist;
        parents[nIdx] = idx;
        heapPush(heap, tentative + heuristic(nIdx), nIdx);
      }
    }
  }

  if (!settled[goalIdx]) return { path: null, energy: Infinity, length: 0 };

  // Reconstruct path
  const path = [];
  let i = goalIdx;
  const cap = N + 1;
  let steps = 0;
  while (i >= 0 && steps++ < cap) {
    path.push(i);
    i = parents[i];
  }
  path.reverse();
  return { path, energy: E[goalIdx], length: L[goalIdx] };
}

// Two-pass 8-neighbour Chamfer (3-4) distance transform. For each cell the
// output approximates the Euclidean distance (in cell units) to the nearest
// "seed" cell (where seedMask[i] != 0). Cells in the seed set themselves get
// distance 0; isolated cells get Infinity.
//
// 3-4 weights mean cardinal moves cost 3 and diagonal moves cost 4; we
// divide by 3 at the end so the output is in approximate cell-distance
// units. Worst-case error vs. true Euclidean is ~5%, which is fine for the
// repulsion-penalty use case here.
function chamferDistanceTransform(seedMask, H, W) {
  const N = H * W;
  const D = 3, DD = 4;
  const dist = new Float32Array(N);
  for (let i = 0; i < N; i++) dist[i] = seedMask[i] ? 0 : Infinity;
  // Forward pass: top→bottom, left→right
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const idx = r * W + c;
      if (dist[idx] === 0) continue;
      let v = dist[idx];
      if (r > 0) {
        if (c > 0)        v = Math.min(v, dist[idx - W - 1] + DD);
                          v = Math.min(v, dist[idx - W] + D);
        if (c < W - 1)    v = Math.min(v, dist[idx - W + 1] + DD);
      }
      if (c > 0)          v = Math.min(v, dist[idx - 1] + D);
      dist[idx] = v;
    }
  }
  // Backward pass: bottom→top, right→left
  for (let r = H - 1; r >= 0; r--) {
    for (let c = W - 1; c >= 0; c--) {
      const idx = r * W + c;
      if (dist[idx] === 0) continue;
      let v = dist[idx];
      if (c < W - 1)      v = Math.min(v, dist[idx + 1] + D);
      if (r < H - 1) {
        if (c > 0)        v = Math.min(v, dist[idx + W - 1] + DD);
                          v = Math.min(v, dist[idx + W] + D);
        if (c < W - 1)    v = Math.min(v, dist[idx + W + 1] + DD);
      }
      dist[idx] = v;
    }
  }
  // Convert from chamfer-3-4 units to approximate cell-distance units.
  for (let i = 0; i < N; i++) {
    if (Number.isFinite(dist[i])) dist[i] /= D;
  }
  return dist;
}

// GDAL-style fillnodata: for each non-network cell within demMask, walk
// outward in 8 directions until a network cell with a finite energy is
// found (up to maxDistance cells per direction). The cell's filled value
// is the inverse-squared-distance-weighted mean of those (up to 8) hits.
// Cells with no hits stay Infinity.
//
// Optional 3×3 box smoothing afterwards — network cells are preserved so
// smoothing only shifts the fill values.
//
//   E:           Float32Array; energies from the constrained Dijkstra.
//   networkMask: 1 on network cells.
//   demMask:     1 on every cell that should be filled.
//   maxDistance: ray search cap, in cells.
//   smoothing:   number of 3×3 box-smooth passes over the fill (0 = none).
function fillAcrossNetwork(E, networkMask, demMask, H, W, dx, dy, maxDistance, smoothing, onProgress) {
  const out = idwFill(E, networkMask, demMask, H, W, dx, dy, maxDistance, onProgress);
  let buf = out;
  for (let s = 0; s < smoothing; s++) {
    buf = boxSmoothPreserveNetwork(buf, networkMask, demMask, H, W);
  }
  return buf;
}

function idwFill(E, networkMask, demMask, H, W, dx, dy, maxDistance, onProgress) {
  const N = H * W;
  const out = new Float32Array(E);
  const dDiag = Math.hypot(dx, dy);
  // Eight rays: dr, dc, per-step Euclidean cost.
  const dirs = [
    [-1,  0, dy],
    [-1,  1, dDiag],
    [ 0,  1, dx],
    [ 1,  1, dDiag],
    [ 1,  0, dy],
    [ 1, -1, dDiag],
    [ 0, -1, dx],
    [-1, -1, dDiag],
  ];
  const max = Math.max(1, maxDistance | 0);
  const reportEvery = Math.max(1, Math.floor(H / 25));

  for (let r = 0; r < H; r++) {
    if (onProgress && r % reportEvery === 0) onProgress(r / H);
    for (let c = 0; c < W; c++) {
      const idx = r * W + c;
      if (!demMask[idx]) continue;
      // Network cells with finite E are the seeds — leave them alone.
      if (networkMask[idx] && Number.isFinite(E[idx])) continue;

      let weighted = 0;
      let weightSum = 0;
      for (let k = 0; k < 8; k++) {
        const dr = dirs[k][0], dc = dirs[k][1], step = dirs[k][2];
        let nr = r, nc = c, dist = 0;
        for (let s = 0; s < max; s++) {
          nr += dr; nc += dc; dist += step;
          if (nr < 0 || nr >= H || nc < 0 || nc >= W) break;
          const ni = nr * W + nc;
          // Walk over any cells (network or not) but only contribute when we
          // hit a network cell with a finite seed value. The loop terminates
          // at the first such hit per direction.
          if (networkMask[ni] && Number.isFinite(E[ni])) {
            const w = 1 / (dist * dist);
            weighted += E[ni] * w;
            weightSum += w;
            break;
          }
        }
      }
      out[idx] = weightSum > 0 ? weighted / weightSum : Infinity;
    }
  }
  return out;
}

// 3×3 average over cells within demMask. Network cells keep their input
// value (we never want smoothing to leak into the actual analysis output);
// other cells get the mean of any finite neighbours, which softens the
// IDW fill's directional artefacts.
function boxSmoothPreserveNetwork(E, networkMask, demMask, H, W) {
  const out = new Float32Array(E);
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const idx = r * W + c;
      if (!demMask[idx] || networkMask[idx] || !Number.isFinite(E[idx])) continue;
      let sum = 0, n = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const nr = r + dr, nc = c + dc;
          if (nr < 0 || nr >= H || nc < 0 || nc >= W) continue;
          const ni = nr * W + nc;
          if (!demMask[ni] || !Number.isFinite(E[ni])) continue;
          sum += E[ni]; n++;
        }
      }
      if (n > 0) out[idx] = sum / n;
    }
  }
  return out;
}

// Reconstruct a path from the parents array; returns flat indices.
function reconstructPath(parents, goalIdx) {
  const path = [];
  let idx = goalIdx;
  while (idx >= 0) {
    path.push(idx);
    idx = parents[idx];
  }
  path.reverse();
  return path;
}

// ------- Length-constrained max-cost path (layered DP) -------
// Finds the path from src to dst of exactly L edges that maximises the
// sum of original edge costs, by running a Bellman-Ford-style relaxation
// L times over the grid. Each iteration t computes dist[t][v] = max-cost
// path of exactly t edges from src to v. Memory dominates: we keep one
// Uint8Array per (t, v) for path reconstruction → ≈ L · H · W bytes.
//
// Caveats:
//   - "Path of length L" is in edge count, not metres. Diagonal moves
//     cover dx·√2 per edge.
//   - The graph isn't a DAG (8-neighbour grid has cycles). Layered DP
//     treats each (cell, t) pair as a separate DAG node, which means the
//     resulting path *can* revisit cells across different t. In practice
//     for short L and asymmetric costs this is rare, but we don't add
//     a no-backtrack constraint — that would multiply the state by 8.
//   - Memory cap below refuses runs above ~256 MB of parent storage.
//     Large DEMs limit usable L to a few dozen; the only safe escape is
//     to crop the DEM (FABDEM-viewport loader is the easiest way).

const MAX_DP_PARENT_BYTES = 256 * 1024 * 1024;

function maxCostPathOfLength(opts) {
  const {
    height, mask, H, W,
    startR, startC, goalR, goalC,
    alpha, beta, eta, dx, dy,
    L,
    progressBase = 0,
    progressScale = 1,
  } = opts;
  const N = H * W;

  // Memory cap. Parent storage is the dominant allocation; the two
  // dist arrays are 8 N bytes regardless of L.
  if (L <= 0 || L > 5000) {
    return { path: null, energy: -Infinity, length: 0, error: "bad_L" };
  }
  if (N * L > MAX_DP_PARENT_BYTES) {
    return {
      path: null, energy: -Infinity, length: 0,
      error: `memory_cap (L·N = ${(N * L / 1024 / 1024).toFixed(0)} MB > ${MAX_DP_PARENT_BYTES / 1024 / 1024} MB)`,
    };
  }

  const drs = [-1, -1, -1, 0, 0, 1, 1, 1];
  const dcs = [-1, 0, 1, -1, 1, -1, 0, 1];
  const diag = Math.hypot(dx, dy);
  const dists = [diag, dy, diag, dx, dx, diag, dy, diag];

  const start = startR * W + startC;
  const goal  = goalR  * W + goalC;
  if (start < 0 || start >= N || goal < 0 || goal >= N) {
    return { path: null, energy: -Infinity, length: 0, error: "oob" };
  }

  // Two alternating dist arrays. prev[v] holds dist[t-1][v]; we write
  // dist[t][v] into curr[v], then swap.
  let prev = new Float32Array(N);
  let curr = new Float32Array(N);
  prev.fill(-Infinity);
  prev[start] = 0;

  // parentDir[(t-1)·N + v] = direction (0..7) of the neighbour we came
  // from when reaching v at step t. 255 = no path found yet to (t, v).
  // Stored as a flat Uint8Array because Int32 would 4× the memory and we
  // only need 3 bits.
  const parentDir = new Uint8Array(N * L).fill(255);

  for (let t = 1; t <= L; t++) {
    curr.fill(-Infinity);
    for (let r = 0; r < H; r++) {
      const rowBase = r * W;
      for (let c = 0; c < W; c++) {
        const v = rowBase + c;
        if (!mask[v]) continue;
        const hv = height[v];

        let bestVal = -Infinity;
        let bestDir = 255;
        for (let k = 0; k < 8; k++) {
          const nr = r + drs[k];
          const nc = c + dcs[k];
          if (nr < 0 || nr >= H || nc < 0 || nc >= W) continue;
          const n = nr * W + nc;
          if (!mask[n]) continue;
          const pVal = prev[n];
          if (!Number.isFinite(pVal)) continue;

          // Same cost model as Dijkstra/A*: asymmetric uphill/downhill.
          const dh = hv - height[n];
          const dist = dists[k];
          let edge;
          if (dh >= 0) edge = alpha * dist + beta * dh;
          else {
            edge = alpha * dist - eta * beta * (-dh);
            if (edge < 0) edge = 0;
          }
          const cand = pVal + edge;
          if (cand > bestVal) {
            bestVal = cand;
            bestDir = k;
          }
        }
        curr[v] = bestVal;
        if (bestDir !== 255) {
          parentDir[(t - 1) * N + v] = bestDir;
        }
      }
    }

    // Swap prev/curr.
    const tmp = prev; prev = curr; curr = tmp;

    // Coarse progress per layer.
    if (t === L || t % Math.max(1, Math.floor(L / 25)) === 0) {
      postMessage({ kind: "progress", progress: progressBase + progressScale * (t / L) });
    }
  }

  // After the loop, prev[v] = dist[L][v]. Bail if the goal wasn't reached
  // in exactly L edges.
  if (!Number.isFinite(prev[goal])) {
    return {
      path: null, energy: -Infinity, length: 0,
      error: "unreachable",
      energyField: prev,
    };
  }

  // Reconstruct by walking parentDir backwards from (L, goal).
  //
  // The relaxation loop stores `bestDir = k`, where neighbour n is at
  // offset (drs[k], dcs[k]) from v — i.e. n IS the predecessor at step
  // t-1. So to move from v back to its predecessor we ADD the offset,
  // not subtract it. The previous code did `r - drs[dir]`, which sent
  // the walk in the opposite direction and eventually landed on a cell
  // with parentDir=255 (because that wrong-direction cell wasn't on the
  // actual max-cost chain), producing the spurious "backtrack_fail".
  const path = new Array(L + 1);
  path[L] = goal;
  let v = goal;
  for (let t = L; t >= 1; t--) {
    const dir = parentDir[(t - 1) * N + v];
    if (dir === 255) {
      return {
        path: null, energy: -Infinity, length: 0,
        error: "backtrack_fail",
        energyField: prev,
      };
    }
    const r = (v / W) | 0;
    const c = v - r * W;
    const nr = r + drs[dir];
    const nc = c + dcs[dir];
    v = nr * W + nc;
    path[t - 1] = v;
  }

  // Geometric length in metres.
  let pathLen = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const ar = (a / W) | 0, ac = a - ar * W;
    const br = (b / W) | 0, bc = b - br * W;
    pathLen += Math.hypot((br - ar) * dy, (bc - ac) * dx);
  }

  return {
    path,
    energy: prev[goal],
    length: pathLen,
    energyField: prev, // dist[L][v] for every cell — use as the field overlay
  };
}

// ------- Worker message handler -------
self.onmessage = (ev) => {
  const msg = ev.data;

  // Standalone IDW-fill job. Used by the density worker pool: the pool
  // merges per-worker partial fields on the main thread, so the optional
  // network interpolation (which lives here, next to its helpers) runs as
  // a follow-up task on the merged energy field.
  if (msg.kind === "interp") {
    try {
      const filled = fillAcrossNetwork(
        msg.energy, msg.networkMask, msg.mask, msg.H, msg.W, msg.dx, msg.dy,
        msg.interpMaxDistance, msg.interpSmoothing,
        (frac) => postMessage({ kind: "progress", progress: frac }),
      );
      postMessage({ kind: "interp-done", energy: filled }, [filled.buffer]);
    } catch (err) {
      postMessage({ kind: "error", message: err.message });
    }
    return;
  }

  if (msg.kind !== "run") return;

  const t0 = performance.now();
  const {
    height, mask, H, W, dx, dy,
    seedR, seedC,
    goalR, goalC,                                        // optional, may be -1 / -1
    mode,                                                 // "from" | "to" | "round"
    alpha, beta, eta,
    wantPasses = false,                                  // route-density toggle
    wantTopN = false,                                    // top-N routes toggle
    nRoutes = 1,                                         // number of top-N iterations
    penalty = 2.0,                                       // strength of repulsion
    repulsionMode = "per-cell",                          // "per-cell" | "linear" | "square"
    eMax = 0,                                            // energy budget (0 = none)
    eMaxMode = "leg",                                    // round mode only: "leg" caps each
                                                         // direction at eMax (totals reach
                                                         // 2·eMax); "total" caps the sum —
                                                         // legs still search up to eMax each
                                                         // (a leg can never exceed the total),
                                                         // then over-budget sums are masked
                                                         // to Infinity. Ignored outside round
                                                         // (one leg IS the total there).
    wantDensity = false,                                  // multi-ref passes density
    refPoints = null,                                     // [[r0,c0],[r1,c1], …]
    densityMode = "from",                                 // mode for each ref's Dijkstra
    densityPartial = false,                               // return un-normalised partial sums (worker pool)
    networkMask = null,                                   // optional binary mask over the DEM grid
    wantNetworkInterp = false,                            // fill non-network cells via IDW from network seeds
    interpMaxDistance = 50,                               // ray search cap, in cells
    interpSmoothing = 0,                                  // number of 3×3 smoothing passes
    maximize = false,                                     // reverse the optimisation: prefer expensive edges
    maximizeLength = 0,                                   // >0 → layered-DP max-cost path of exactly L edges
  } = msg;

  const wantPath = goalR >= 0 && goalC >= 0;
  // Round-trip total budget (see eMaxMode above). The per-leg Dijkstras
  // still run with eMax — a leg can never exceed the total — and the
  // combine loops below mask sums beyond this cap to Infinity.
  const eMaxTotalCap = (eMaxMode === "total" && eMax > 0) ? eMax : 0;
  const goalIdx = wantPath ? goalR * W + goalC : -1;
  const N = H * W;

  // For maximize mode we replace each edge cost with (MAX_EDGE_COST − cost)
  // before running Dijkstra. The output is still non-negative (Dijkstra
  // works) and minimising the inverted sum is approximately maximising
  // the original sum — biased toward shorter paths in the inverted space,
  // which here means paths with the highest per-edge original cost. We
  // bound MAX_EDGE_COST upfront from the global height range and the
  // diagonal step so the inversion is safe for every neighbour pair.
  let maxEdgeCost = 0;
  if (maximize) {
    let minH = Infinity, maxH = -Infinity;
    for (let i = 0; i < N; i++) {
      if (mask[i]) {
        const h = height[i];
        if (h < minH) minH = h;
        if (h > maxH) maxH = h;
      }
    }
    const dh = Number.isFinite(minH) && Number.isFinite(maxH) ? (maxH - minH) : 0;
    const diag = Math.hypot(dx, dy);
    // 1.001 buffer so even the absolute worst-case original edge cost
    // can't push the inverted value to zero (which would make the cell
    // free and degenerate the search).
    maxEdgeCost = (alpha * diag + beta * Math.max(dh, 1e-6)) * 1.001;
  }

  // When a network mask is supplied, Dijkstra runs on the AND of the DEM
  // mask and the network mask. We keep `mask` (the full DEM mask) around
  // so the post-compute interpolation step can fill non-network cells.
  let effMask = mask;
  if (networkMask) {
    effMask = new Uint8Array(N);
    for (let i = 0; i < N; i++) effMask[i] = (mask[i] && networkMask[i]) ? 1 : 0;
  }

  let energy;
  let passes = null;
  let path = null;          // single best path (top-N supersedes this with `routes`)
  let pathEnergy = null;
  let pathLengthCells = null;
  let routes = null;        // top-N output: [{ path, energy, length, shared }, ...]

  // Helper: Euclidean length in metres of a flat-index path under (dx, dy).
  function pathLength(p) {
    let len = 0;
    for (let i = 1; i < p.length; i++) {
      const a = p[i - 1], b = p[i];
      const ar = (a / W) | 0, ac = a - ar * W;
      const br = (b / W) | 0, bc = b - br * W;
      len += Math.hypot((br - ar) * dy, (bc - ac) * dx);
    }
    return len;
  }

  try {
    if (wantDensity && Array.isArray(refPoints) && refPoints.length > 0) {
      // Density path. Mutually exclusive with the regular from/to/round
      // branches — running one of those before this would double-count the
      // first ref and add a bogus extra cycle to the progress bar.
      //
      // For each reference point, run a Dijkstra (with passes), normalise
      // by H*W, sum across references, normalise by H*W again. The energy
      // layer is the per-cell mean of all refs' energy fields (counting
      // only refs from which the cell is reachable). Cells unreachable
      // from every ref stay Infinity (rendered transparent).
      const density = new Float64Array(N);
      const energySum = new Float64Array(N);
      const energyCount = new Int32Array(N);
      const dmode = densityMode || "from";
      const K = refPoints.length;
      const slice = 1 / K;
      for (let k = 0; k < K; k++) {
        const [refR, refC] = refPoints[k];
        if (refR < 0 || refR >= H || refC < 0 || refC >= W) continue;
        if (!mask[refR * W + refC]) continue;

        const base = k / K;

        let perRefPasses, perRefEnergy;
        if (dmode === "round") {
          // Forward + reverse share this ref's slice equally.
          const f = dijkstra({
            height, mask: effMask, H, W,
            seedR: refR, seedC: refC,
            alpha, beta, eta, dx, dy,
            reverse: false, trackParents: false,
            wantTree: true, eMax,
            maximize, maxEdgeCost,
            progressBase: base, progressScale: slice * 0.5,
          });
          const b = dijkstra({
            height, mask: effMask, H, W,
            seedR: refR, seedC: refC,
            alpha, beta, eta, dx, dy,
            reverse: true, trackParents: false,
            wantTree: true, eMax,
            maximize, maxEdgeCost,
            progressBase: base + slice * 0.5, progressScale: slice * 0.5,
          });
          // Energy + include mask first; passes after, filtered, so only
          // displayed (round-trip-feasible) destinations count.
          perRefEnergy = new Float32Array(N);
          const include = new Uint8Array(N);
          for (let i = 0; i < N; i++) {
            const fi = f.E[i], bi = b.E[i];
            const s = fi + bi;
            const ok =
              Number.isFinite(fi) && Number.isFinite(bi) && !(eMaxTotalCap > 0 && s > eMaxTotalCap);
            perRefEnergy[i] = ok ? s : Infinity;
            include[i] = ok ? 1 : 0;
          }
          perRefPasses = subtreePasses(f.parents, f.order, f.orderLen, N, include);
          const pb = subtreePasses(b.parents, b.order, b.orderLen, N, include);
          for (let i = 0; i < N; i++) perRefPasses[i] += pb[i];
        } else {
          const r = dijkstra({
            height, mask: effMask, H, W,
            seedR: refR, seedC: refC,
            alpha, beta, eta, dx, dy,
            reverse: dmode === "to", trackParents: false,
            wantPasses: true, eMax,
            maximize, maxEdgeCost,
            progressBase: base, progressScale: slice,
          });
          perRefPasses = r.passes;
          perRefEnergy = r.E;
        }
        // First normalisation: each reference's count becomes a density
        // (passes per cell over the grid).
        for (let i = 0; i < N; i++) {
          density[i] += perRefPasses[i] / N;
          if (Number.isFinite(perRefEnergy[i])) {
            energySum[i] += perRefEnergy[i];
            energyCount[i] += 1;
          }
        }
        // Snap progress to the slice boundary at end of each ref so the
        // bar lines up with the "ref X/K" status text the main thread
        // shows. The per-cell ticks above already cover the slice
        // monotonically; this is just a clean checkpoint.
        postMessage({ kind: "progress", progress: (k + 1) / K });
      }

      // Worker-pool mode: hand back the raw accumulators (density before
      // the second /N, energy as sum + reach-count) so the main thread can
      // merge several workers' slices before normalising. Buffers are
      // transferred — this worker is done with them.
      if (densityPartial) {
        const t1 = performance.now();
        postMessage(
          {
            kind: "done",
            partial: true,
            density, energySum, energyCount,
            elapsedMs: t1 - t0,
          },
          [density.buffer, energySum.buffer, energyCount.buffer],
        );
        return;
      }

      // Second density normalisation.
      for (let i = 0; i < N; i++) density[i] /= N;

      // Average energy: sum / count, Infinity where no ref reached.
      const avgE = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        avgE[i] = energyCount[i] > 0 ? energySum[i] / energyCount[i] : Infinity;
      }

      passes = density;
      energy = avgE;
    } else if (mode === "from") {
      const r = dijkstra({
        height, mask: effMask, H, W,
        seedR, seedC,
        alpha, beta, eta, dx, dy,
        reverse: false, trackParents: wantPath,
        wantPasses, eMax,
        maximize, maxEdgeCost,
      });
      energy = r.E;
      passes = r.passes;
      if (wantPath && Number.isFinite(energy[goalIdx])) {
        path = reconstructPath(r.parents, goalIdx);
        pathEnergy = energy[goalIdx];
      }
    } else if (mode === "to") {
      const r = dijkstra({
        height, mask: effMask, H, W,
        seedR, seedC,
        alpha, beta, eta, dx, dy,
        reverse: true, trackParents: wantPath,
        wantPasses, eMax,
        maximize, maxEdgeCost,
      });
      energy = r.E;
      passes = r.passes;
      if (wantPath && Number.isFinite(energy[goalIdx])) {
        path = reconstructPath(r.parents, goalIdx);
        pathEnergy = energy[goalIdx];
      }
    } else {
      // round trip: forward + reverse, sum. Passes are computed AFTER the
      // combine (wantTree defers the subtree walk) so that only displayed
      // destinations — both legs reachable AND within the budget semantics
      // — count as trajectory endpoints.
      const f = dijkstra({
        height, mask: effMask, H, W,
        seedR, seedC,
        alpha, beta, eta, dx, dy,
        reverse: false, trackParents: wantPath,
        wantTree: wantPasses, eMax,
        maximize, maxEdgeCost,
      });
      const b = dijkstra({
        height, mask: effMask, H, W,
        seedR, seedC,
        alpha, beta, eta, dx, dy,
        reverse: true, trackParents: false,
        wantTree: wantPasses, eMax,
        maximize, maxEdgeCost,
      });
      energy = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        const a = f.E[i];
        const c = b.E[i];
        const s = a + c;
        // Total-budget mode masks over-budget round trips.
        energy[i] = (a === Infinity || c === Infinity || (eMaxTotalCap > 0 && s > eMaxTotalCap))
          ? Infinity : s;
      }
      if (wantPasses) {
        const include = new Uint8Array(N);
        for (let i = 0; i < N; i++) include[i] = Number.isFinite(energy[i]) ? 1 : 0;
        passes = subtreePasses(f.parents, f.order, f.orderLen, N, include);
        const pb = subtreePasses(b.parents, b.order, b.orderLen, N, include);
        for (let i = 0; i < N; i++) passes[i] += pb[i];
      }
      // For round trip, the "path" is ambiguous (outbound vs return differ).
      // Report the outbound path here for visualisation.
      if (wantPath && Number.isFinite(energy[goalIdx])) {
        path = reconstructPath(f.parents, goalIdx);
        pathEnergy = energy[goalIdx];
      }
    }

    // Top-N: iterative penalization on top of the energy field. We keep the
    // already-computed energy/passes; each iteration runs A* with the running
    // usedCount so subsequent paths deviate.
    if (wantTopN && wantPath) {
      routes = [];
      const usedCount = new Int32Array(N);
      // For linear/square modes we need a binary "has-been-used" mask for the
      // distance transform. For per-cell mode, distUsed is unused.
      const usedMask =
        (repulsionMode === "linear" || repulsionMode === "square")
          ? new Uint8Array(N)
          : null;
      let distUsed = null;
      const k = Math.max(1, Math.min(20, nRoutes | 0));
      const pen = penalty > 0 ? penalty : 1.0;
      for (let r = 0; r < k; r++) {
        // Recompute the distance transform if any cells have been used so
        // far. On the first iteration nothing's been used → distUsed is
        // null, the penalty term in astar() is silently zero.
        if (usedMask && r > 0) {
          distUsed = chamferDistanceTransform(usedMask, H, W);
        }
        const res = astar({
          height, mask: effMask, H, W,
          startR: seedR, startC: seedC,
          goalR, goalC,
          alpha, beta, eta, dx, dy,
          penalty: pen, usedCount,
          repulsionMode, distUsed,
          eMax,
          maximize, maxEdgeCost,
        });
        if (!res.path) break;
        let shared = 0;
        for (let j = 0; j < res.path.length; j++) {
          if (usedCount[res.path[j]] > 0) shared++;
        }
        routes.push({
          path: res.path,
          energy: res.energy,
          length: res.length,
          shared,
        });
        for (let j = 0; j < res.path.length; j++) {
          usedCount[res.path[j]] += 1;
          if (usedMask) usedMask[res.path[j]] = 1;
        }
        // Coarse progress per iteration
        postMessage({ kind: "progress", progress: (r + 1) / k });
      }
    }

    // Path length for the single non-top-N output
    if (path) pathLengthCells = pathLength(path);

    // Length-constrained max-cost path (layered DP). Overrides the path
    // + energy field produced by the inverted Dijkstra above. We still
    // ran that first so the user sees *something* if the DP refuses
    // (out-of-memory cap, no L-edge path to the goal, …); the dispatch
    // here clobbers those only on success. The routes array from top-N
    // is also dropped — "L-constrained top-N" isn't a thing in this
    // implementation, the path you get is the single optimum.
    if (maximize && maximizeLength > 0 && wantPath) {
      const dp = maxCostPathOfLength({
        height, mask: effMask, H, W,
        startR: seedR, startC: seedC,
        goalR, goalC,
        alpha, beta, eta, dx, dy,
        L: maximizeLength,
      });
      // Always log the DP outcome to the console so it's clear whether the
      // length constraint actually kicked in.
      console.info(
        "[maximize/dp]",
        dp.error
          ? `failed: ${dp.error}`
          : `L=${maximizeLength}, energy=${dp.energy.toFixed(2)}, length=${dp.length.toFixed(0)} m`,
      );
      if (dp.error) {
        // Surface the failure to the UI; main thread routes 'warning'
        // through the status bar. Keep the inverted-Dijkstra outputs
        // so the user still sees the field.
        postMessage({
          kind: "warning",
          message: `Length-constrained DP did not run (${dp.error}). ` +
                   `Showing the inverted-Dijkstra path instead — try a larger L ` +
                   `(at minimum ~Chebyshev distance between src and dst).`,
        });
      } else if (dp.path) {
        path = dp.path;
        pathEnergy = dp.energy;
        pathLengthCells = dp.length;
        if (dp.energyField) energy = dp.energyField;
        routes = null; // top-N is meaningless under a length constraint
      }
    }

    // Optional: GDAL-style IDW fill of non-network cells. 8-ray search to
    // network seeds capped at interpMaxDistance, 1/d² weighting, then up
    // to interpSmoothing 3×3 box passes (network cells preserved).
    // Visualisation only — the analysis output stays constrained.
    if (wantNetworkInterp && networkMask && energy) {
      energy = fillAcrossNetwork(
        energy, networkMask, mask, H, W, dx, dy,
        interpMaxDistance, interpSmoothing,
      );
    }

    const t1 = performance.now();
    const out = {
      kind: "done",
      energy,
      passes,
      path,                  // null or array of flat indices
      pathEnergy,            // null or number
      pathLengthM: pathLengthCells,
      routes,                // null or array of route objects
      elapsedMs: t1 - t0,
    };
    const transfer = [energy.buffer];
    if (passes) transfer.push(passes.buffer);
    postMessage(out, transfer);
  } catch (err) {
    postMessage({ kind: "error", message: err.message });
  }
};
