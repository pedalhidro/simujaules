// test-graph-engine.mjs — self-contained regression test for graph-engine.js.
// Run: node test-graph-engine.mjs
//
// Covers: cost-model parity with the grid step, planarization in BOTH junction
// modes (shared-endpoints vs also-at-crossings), per-edge passes accumulation,
// and Dijkstra path reconstruction. No DEM file needed — synthetic grids.
import GraphEngine from "./graph-engine.js";

let failures = 0;
const approx = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
function ok(name, cond, extra = "") { console.log(`${cond ? "  ok  " : "FAIL  "}${name}${extra ? "  — " + extra : ""}`); if (!cond) failures++; }

// Flat DEM helper: H×W, all heights `h`, all valid.
function flatDem(H, W, h = 0, dxM = 10, dyM = 10) {
  return { height: new Float32Array(H * W).fill(h), mask: new Uint8Array(H * W).fill(1), H, W, dxM, dyM };
}

// v2 cost bundle (see graph-engine.js stepCost). climbThr=0.05 so flat steps get
// aero and the ±3/±5-per-10m grades count as climbs/descents. beta dominates the
// distance term (climbing out of a valley is dear) so the flat deck still beats
// the descend-then-climb route. abRatio=(aRoll+aAero)/beta keeps it self-consistent.
const cost = { aRoll: 0.5, aAero: 0.5, beta: 10.0, climbThr: 0.05, abRatio: 0.1, epsOffset: 0.13 };
const distStep = cost.aRoll + cost.aAero; // flat-step cost per ground metre (rolling + flat aero)

// ---- 1. cost-model parity: one graph edge == one grid step ------------------
{
  const dxM = 10;
  // Two adjacent cells, hA=0, hB=3 (uphill). One horizontal edge between them.
  const H = 1, W = 2;
  const dem = { height: new Float32Array([0, 3]), mask: new Uint8Array([1, 1]), H, W, dxM, dyM: 10 };
  const lines = [[[0, 0], [0, 1]]];
  const g = GraphEngine.buildGraph(lines, dem, { stepCells: 1, junctionMode: "shared" });
  const { costAB, costBA } = GraphEngine.directedCosts(g, { cost });
  const gridUp = GraphEngine.stepCost(dxM, 3, cost);   // +3/10 = 30% ≥ climbThr ⇒ no aero: aRoll*10 + beta*3
  const gridDn = GraphEngine.stepCost(dxM, -3, cost);  // descent: rolling+aero − ε·beta·3, floored ≥0
  ok("uphill edge cost == grid step", approx(costAB[0], gridUp), `got ${costAB[0]} want ${gridUp}`);
  ok("downhill edge cost == grid step", approx(costBA[0], gridDn), `got ${costBA[0]} want ${gridDn}`);
  // v2 downhill closed form: per-grade ε recovery on the descent, floored at 0.
  const s = 3 / dxM;
  let eps = Math.min(1, cost.abRatio / s) - cost.epsOffset; if (eps < 0) eps = 0; else if (eps > 1) eps = 1;
  const wantDn = Math.max(0, distStep * dxM - eps * cost.beta * 3);
  ok("downhill v2 recovery applied", approx(gridDn, wantDn), `got ${gridDn} want ${wantDn}`);
}

// ---- 2. planarization: X-crossing, no shared vertex -------------------------
{
  const dem = flatDem(5, 5, 0);
  const lines = [
    [[0, 0], [4, 4]], // main diagonal
    [[0, 4], [4, 0]], // anti-diagonal — crosses the first at (2,2), no shared vtx
  ];
  const shared = GraphEngine.buildGraph(lines, dem, { junctionMode: "shared" });
  ok("shared: 4 nodes (endpoints only)", shared.nNodes === 4, `nNodes=${shared.nNodes}`);
  ok("shared: 2 edges (lines unsplit)", shared.nEdges === 2, `nEdges=${shared.nEdges}`);

  const crossed = GraphEngine.buildGraph(lines, dem, { junctionMode: "crossings" });
  ok("crossings: 5 nodes (+center)", crossed.nNodes === 5, `nNodes=${crossed.nNodes}`);
  ok("crossings: 4 edges (split at center)", crossed.nEdges === 4, `nEdges=${crossed.nEdges}`);

  // Connectivity: shared mode leaves two components; crossings joins them.
  const comps = (g) => {
    const seen = new Uint8Array(g.nNodes); let c = 0;
    for (let s = 0; s < g.nNodes; s++) {
      if (seen[s]) continue; c++; const stack = [s]; seen[s] = 1;
      while (stack.length) { const u = stack.pop(); for (let he = g.csrHead[u]; he < g.csrHead[u + 1]; he++) { const v = g.csrTarget[he]; if (!seen[v]) { seen[v] = 1; stack.push(v); } } }
    }
    return c;
  };
  ok("shared: 2 disconnected components", comps(shared) === 2, `comps=${comps(shared)}`);
  ok("crossings: 1 connected component", comps(crossed) === 1, `comps=${comps(crossed)}`);
}

// ---- 3. density passes follow edges (linear chain) --------------------------
{
  const dem = flatDem(1, 4, 0);
  const lines = [[[0, 0], [0, 1], [0, 2], [0, 3]]]; // 3 segments → edges 0,1,2
  const g = GraphEngine.buildGraph(lines, dem, { junctionMode: "shared" });
  ok("chain: 4 nodes / 3 edges", g.nNodes === 4 && g.nEdges === 3);
  const refNode = GraphEngine.nearestNode(g, 0, 0);
  const res = GraphEngine.computeGraph(g, { mode: "density", densityMode: "from", cost, eMax: 0, refNodes: [refNode] });
  // Subtree sizes from the root: 3, 2, 1 along the chain.
  const passes = Array.from(res.edgePasses).sort((a, b) => b - a);
  ok("chain passes are {3,2,1}", passes.join(",") === "3,2,1", `got ${passes.join(",")}`);
  ok("root edge carries all 3", res.edgePasses[0] === 3, `edge0=${res.edgePasses[0]}`);
}

// ---- 4. dijkstra path reconstruction + energy (flat chain) ------------------
{
  const dxM = 10, dem = flatDem(1, 4, 0, dxM, 10);
  const lines = [[[0, 0], [0, 1], [0, 2], [0, 3]]];
  const g = GraphEngine.buildGraph(lines, dem, { junctionMode: "shared" });
  const src = GraphEngine.nearestNode(g, 0, 0), dst = GraphEngine.nearestNode(g, 0, 3);
  const res = GraphEngine.computeGraph(g, { mode: "from", cost, eMax: 0, srcNode: src, dstNode: dst, wantPath: true });
  ok("path reaches dst", !!res.path && res.path.nodes[0] === dst && res.path.nodes[res.path.nodes.length - 1] === src);
  ok("path length == 3 cells", approx(res.path.lengthM, 3 * dxM), `got ${res.path.lengthM}`);
  ok("path energy == 3 flat steps", approx(res.path.energy, 3 * distStep * dxM), `got ${res.path.energy}`);
}

// ---- 5. budget prunes the search --------------------------------------------
{
  const dxM = 10, dem = flatDem(1, 10, 0, dxM, 10);
  const lines = [[Array.from({ length: 10 }, (_, c) => [0, c])][0]]; // one 9-segment chain
  const chain = [];
  for (let c = 0; c < 10; c++) chain.push([0, c]);
  const g = GraphEngine.buildGraph([chain], dem, { junctionMode: "shared" });
  const src = GraphEngine.nearestNode(g, 0, 0);
  // budget = 2.5 flat steps → only ~2 edges reachable
  const eMax = 2.5 * distStep * dxM;
  const res = GraphEngine.computeGraph(g, { mode: "from", cost, eMax, srcNode: src, dstNode: -1 });
  const reached = Array.from(res.edgePasses).filter((p) => p > 0).length;
  ok("budget limits reached edges", reached === 2, `reached=${reached}`);
}

// ---- 6. top-N route diversity (diamond: cheap top path vs longer bottom) ----
{
  const dem = flatDem(3, 3, 0);
  const lines = [
    [[0, 0], [0, 1], [0, 2]], // top: 2 unit edges (cheapest)
    [[0, 0], [2, 1], [0, 2]], // bottom: 2 longer diagonal edges
  ];
  const g = GraphEngine.buildGraph(lines, dem, { junctionMode: "shared" });
  const src = GraphEngine.nearestNode(g, 0, 0), dst = GraphEngine.nearestNode(g, 0, 2);
  const res = GraphEngine.computeGraph(g, { mode: "from", cost, eMax: 0, srcNode: src, dstNode: dst, wantTopN: true, nRoutes: 2, penalty: 4 });
  ok("top-N returns 2 routes", res.routes && res.routes.length === 2, `got ${res.routes && res.routes.length}`);
  if (res.routes && res.routes.length === 2) {
    const set0 = res.routes[0].edges.slice().sort().join(","), set1 = res.routes[1].edges.slice().sort().join(",");
    ok("the two routes are distinct", set0 !== set1);
    ok("route 1 cheaper than route 2", res.routes[0].energy < res.routes[1].energy, `${res.routes[0].energy} vs ${res.routes[1].energy}`);
  }
}

// ---- 7. maximize: max-energy walk of L edges prefers climbing -------------
{
  const dxM = 10, W = 6;
  // Heights rise +5 m per cell to the right: uphill edges are the costliest.
  const dem = { height: new Float32Array(Array.from({ length: W }, (_, c) => c * 5)), mask: new Uint8Array(W).fill(1), H: 1, W, dxM, dyM: 10 };
  const chain = []; for (let c = 0; c < W; c++) chain.push([0, c]);
  const g = GraphEngine.buildGraph([chain], dem, { junctionMode: "shared" });
  const src = GraphEngine.nearestNode(g, 0, 0);
  const res = GraphEngine.computeGraph(g, { mode: "from", cost, eMax: 0, srcNode: src, dstNode: -1, maximize: true, maximizeLength: 3 });
  ok("maximize walk has L=3 edges", res.path && res.path.edges.length === 3, `got ${res.path && res.path.edges.length}`);
  const want = 3 * (cost.aRoll * dxM + cost.beta * 5); // three uphill steps (≥climbThr ⇒ no aero)
  ok("maximize energy == 3 uphill steps", res.path && approx(res.path.energy, want), `got ${res.path && res.path.energy} want ${want}`);
}

// ---- 8. nodes outside the DEM extent are excluded (clip to extent) ----------
{
  const dem = flatDem(1, 4, 0); // W=4 → valid cols 0..3
  // Chain runs off the right edge: cols 0..5; cols 4,5 are out of extent.
  const chain = [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4], [0, 5]];
  const g = GraphEngine.buildGraph([chain], dem, { junctionMode: "shared" });
  let invalid = 0;
  for (let i = 0; i < g.nNodes; i++) if (!g.nodeValid[i]) invalid++;
  ok("out-of-extent nodes marked invalid", invalid === 2, `invalid=${invalid}`);
  const src = GraphEngine.nearestNode(g, 0, 0);
  const res = GraphEngine.computeGraph(g, { mode: "density", densityMode: "from", cost, eMax: 0, refNodes: [src] });
  const reached = Array.from(res.edgePasses).filter((p) => p > 0).length;
  ok("passes stop at the DEM extent (3 in-bounds edges)", reached === 3, `reached=${reached}`);
}

// Connected-component count over the graph CSR — shared by the crossings tests.
function graphComps(g) {
  const seen = new Uint8Array(g.nNodes); let c = 0;
  for (let s = 0; s < g.nNodes; s++) {
    if (seen[s]) continue; c++; const stack = [s]; seen[s] = 1;
    while (stack.length) { const u = stack.pop(); for (let he = g.csrHead[u]; he < g.csrHead[u + 1]; he++) { const v = g.csrTarget[he]; if (!seen[v]) { seen[v] = 1; stack.push(v); } } }
  }
  return c;
}

// ---- 9. Phase C: bridge/tunnel deck flattening (lineMeta) -------------------
{
  const dxM = 10;
  // A 5-cell line over a valley: ends at 10 m, middle dips to 0 (the DEM shows
  // the gap under the deck). The deck should read flat at 10 m end-to-end.
  const dem = { height: new Float32Array([10, 0, 0, 0, 10]), mask: new Uint8Array(5).fill(1), H: 1, W: 5, dxM, dyM: 10 };
  const chain = [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4]];
  const mkRes = (lineMeta) => {
    const g = GraphEngine.buildGraph([chain], dem, { junctionMode: "shared", lineMeta });
    const src = GraphEngine.nearestNode(g, 0, 0), dst = GraphEngine.nearestNode(g, 0, 4);
    return GraphEngine.computeGraph(g, { mode: "from", cost, eMax: 0, srcNode: src, dstNode: dst, wantPath: true });
  };
  const plain = mkRes(null);
  const deck = mkRes([{ deck: true, layer: 1 }]);
  const flat = 4 * distStep * dxM; // 4 edges, each a flat 10 m step (no climb)
  ok("deck flattens to the flat-deck cost", approx(deck.path.energy, flat), `got ${deck.path.energy} want ${flat}`);
  ok("deck is cheaper than following the valley", deck.path.energy < plain.path.energy - 1e-6, `deck ${deck.path.energy} vs plain ${plain.path.energy}`);
}

// ---- 10. Phase C: layer-aware junction suppression (overpass) ---------------
{
  const dem = flatDem(5, 5, 0);
  const lines = [[[0, 0], [4, 4]], [[0, 4], [4, 0]]]; // cross at (2,2), no shared vtx
  // A deck (layer 1) crossing a ground road (layer 0): no junction -> 2 components.
  const over = GraphEngine.buildGraph(lines, dem, { junctionMode: "crossings", lineMeta: [{ deck: true, layer: 1 }, { deck: false, layer: 0 }] });
  ok("overpass: crossing suppressed (no center node)", over.nNodes === 4, `nNodes=${over.nNodes}`);
  ok("overpass: lines stay unsplit (2 edges)", over.nEdges === 2, `nEdges=${over.nEdges}`);
  ok("overpass: deck & road stay disconnected", graphComps(over) === 2, `comps=${graphComps(over)}`);
  // Two ways at the SAME layer still cross at-grade (1 component).
  const same = GraphEngine.buildGraph(lines, dem, { junctionMode: "crossings", lineMeta: [{ deck: true, layer: 1 }, { deck: true, layer: 1 }] });
  ok("same-layer crossing still connects", graphComps(same) === 1, `comps=${graphComps(same)}`);
}

// ---- 11. crossings mode finds NON-axis-aligned intersections (fuzz) ---------
// Regression for the bucket-rasterisation miss: the old length-stepped DDA
// inserted one floor cell per Euclidean step and could skip cells, so two
// genuinely-crossing segments shared no bucket and stayed in separate
// components. We fuzz random segment pairs that PROPERLY cross (interior to
// both) and assert crossings mode merges them into one connected component.
{
  // Orientation sign of (p,q,r); 0 = collinear. Points are [r,c] -> (x=c,y=r).
  const orient = (p, q, r) => Math.sign((q[1] - p[1]) * (r[0] - p[0]) - (q[0] - p[0]) * (r[1] - p[1]));
  // Proper interior crossing (no shared endpoint, no collinearity).
  const properCross = (a, b, c, d) => {
    const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
    return o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0 && o1 !== o2 && o3 !== o4;
  };
  // Deterministic PRNG (mulberry32) so the test never flakes.
  let seed = 0x1234abcd;
  const rnd = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const G = 24, dem = flatDem(G, G, 0);
  const pt = () => [1 + rnd() * (G - 3), 1 + rnd() * (G - 3)]; // [r,c], interior to extent
  let crossingsTested = 0, missed = 0, trials = 0;
  while (crossingsTested < 400 && trials < 40000) {
    trials++;
    const a = pt(), b = pt(), c0 = pt(), d = pt();
    if (!properCross(a, b, c0, d)) continue;
    crossingsTested++;
    const g = GraphEngine.buildGraph([[a, b], [c0, d]], dem, { junctionMode: "crossings" });
    if (graphComps(g) !== 1) missed++;
  }
  ok("crossings: fuzz finds every proper intersection", missed === 0,
     `tested ${crossingsTested} crossings, ${missed} missed`);
  // Explicit shallow (non-45 deg) diagonal X - the kind the old DDA dropped.
  {
    const g = GraphEngine.buildGraph([[[1, 1], [3, 21]], [[3, 1], [1, 21]]], flatDem(24, 24, 0), { junctionMode: "crossings" });
    ok("crossings: shallow-diagonal X is one component", graphComps(g) === 1, `comps=${graphComps(g)}`);
  }
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
