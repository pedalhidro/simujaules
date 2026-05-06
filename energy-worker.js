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
function heapPush(h, priority, payload) {
  if (h.size >= h.capacity) heapGrow(h);
  let i = h.size++;
  h.priorities[i] = priority;
  h.payloads[i] = payload;
  // Sift up
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (h.priorities[parent] <= h.priorities[i]) break;
    [h.priorities[parent], h.priorities[i]] = [h.priorities[i], h.priorities[parent]];
    [h.payloads[parent], h.payloads[i]] = [h.payloads[i], h.payloads[parent]];
    i = parent;
  }
}
function heapPop(h) {
  if (h.size === 0) return null;
  const topPriority = h.priorities[0];
  const topPayload = h.payloads[0];
  h.size--;
  if (h.size > 0) {
    h.priorities[0] = h.priorities[h.size];
    h.payloads[0] = h.payloads[h.size];
    // Sift down
    let i = 0;
    const n = h.size;
    while (true) {
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      let smallest = i;
      if (l < n && h.priorities[l] < h.priorities[smallest]) smallest = l;
      if (r < n && h.priorities[r] < h.priorities[smallest]) smallest = r;
      if (smallest === i) break;
      [h.priorities[smallest], h.priorities[i]] = [h.priorities[i], h.priorities[smallest]];
      [h.payloads[smallest], h.payloads[i]] = [h.payloads[i], h.payloads[smallest]];
      i = smallest;
    }
  }
  return { priority: topPriority, payload: topPayload };
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
// Returns { E, parents, passes }. Any of parents/passes may be null.
function dijkstra(opts) {
  const {
    height, mask, H, W,
    seedR, seedC,
    alpha, beta, eta,
    dx, dy,
    reverse, trackParents,
    wantPasses,
    eMax = 0,                  // 0 = no budget; >0 = stop expanding past this
    // Per-cell progress messages get scaled into the range
    // [progressBase, progressBase + progressScale]. Default = full range,
    // i.e. one Dijkstra spans the whole bar. The density loop overrides
    // these to keep the overall compute monotonic 0→1 across N refs.
    progressBase = 0,
    progressScale = 1,
  } = opts;

  const N = H * W;
  const diag = Math.hypot(dx, dy);

  // 8-neighbor offsets and their ground distances
  const drs = [-1, -1, -1, 0, 0, 1, 1, 1];
  const dcs = [-1, 0, 1, -1, 1, -1, 0, 1];
  const dists = [diag, dy, diag, dx, dx, diag, dy, diag];

  const E = new Float32Array(N);
  E.fill(Infinity);
  const seedIdx = seedR * W + seedC;
  E[seedIdx] = 0;

  // wantPasses needs parent links for the subtree walk.
  const keepParents = trackParents || wantPasses;
  const parents = keepParents ? new Int32Array(N).fill(-1) : null;
  // `settled` filters stale heap entries. Using a boolean per-cell flag
  // instead of `g > E[idx]` because E is f32 and heap priorities are f64
  // (JS Number) — the precision mismatch would let multiple non-stale
  // entries pop for the same cell, blowing up the heap and capping the
  // reachable field at ~200 m before the heap drained.
  const settled = new Uint8Array(N);
  // Sequence of cells in pop order; required for the passes accumulation.
  const order = wantPasses ? new Int32Array(N) : null;
  let orderLen = 0;

  const heap = createHeap(Math.min(N, 1 << 16));
  heapPush(heap, 0, seedIdx);

  let progressed = 0;
  const reportEvery = Math.max(1000, Math.floor(N / 50));

  while (heap.size > 0) {
    const top = heapPop(heap);
    const g = top.priority;
    const idx = top.payload;
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

    for (let k = 0; k < 8; k++) {
      const nr = r + drs[k];
      const nc = c + dcs[k];
      if (nr < 0 || nr >= H || nc < 0 || nc >= W) continue;
      const nIdx = nr * W + nc;
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

  // Subtree accumulation for passes count: walk the settle order in reverse,
  // adding each cell's count to its parent. Result: passes[c] = number of
  // settled cells whose shortest path to the seed traverses c.
  let passes = null;
  if (wantPasses && order) {
    passes = new Float64Array(N);
    for (let j = 0; j < orderLen; j++) passes[order[j]] = 1;
    for (let j = orderLen - 1; j >= 0; j--) {
      const idx = order[j];
      const p = parents[idx];
      if (p >= 0) passes[p] += passes[idx];
    }
  }

  return { E, parents: trackParents ? parents : null, passes };
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
  } = opts;
  const N = H * W;
  const diag = Math.hypot(dx, dy);
  const drs = [-1, -1, -1, 0, 0, 1, 1, 1];
  const dcs = [-1, 0, 1, -1, 1, -1, 0, 1];
  const dists = [diag, dy, diag, dx, dx, diag, dy, diag];

  const startIdx = startR * W + startC;
  const goalIdx = goalR * W + goalC;
  if (!mask[startIdx] || !mask[goalIdx]) {
    return { path: null, energy: Infinity, length: 0 };
  }

  const E = new Float32Array(N); E.fill(Infinity);
  const L = new Float32Array(N); L.fill(Infinity);
  const parents = new Int32Array(N).fill(-1);
  const settled = new Uint8Array(N);

  const hGoal = height[goalIdx];
  const heuristic = (idx) => {
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
    const top = heapPop(heap);
    const idx = top.payload;
    if (settled[idx]) continue;
    settled[idx] = 1;
    if (idx === goalIdx) break;

    const g = E[idx];
    const r = (idx / W) | 0;
    const c = idx - r * W;
    const hHere = height[idx];

    for (let k = 0; k < 8; k++) {
      const nr = r + drs[k];
      const nc = c + dcs[k];
      if (nr < 0 || nr >= H || nc < 0 || nc >= W) continue;
      const nIdx = nr * W + nc;
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

// ------- Worker message handler -------
self.onmessage = (ev) => {
  const msg = ev.data;
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
    wantDensity = false,                                  // multi-ref passes density
    refPoints = null,                                     // [[r0,c0],[r1,c1], …]
    densityMode = "from",                                 // mode for each ref's Dijkstra
  } = msg;

  const wantPath = goalR >= 0 && goalC >= 0;
  const goalIdx = wantPath ? goalR * W + goalC : -1;
  const N = H * W;

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
    if (mode === "from") {
      const r = dijkstra({
        height, mask, H, W,
        seedR, seedC,
        alpha, beta, eta, dx, dy,
        reverse: false, trackParents: wantPath,
        wantPasses, eMax,
      });
      energy = r.E;
      passes = r.passes;
      if (wantPath && Number.isFinite(energy[goalIdx])) {
        path = reconstructPath(r.parents, goalIdx);
        pathEnergy = energy[goalIdx];
      }
    } else if (mode === "to") {
      const r = dijkstra({
        height, mask, H, W,
        seedR, seedC,
        alpha, beta, eta, dx, dy,
        reverse: true, trackParents: wantPath,
        wantPasses, eMax,
      });
      energy = r.E;
      passes = r.passes;
      if (wantPath && Number.isFinite(energy[goalIdx])) {
        path = reconstructPath(r.parents, goalIdx);
        pathEnergy = energy[goalIdx];
      }
    } else {
      // round trip: forward + reverse, sum
      const f = dijkstra({
        height, mask, H, W,
        seedR, seedC,
        alpha, beta, eta, dx, dy,
        reverse: false, trackParents: wantPath,
        wantPasses, eMax,
      });
      const b = dijkstra({
        height, mask, H, W,
        seedR, seedC,
        alpha, beta, eta, dx, dy,
        reverse: true, trackParents: false,
        wantPasses, eMax,
      });
      energy = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        const a = f.E[i];
        const c = b.E[i];
        energy[i] = (a === Infinity || c === Infinity) ? Infinity : a + c;
      }
      if (wantPasses && f.passes && b.passes) {
        passes = new Float64Array(N);
        for (let i = 0; i < N; i++) passes[i] = f.passes[i] + b.passes[i];
      }
      // For round trip, the "path" is ambiguous (outbound vs return differ).
      // Report the outbound path here for visualisation.
      if (wantPath && Number.isFinite(energy[goalIdx])) {
        path = reconstructPath(f.parents, goalIdx);
        pathEnergy = energy[goalIdx];
      }
    }

    // Multi-reference passes density. For each reference point, run a Dijkstra
    // (with passes), normalise by H*W, sum across references, normalise by
    // H*W again. Replaces the regular `passes` output. The first reference's
    // energy field also goes back as `energy` (so the energy layer still has
    // something to render); subsequent references' energy fields are not
    // returned individually.
    if (wantDensity && Array.isArray(refPoints) && refPoints.length > 0) {
      const density = new Float64Array(N);
      let firstEnergy = null;
      const dmode = densityMode || "from";
      const K = refPoints.length;
      const slice = 1 / K;
      for (let k = 0; k < K; k++) {
        const [refR, refC] = refPoints[k];
        if (refR < 0 || refR >= H || refC < 0 || refC >= W) continue;
        if (!mask[refR * W + refC]) continue;

        const base = k / K;

        let perRefPasses;
        if (dmode === "round") {
          // Forward + reverse share this ref's slice equally.
          const f = dijkstra({
            height, mask, H, W,
            seedR: refR, seedC: refC,
            alpha, beta, eta, dx, dy,
            reverse: false, trackParents: false,
            wantPasses: true, eMax,
            progressBase: base, progressScale: slice * 0.5,
          });
          const b = dijkstra({
            height, mask, H, W,
            seedR: refR, seedC: refC,
            alpha, beta, eta, dx, dy,
            reverse: true, trackParents: false,
            wantPasses: true, eMax,
            progressBase: base + slice * 0.5, progressScale: slice * 0.5,
          });
          perRefPasses = new Float64Array(N);
          for (let i = 0; i < N; i++) perRefPasses[i] = f.passes[i] + b.passes[i];
          if (k === 0) firstEnergy = f.E;
        } else {
          const r = dijkstra({
            height, mask, H, W,
            seedR: refR, seedC: refC,
            alpha, beta, eta, dx, dy,
            reverse: dmode === "to", trackParents: false,
            wantPasses: true, eMax,
            progressBase: base, progressScale: slice,
          });
          perRefPasses = r.passes;
          if (k === 0) firstEnergy = r.E;
        }
        // First normalisation: each reference's count becomes a density
        // (passes per cell over the grid).
        for (let i = 0; i < N; i++) density[i] += perRefPasses[i] / N;
        // Snap progress to the slice boundary at end of each ref so the
        // bar lines up with the "ref X/K" status text the main thread
        // shows. The per-cell ticks above already cover the slice
        // monotonically; this is just a clean checkpoint.
        postMessage({ kind: "progress", progress: (k + 1) / K });
      }
      // Second normalisation: divide the accumulated density by H*W again,
      // matching the user-specified definition.
      for (let i = 0; i < N; i++) density[i] /= N;

      passes = density;
      if (firstEnergy) energy = firstEnergy;
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
          height, mask, H, W,
          startR: seedR, startC: seedC,
          goalR, goalC,
          alpha, beta, eta, dx, dy,
          penalty: pen, usedCount,
          repulsionMode, distUsed,
          eMax,
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
