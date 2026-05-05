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
// Returns { E: Float32Array, parents: Int32Array | null }
function dijkstra(opts) {
  const {
    height, mask, H, W,
    seedR, seedC,
    alpha, beta, eta,
    dx, dy,
    reverse, trackParents,
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

  const parents = trackParents ? new Int32Array(N).fill(-1) : null;

  const heap = createHeap(Math.min(N, 1 << 16));
  heapPush(heap, 0, seedIdx);

  let progressed = 0;
  const reportEvery = Math.max(1000, Math.floor(N / 50));

  while (heap.size > 0) {
    const top = heapPop(heap);
    const g = top.priority;
    const idx = top.payload;
    if (g > E[idx]) continue;

    progressed++;
    if (progressed % reportEvery === 0) {
      // Coarse progress: fraction of mask cells settled (approximation).
      postMessage({ kind: "progress", progress: progressed / N });
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
      if (tentative < E[nIdx]) {
        E[nIdx] = tentative;
        if (parents) parents[nIdx] = idx;
        heapPush(heap, tentative, nIdx);
      }
    }
  }

  return { E, parents };
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
    goalR, goalC, // optional, may be -1 / -1
    mode, // "from" | "to" | "round"
    alpha, beta, eta,
  } = msg;

  const wantPath = goalR >= 0 && goalC >= 0;
  const goalIdx = wantPath ? goalR * W + goalC : -1;

  let energy;
  let path = null;
  let pathEnergy = null;
  let pathLengthCells = null;

  try {
    if (mode === "from") {
      const r = dijkstra({
        height, mask, H, W,
        seedR, seedC,
        alpha, beta, eta, dx, dy,
        reverse: false, trackParents: wantPath,
      });
      energy = r.E;
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
      });
      energy = r.E;
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
      });
      const b = dijkstra({
        height, mask, H, W,
        seedR, seedC,
        alpha, beta, eta, dx, dy,
        reverse: true, trackParents: false,
      });
      const N = H * W;
      energy = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        const a = f.E[i];
        const c = b.E[i];
        energy[i] = (a === Infinity || c === Infinity) ? Infinity : a + c;
      }
      // For round trip, the "path" is ambiguous (outbound vs return differ).
      // Report the outbound path here for visualisation.
      if (wantPath && Number.isFinite(energy[goalIdx])) {
        path = reconstructPath(f.parents, goalIdx);
        pathEnergy = energy[goalIdx];
      }
    }

    // Compute path length in metres
    if (path) {
      let len = 0;
      for (let i = 1; i < path.length; i++) {
        const a = path[i - 1], b = path[i];
        const ar = (a / W) | 0, ac = a - ar * W;
        const br = (b / W) | 0, bc = b - br * W;
        const drM = (br - ar) * dy;
        const dcM = (bc - ac) * dx;
        len += Math.hypot(drM, dcM);
      }
      pathLengthCells = len;
    }

    const t1 = performance.now();
    postMessage(
      {
        kind: "done",
        energy,
        path, // null or array of flat indices
        pathEnergy, // null or number
        pathLengthM: pathLengthCells,
        elapsedMs: t1 - t0,
      },
      [energy.buffer] // transfer ownership for speed
    );
  } catch (err) {
    postMessage({ kind: "error", message: err.message });
  }
};
