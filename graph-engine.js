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
  // Bilinear DEM elevation at fractional (r, c). Mask-aware: corners that are
  // nodata (mask 0) are dropped from the weighted average; if all four are
  // nodata we fall back to the floor cell's raw height (the network shouldn't
  // sit on nodata, but we stay finite rather than poison the cost with NaN).
  function sampleHeight(height, mask, H, W, r, c) {
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
  // ONE step of the asymmetric cost, identical to energy-worker.js:
  //   dh ≥ 0 (uphill):   alpha*d + beta*dh
  //   dh < 0 (downhill):  max(0, alpha*d - eta*beta*|dh|)
  function stepCost(d, dh, alpha, beta, eta) {
    if (dh >= 0) return alpha * d + beta * dh;
    const e = alpha * d - eta * beta * (-dh);
    return e < 0 ? 0 : e;
  }

  // Walk an edge's stored elevation profile (samples h[0..n] from A→B, equal
  // metric steps of stepM) and sum the per-step cost. `forward` false walks
  // B→A. Per-STEP application of the downhill floor is what keeps parity with
  // the grid model (the floor is non-linear, so a closed-form on Σdh is wrong).
  function profileCost(prof, off, n, stepM, forward, alpha, beta, eta) {
    let total = 0;
    if (forward) {
      for (let i = 0; i < n; i++) total += stepCost(stepM, prof[off + i + 1] - prof[off + i], alpha, beta, eta);
    } else {
      for (let i = n; i > 0; i--) total += stepCost(stepM, prof[off + i - 1] - prof[off + i], alpha, beta, eta);
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

    // Flatten polylines into segments [rA,cA,zA, rB,cB,zB, lineId].
    const segs = [];
    let anyZ = false;
    for (let li = 0; li < lines.length; li++) {
      const ln = lines[li];
      for (let k = 0; k + 1 < ln.length; k++) {
        const a = ln[k], b = ln[k + 1];
        const za = a.length > 2 ? a[2] : NaN, zb = b.length > 2 ? b[2] : NaN;
        if (a[0] === b[0] && a[1] === b[1]) continue; // zero-length
        if (!Number.isNaN(za) || !Number.isNaN(zb)) anyZ = true;
        segs.push([a[0], a[1], za, b[0], b[1], zb, li]);
      }
    }

    // Crossings mode: find intersections via a cell-bucket spatial hash, then
    // record split parameters per segment. Skip crossings whose interpolated Z
    // differs by > zTol on the two segments (bridges/overpasses) when Z exists.
    const splits = segs.map(() => []); // per seg: list of t in (0,1)
    if (junctionMode === "crossings") {
      const buckets = new Map(); // "ri|ci" -> [segIdx,…]
      const addBucket = (key, idx) => { let a = buckets.get(key); if (!a) { a = []; buckets.set(key, a); } a.push(idx); };
      for (let s = 0; s < segs.length; s++) {
        const [r1, c1, , r2, c2] = segs[s];
        // Insert into every integer cell the segment passes through (DDA).
        const steps = Math.max(1, Math.ceil(Math.hypot(r2 - r1, c2 - c1)));
        for (let i = 0; i <= steps; i++) {
          const rr = Math.floor(r1 + (r2 - r1) * (i / steps));
          const cc = Math.floor(c1 + (c2 - c1) * (i / steps));
          addBucket(rr + "|" + cc, s);
        }
      }
      const tested = new Set();
      for (const arr of buckets.values()) {
        for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) {
          const a = arr[i], b = arr[j];
          if (segs[a][6] === segs[b][6]) continue;          // same polyline
          const pk = a < b ? a * segs.length + b : b * segs.length + a;
          if (tested.has(pk)) continue; tested.add(pk);
          const A = segs[a], B = segs[b];
          const hit = segIntersect(A[0], A[1], A[3], A[4], B[0], B[1], B[3], B[4], eps);
          if (!hit) continue;
          if (anyZ) {
            const zA = A[2] + (A[5] - A[2]) * hit.t, zB = B[2] + (B[5] - B[2]) * hit.u;
            if (Number.isFinite(zA) && Number.isFinite(zB) && Math.abs(zA - zB) > zTol) continue;
          }
          splits[a].push(hit.t); splits[b].push(hit.u);
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
      const key = na < nb ? na * 1 + "_" + nb : nb + "_" + na;
      let e = edgeMap.get(key);
      if (e === undefined) { e = edgeA.length; edgeA.push(na); edgeB.push(nb); edgeMap.set(key, e); }
      return e;
    };
    for (let s = 0; s < segs.length; s++) {
      const [r1, c1, , r2, c2] = segs[s];
      const ts = splits[s];
      let cuts;
      if (ts.length === 0) cuts = [0, 1];
      else { cuts = ts.slice().sort((x, y) => x - y); cuts.unshift(0); cuts.push(1); }
      for (let k = 0; k + 1 < cuts.length; k++) {
        const ta = cuts[k], tb = cuts[k + 1];
        if (tb - ta < eps) continue;
        const na = nodeOf(r1 + (r2 - r1) * ta, c1 + (c2 - c1) * ta);
        const nb = nodeOf(r1 + (r2 - r1) * tb, c1 + (c2 - c1) * tb);
        pushEdge(na, nb);
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
    const { alpha, beta, eta } = params;
    const costAB = new Float64Array(g.nEdges), costBA = new Float64Array(g.nEdges);
    for (let e = 0; e < g.nEdges; e++) {
      const off = g.profOff[e], n = g.profOff[e + 1] - off - 1, stepM = g.edgeStepM[e];
      costAB[e] = profileCost(g.profH, off, n, stepM, true, alpha, beta, eta);
      costBA[e] = profileCost(g.profH, off, n, stepM, false, alpha, beta, eta);
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
    for (let i = 0; i < seeds.length; i++) { const s = seeds[i]; if (s >= 0 && s < nN && g.nodeValid[s] && E[s] !== 0) { E[s] = 0; heap.push(0, s); } }
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
  // penalty multiplies the alpha*dist component of an edge by penalty^usedCount
  // — the graph analogue of energy-worker's per-cell repulsion. (linear/square
  // repulsion are grid distance-transform modes; on a graph they reduce to this
  // per-edge form for now — see the README note.) Route energies are reported
  // UN-penalised (true energy); sharedEdges counts edges shared with other routes.
  function topN(g, costAB, costBA, src, dst, eMax, nRoutes, penalty, alpha) {
    const used = new Int32Array(g.nEdges);
    const pAB = new Float64Array(g.nEdges), pBA = new Float64Array(g.nEdges);
    const pen = penalty > 1 ? penalty : 1;
    const routes = [];
    const globalUse = new Int32Array(g.nEdges);
    for (let i = 0; i < nRoutes; i++) {
      for (let e = 0; e < g.nEdges; e++) {
        const bump = (Math.pow(pen, used[e]) - 1) * alpha * g.edgeLenM[e];
        pAB[e] = costAB[e] + bump; pBA[e] = costBA[e] + bump;
      }
      const tree = dijkstra(g, pAB, pBA, [src], eMax, false);
      if (!tree.settled[dst]) break;
      const path = reconstructPath(g, tree, dst);
      if (!path || !path.edges.length) break;
      let lenM = 0; for (let k = 0; k < path.edges.length; k++) lenM += g.edgeLenM[path.edges[k]];
      const energy = pathEnergy(g, costAB, costBA, path, false);
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
  function maximizeWalk(g, costAB, costBA, src, L, dst) {
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
          const w = atob ? costAB[e] : costBA[e];
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
  // params: {mode, alpha, beta, eta, eMax, eMaxMode, srcNode, dstNode, refNodes,
  //  wantPath, wantTopN, nRoutes, penalty, maximize, maximizeLength}.
  function computeGraph(g, params) {
    const t0 = nowMs();
    const { costAB, costBA } = directedCosts(g, params);
    const eMax = params.eMax > 0 ? params.eMax : 0;
    const totalCap = params.eMaxMode === "total" && eMax > 0 ? eMax : 0;
    const edgePass = new Float64Array(g.nEdges);
    let edgeEnergy = null, nodeEnergy = null, path = null;

    // maximize: layered-DP max-energy walk of L edges (its own path + field).
    if (params.maximize) {
      const L = params.maximizeLength > 0 ? params.maximizeLength : 1;
      const mw = maximizeWalk(g, costAB, costBA, params.srcNode, L, params.dstNode != null ? params.dstNode : -1);
      nodeEnergy = new Float32Array(g.nNodes).fill(NaN);
      for (let v = 0; v < g.nNodes; v++) if (mw.bestNode[v] > -Infinity) nodeEnergy[v] = mw.bestNode[v];
      if (mw.path) for (let k = 0; k < mw.path.edges.length; k++) edgePass[mw.path.edges[k]] = 1;
      return {
        edgePasses: edgePass, edgeEnergy: edgeEnergyFromNodes(g, nodeEnergy), nodeEnergy,
        path: mw.path, routes: null, elapsedMs: nowMs() - t0,
      };
    }

    // top-N: base field + passes from src, then diverse penalised routes.
    if (params.wantTopN && params.dstNode >= 0) {
      const base = dijkstra(g, costAB, costBA, [params.srcNode], eMax, false);
      accumulatePasses(g, base, edgePass, null);
      nodeEnergy = new Float32Array(g.nNodes).fill(NaN);
      for (let j = 0; j < base.orderLen; j++) { const v = base.order[j]; nodeEnergy[v] = base.E[v]; }
      const { routes } = topN(g, costAB, costBA, params.srcNode, params.dstNode, eMax, params.nRoutes > 0 ? params.nRoutes : 1, params.penalty, params.alpha);
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
      // energy along the path = sum of directed costs in travel order
      en = pathEnergy(g, costAB, costBA, path, params.mode === "to");
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
