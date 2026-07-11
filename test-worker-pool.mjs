// Self-contained regression test for energy-worker.js — no DEM file needed.
// Drives the worker through its real onmessage handler and asserts:
//   1. structural invariants of the from/to/round/eMax/top-N outputs;
//   2. the worker-pool density protocol (densityPartial slices, merged the
//      way app.js merges them) matches the single-run density path exactly.
// Run: node test-worker-pool.mjs
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const here = dirname(fileURLToPath(import.meta.url));

function loadWorker() {
  const src = readFileSync(join(here, "energy-worker.js"), "utf8");
  const messages = [];
  const sandbox = { postMessage: (m) => messages.push(m), self: {}, performance, console };
  new Function(...Object.keys(sandbox), src)(...Object.values(sandbox));
  return (msg) => {
    messages.length = 0;
    sandbox.self.onmessage({ data: msg });
    const err = messages.find((m) => m.kind === "error");
    if (err) throw new Error("worker error: " + err.message);
    return messages.find((m) => m.kind === "done");
  };
}

const run = loadWorker();

// Synthetic DEM: smooth deterministic hills + nodata holes.
const H = 256, W = 256, N = H * W;
const height = new Float32Array(N);
for (let r = 0; r < H; r++)
  for (let c = 0; c < W; c++)
    height[r * W + c] =
      50 * Math.sin(r * 0.013) * Math.cos(c * 0.017) +
      20 * Math.sin(r * 0.05 + c * 0.031) + 800;
const mask = new Uint8Array(N).fill(1);
for (let i = 0; i < N; i += 997) mask[i] = 0;

const base = {
  kind: "run", H, W, dx: 30, dy: 30,
  cost: { aRoll: 1, aAero: 0.5, beta: 30, climbThr: 0.05, abRatio: 0.05, epsOffset: 0.13 },
  seedR: 100, seedC: 90, goalR: 200, goalC: 210, mode: "from",
};
const msg = (over) => ({
  ...base,
  height: new Float32Array(height),
  mask: new Uint8Array(mask),
  ...over,
});

let failures = 0;
function assert(cond, label) {
  console.log(`  ${cond ? "✓" : "✗ FAIL:"} ${label}`);
  if (!cond) failures++;
}

// ---- 1. single-run invariants ----
{
  console.log("from + passes + path");
  const m = msg({ wantPasses: true });
  const r = run(m);
  const seedIdx = base.seedR * W + base.seedC;
  let settledCount = 0, negE = 0, badPass = 0;
  for (let i = 0; i < N; i++) {
    if (Number.isFinite(r.energy[i])) {
      settledCount++;
      if (r.energy[i] < 0) negE++;
      if (!(r.passes[i] >= 1)) badPass++;          // every settled cell counts itself
    } else if (r.passes[i] !== 0) badPass++;        // unreachable ⇒ zero passes
  }
  assert(r.energy[seedIdx] === 0, "E[seed] = 0");
  assert(negE === 0, "energies non-negative");
  assert(settledCount > 0.9 * N, `most cells reachable (${settledCount}/${N})`);
  assert(r.passes[seedIdx] === settledCount, "passes[seed] = #settled (every optimal path passes the seed)");
  assert(badPass === 0, "passes ≥ 1 on settled cells, 0 elsewhere");
  assert(Array.isArray(r.path) && r.path[0] === seedIdx && r.path.at(-1) === base.goalR * W + base.goalC,
    "path runs seed → goal");
  assert(Math.abs(r.pathEnergy - r.energy[base.goalR * W + base.goalC]) < 1e-6, "pathEnergy = E[goal]");
}
{
  console.log("round = forward + reverse");
  const f = run(msg({ mode: "from", goalR: -1, goalC: -1 }));
  const b = run(msg({ mode: "to", goalR: -1, goalC: -1 }));
  const rt = run(msg({ mode: "round", goalR: -1, goalC: -1 }));
  let maxd = 0;
  for (let i = 0; i < N; i += 13) {
    const want = (Number.isFinite(f.energy[i]) && Number.isFinite(b.energy[i]))
      ? f.energy[i] + b.energy[i] : Infinity;
    const got = rt.energy[i];
    if (Number.isFinite(want) !== Number.isFinite(got)) { maxd = Infinity; break; }
    if (Number.isFinite(want)) maxd = Math.max(maxd, Math.abs(want - got));
  }
  assert(maxd < 1e-3, `round energy = from + to (max|Δ| = ${maxd.toExponential(1)})`);
}
{
  console.log("eMax budget");
  const r = run(msg({ wantPasses: true, eMax: 15000, goalR: -1, goalC: -1 }));
  let over = 0;
  for (let i = 0; i < N; i++) if (Number.isFinite(r.energy[i]) && r.energy[i] > 15000) over++;
  assert(over === 0, "no settled cell exceeds the budget");
}
{
  console.log("round-trip total budget (eMaxMode)");
  // Cap chosen so the budget actually bites on this grid: legs reach ~10k,
  // so leg mode produces totals in (6k, 12k] that total mode must mask.
  const CAP = 6000;
  const leg = run(msg({ mode: "round", eMax: CAP, eMaxMode: "leg", goalR: -1, goalC: -1, wantPasses: true }));
  const tot = run(msg({ mode: "round", eMax: CAP, eMaxMode: "total", goalR: -1, goalC: -1, wantPasses: true }));
  let legOver = 0, totOver = 0, maskedOnly = true;
  let passesMonotone = true, passesStrict = 0;
  let legFinite = 0, totFinite = 0;
  for (let i = 0; i < N; i++) {
    if (Number.isFinite(leg.energy[i])) { legFinite++; if (leg.energy[i] > CAP) legOver++; }
    if (Number.isFinite(tot.energy[i])) { totFinite++; if (tot.energy[i] > CAP) totOver++; }
    // total mode must equal leg mode except where it masks to Infinity
    if (Number.isFinite(tot.energy[i]) && tot.energy[i] !== leg.energy[i]) maskedOnly = false;
    // passes count only displayed destinations → total's stricter filter
    // can only shrink counts
    if (tot.passes[i] > leg.passes[i]) passesMonotone = false;
    if (tot.passes[i] < leg.passes[i]) passesStrict++;
  }
  const seedIdx = base.seedR * W + base.seedC;
  assert(legOver > 0, `leg mode shows totals beyond the cap (${legOver} cells — that's the documented 2× behaviour)`);
  assert(totOver === 0, "total mode: no finite round trip exceeds the cap");
  assert(maskedOnly, "total mode only masks (never alters) energies");
  assert(passesMonotone, "filtered passes: total mode never exceeds leg mode");
  assert(passesStrict > 0, `filtered passes: total mode strictly lower somewhere (${passesStrict} cells)`);
  assert(leg.passes[seedIdx] === 2 * legFinite, "passes[seed] = 2 × #displayed cells (leg mode)");
  assert(tot.passes[seedIdx] === 2 * totFinite, "passes[seed] = 2 × #displayed cells (total mode)");
}
{
  console.log("top-N routes");
  const r = run(msg({ wantTopN: true, nRoutes: 3, penalty: 2 }));
  assert(r.routes?.length === 3, "3 routes returned");
  // Reported energies are now the TRUE (un-penalised) route cost, not
  // astar()'s penalised search cost — only route #1 (no repulsion applied
  // yet) is guaranteed optimal; routes 2..N only guarantee >= the optimum,
  // they are no longer monotone non-decreasing against each other.
  assert(r.routes.every((x) => x.energy >= r.routes[0].energy - 1e-9),
    "route energies (true, un-penalised) are all >= the optimum (route #1)");
}
{
  console.log("top-N per-cell penalty < 1 is clamped to 1 (no negative A* edges)");
  // penalty=0.5 in per-cell mode used to pass straight through
  // (`penalty > 0 ? penalty : 1.0`), making Math.pow(0.5, used) < 1 and
  // producing a NEGATIVE repulsion term on top of v2Edge — a non-admissible,
  // possibly-negative A* edge. Clamped, 0.5 behaves as 1 (no repulsion):
  // every route should still come back finite, non-negative, and >= the
  // optimum.
  const r = run(msg({ wantTopN: true, nRoutes: 3, penalty: 0.5, repulsionMode: "per-cell" }));
  assert(r.routes?.length === 3, "3 routes returned (per-cell, penalty 0.5)");
  const allFiniteNonNeg = r.routes.every((x) => Number.isFinite(x.energy) && x.energy >= 0);
  assert(allFiniteNonNeg, "every route energy is finite and non-negative");
  const allAboveOptimum = r.routes.every((x) => x.energy >= r.routes[0].energy - 1e-9);
  assert(allAboveOptimum, "every route energy >= route #1 (the optimum)");
}
{
  console.log("A* optimality on descents (admissible heuristic)");
  // Two masked corridors from seed to goal, both dropping 90 m overall:
  //   B (decoy, row 25): a steep 2-step drop (ε = 0, no recovery) then flat —
  //     under the old aRoll·dist heuristic its f is constant along the row, so
  //     the goal settled through it FIRST even though it's ~50% more expensive;
  //   A (optimal, via row 5): flat at the top, then a long gentle descent at
  //     grade = abRatio where a metre costs only epsOffset·(aRoll+aAero) —
  //     the régime the old heuristic overestimated (inadmissible).
  // Route #1 must match the Dijkstra field's E[goal] — the true optimum.
  const H2 = 50, W2 = 120, N2 = H2 * W2;
  const hgt = new Float32Array(N2).fill(890);
  const msk = new Uint8Array(N2); // all blocked; carve the corridors below
  const cost2 = { aRoll: 1, aAero: 0, beta: 30, climbThr: 0.05, abRatio: 1 / 30, epsOffset: 0.13 };
  // Corridor B: row 25, cols 5..115 — drop 890→845→800 then flat at 800.
  for (let c = 5; c <= 115; c++) {
    const i = 25 * W2 + c;
    msk[i] = 1;
    hgt[i] = c === 5 ? 890 : c === 6 ? 845 : 800;
  }
  // Corridor A: connector (rows 5..24, col 5, flat 890), row 5 cols 5..115
  // (flat to col 65, then −1 m/step = grade 1/30), connector (rows 6..24,
  // col 115) continuing the same gentle descent down to 800 at the goal.
  for (let r = 5; r <= 24; r++) { const i = r * W2 + 5; msk[i] = 1; hgt[i] = 890; }
  for (let c = 5; c <= 115; c++) {
    const i = 5 * W2 + c;
    msk[i] = 1;
    hgt[i] = c <= 65 ? 890 : 890 - (c - 65);       // 890 → 840 at col 115
  }
  for (let r = 6; r <= 24; r++) { const i = r * W2 + 115; msk[i] = 1; hgt[i] = 840 - 2 * (r - 5); } // 838 → 802
  const dmsg = (over) => ({
    kind: "run", H: H2, W: W2, dx: 30, dy: 30, cost: cost2,
    seedR: 25, seedC: 5, goalR: 25, goalC: 115, mode: "from",
    height: new Float32Array(hgt), mask: new Uint8Array(msk), ...over,
  });
  const r = run(dmsg({ wantTopN: true, nRoutes: 1 }));
  const goalIdx = 25 * W2 + 115;
  assert(r.routes?.length >= 1, "descent grid: a route was found");
  assert(Number.isFinite(r.energy[goalIdx]), "descent grid: goal reachable in the field");
  const dE = Math.abs(r.routes[0].energy - r.energy[goalIdx]);
  assert(dE < 1e-2,
    `route #1 is optimal: energy = E[goal] (${r.routes[0].energy.toFixed(1)} vs ${r.energy[goalIdx].toFixed(1)}, |Δ| = ${dE.toExponential(1)})`);
  // Sanity: the decoy corridor really is more expensive than the optimum —
  // otherwise this test wouldn't distinguish the heuristics.
  assert(r.energy[goalIdx] < 3300 - 1, `decoy corridor strictly worse (E[goal] = ${r.energy[goalIdx].toFixed(1)} < 3300)`);
}
{
  console.log("mode-to top-N routes score the travel direction dst→seed");
  // On asymmetric terrain the seed→dst and dst→seed energies differ; the
  // top-1 route in mode "to" must measure the SAME direction as the field /
  // best path (travel dst→seed), i.e. equal E_to[goal] = pathEnergy.
  const to = run(msg({ mode: "to", wantTopN: true, nRoutes: 1 }));
  const from = run(msg({ mode: "from", wantTopN: true, nRoutes: 1 }));
  assert(Math.abs(from.pathEnergy - to.pathEnergy) > 1,
    `terrain is asymmetric (from ${from.pathEnergy.toFixed(1)} vs to ${to.pathEnergy.toFixed(1)}) — the test bites`);
  const dTo = Math.abs(to.routes[0].energy - to.pathEnergy);
  assert(dTo < 5e-2, `mode "to" route #1 energy = reverse-field E[dst] (|Δ| = ${dTo.toExponential(1)})`);
  const dFrom = Math.abs(from.routes[0].energy - from.pathEnergy);
  assert(dFrom < 5e-2, `mode "from" route #1 energy = field E[dst] (|Δ| = ${dFrom.toExponential(1)})`);
}
{
  console.log("mode-to maximize DP scores the travel direction dst→seed (mirrors astar's `reverse`)");
  // v49 gave astar's top-N a `reverse` flag so mode "to" routes are scored
  // dst→seed, matching the field they overlay — but the layered-DP dispatch
  // (maxCostPathOfLength) always scored seed→goal regardless of mode. Under
  // the asymmetric v2 cost model that's a different path/energy. Local
  // mirror of energy-worker.js's v2Edge (same asymmetric cost model, kept in
  // sync by hand like the graph-engine/water-raster mirror tests) lets this
  // test independently recompute the dst→seed energy of the DP's own path
  // and check it against the reported pathEnergy.
  function v2EdgeMirror(dist, dh, c) {
    if (dh >= 0) {
      const aero = (dh < c.climbThr * dist) ? c.aAero * dist : 0;
      return c.aRoll * dist + aero + c.beta * dh;
    }
    const ndh = -dh;
    let eps = c.abRatio * dist / ndh;
    if (eps > 1) eps = 1;
    eps -= c.epsOffset;
    if (eps < 0) eps = 0;
    const e = c.aRoll * dist + c.aAero * dist - eps * c.beta * ndh;
    return e < 0 ? 0 : e;
  }
  // Chebyshev distance between seed and goal: the minimum number of
  // 8-connected steps that can reach the goal exactly — always feasible as
  // an L for the layered DP (mix of diagonal + cardinal moves).
  const L = Math.max(Math.abs(base.goalR - base.seedR), Math.abs(base.goalC - base.seedC));
  const r = run(msg({ mode: "to", maximize: true, maximizeLength: L }));
  const gotPath = Array.isArray(r.path) && r.path.length === L + 1;
  assert(gotPath, `DP path has exactly L+1 = ${L + 1} cells (mode "to", maximize, L=${L})`);
  if (gotPath) {
    let trueE = 0;
    for (let j = 1; j < r.path.length; j++) {
      const a = r.path[j - 1], b = r.path[j];
      const ar = (a / W) | 0, ac = a - ar * W;
      const br = (b / W) | 0, bc = b - br * W;
      const d = Math.hypot((br - ar) * base.dy, (bc - ac) * base.dx);
      // Path is stored seed→goal; travel is dst→seed (mode "to"), so the
      // edge from a to b is scored as if descending FROM a (the dst side).
      const dh = height[a] - height[b];
      trueE += v2EdgeMirror(d, dh, base.cost);
    }
    const dE = Math.abs(r.pathEnergy - trueE);
    assert(dE < 5e-2,
      `DP pathEnergy = dst→seed sum of v2Edge over the path (${r.pathEnergy.toFixed(1)} vs ${trueE.toFixed(1)}, |Δ| = ${dE.toExponential(1)})`);
  }
}

// ---- 2. pooled density partials ≡ single-run density ----
const refs = [[40, 60], [100, 200], [180, 30], [220, 230], [128, 128], [30, 240]];
for (const dmode of ["from", "round"]) {
  console.log(`density mode=${dmode}: pooled partials vs single run`);
  const single = run(msg({
    wantDensity: true, refPoints: refs, densityMode: dmode, mode: dmode,
    goalR: -1, goalC: -1,
  }));
  // Pool of 3 slices of 2 refs, merged exactly like app.js startDensityPool.
  const density = new Float64Array(N);
  const energySum = new Float64Array(N);
  const energyCount = new Int32Array(N);
  for (let p = 0; p < 3; p++) {
    const part = run(msg({
      wantDensity: true, refPoints: refs.slice(p * 2, p * 2 + 2),
      densityMode: dmode, mode: dmode, densityPartial: true,
      goalR: -1, goalC: -1,
    }));
    assert(part.partial === true, `slice ${p} returned partial accumulators`);
    for (let i = 0; i < N; i++) density[i] += part.density[i];
    for (let i = 0; i < N; i++) energySum[i] += part.energySum[i];
    for (let i = 0; i < N; i++) energyCount[i] += part.energyCount[i];
  }
  for (let i = 0; i < N; i++) density[i] /= N;
  let maxD = 0, maxE = 0;
  for (let i = 0; i < N; i++) {
    maxD = Math.max(maxD, Math.abs(density[i] - single.passes[i]));
    const e = energyCount[i] > 0 ? energySum[i] / energyCount[i] : Infinity;
    if (Number.isFinite(e) !== Number.isFinite(single.energy[i])) maxE = Infinity;
    else if (Number.isFinite(e)) maxE = Math.max(maxE, Math.abs(e - single.energy[i]));
  }
  assert(maxD === 0, `merged density identical (max|Δ| = ${maxD.toExponential(1)})`);
  assert(maxE < 1e-3, `merged energy matches (max|Δ| = ${maxE.toExponential(1)})`);
}

// ---- 3. bridge portal edges (hybrid raster + sparse graph overlay) ----
{
  console.log("bridge portals: deck shortcut lowers far-cell energy, locally");
  const seedIdx = base.seedR * W + base.seedC;
  const goalIdx = base.goalR * W + base.goalC;
  const noPortal = run(msg({ mode: "from", goalR: -1, goalC: -1 }));
  const withPortal = run(msg({
    mode: "from", goalR: -1, goalC: -1,
    portalU: new Int32Array([seedIdx]),
    portalV: new Int32Array([goalIdx]),
    portalLenM: new Float64Array([1]), // ~free deck straight to the goal
  }));
  assert(Number.isFinite(withPortal.energy[goalIdx]), "portal goal reachable");
  assert(withPortal.energy[goalIdx] < noPortal.energy[goalIdx] - 1e-6,
    `portal lowers E[goal] (${noPortal.energy[goalIdx].toFixed(0)} → ${withPortal.energy[goalIdx].toFixed(0)})`);
  // A cell far from both endpoints must be untouched — the portal adds a path
  // without overwriting the grid, so under-bridge / unrelated cells are intact.
  const otherIdx = 10 * W + 10;
  const sameOther = (!Number.isFinite(withPortal.energy[otherIdx]) && !Number.isFinite(noPortal.energy[otherIdx])) ||
    Math.abs(withPortal.energy[otherIdx] - noPortal.energy[otherIdx]) < 1e-9;
  assert(sameOther, "a cell off the portal path is unchanged (multi-level locality)");
}
{
  const dmode = "from";
  console.log("density + portals: pooled partials vs single run");
  const portalU = new Int32Array([40 * W + 60, 180 * W + 30]);
  const portalV = new Int32Array([220 * W + 230, 30 * W + 240]);
  const portalLenM = new Float64Array([1200, 1800]);
  // Mix NaN (→ DEM at the abutment cell) and mapped OSM `ele` so the pool≡single
  // equivalence is checked on both the fallback and explicit-ele portal paths.
  const portalHU = new Float64Array([NaN, 712]);
  const portalHV = new Float64Array([NaN, 700]);
  const pmsg = (over) => msg({ portalU, portalV, portalLenM, portalHU, portalHV, ...over });
  const single = run(pmsg({
    wantDensity: true, refPoints: refs, densityMode: dmode, mode: dmode, goalR: -1, goalC: -1,
  }));
  const density = new Float64Array(N), energySum = new Float64Array(N), energyCount = new Int32Array(N);
  for (let p = 0; p < 3; p++) {
    const part = run(pmsg({
      wantDensity: true, refPoints: refs.slice(p * 2, p * 2 + 2),
      densityMode: dmode, mode: dmode, densityPartial: true, goalR: -1, goalC: -1,
    }));
    for (let i = 0; i < N; i++) { density[i] += part.density[i]; energySum[i] += part.energySum[i]; energyCount[i] += part.energyCount[i]; }
  }
  for (let i = 0; i < N; i++) density[i] /= N;
  let maxD = 0, maxE = 0;
  for (let i = 0; i < N; i++) {
    maxD = Math.max(maxD, Math.abs(density[i] - single.passes[i]));
    const e = energyCount[i] > 0 ? energySum[i] / energyCount[i] : Infinity;
    if (Number.isFinite(e) !== Number.isFinite(single.energy[i])) maxE = Infinity;
    else if (Number.isFinite(e)) maxE = Math.max(maxE, Math.abs(e - single.energy[i]));
  }
  assert(maxD === 0, `portals: merged density identical (max|Δ| = ${maxD.toExponential(1)})`);
  assert(maxE < 1e-3, `portals: merged energy matches (max|Δ| = ${maxE.toExponential(1)})`);
  // Sanity: the portals actually changed the field vs a no-portal run.
  const noP = run(msg({ wantDensity: true, refPoints: refs, densityMode: dmode, mode: dmode, goalR: -1, goalC: -1 }));
  let changed = 0;
  for (let i = 0; i < N; i++) if (Math.abs(single.passes[i] - noP.passes[i]) > 1e-12) changed++;
  assert(changed > 0, `portals change the density field (${changed} cells differ)`);
}

// ---- 4. accessibility matrix (wantMatrix pairwise ref↔ref energies) ----
// mrefs adds a ref on cell 0, which the fixture masks (i % 997) — the engines
// must keep its ORIGINAL index and leave its row (and, being unreachable, its
// column) all-Infinity, never compact it away (the Rust backend filters refs;
// index parity across engines depends on this rule).
const mrefs = [...refs, [0, 0]];
const MK = mrefs.length;
const DROPPED = MK - 1;
const mCells = Int32Array.from(mrefs, ([r, c]) => r * W + c);
const mmsg = (over) => msg({
  wantDensity: true, refPoints: mrefs, goalR: -1, goalC: -1,
  wantMatrix: true, matrixCells: new Int32Array(mCells), ...over,
});
// Raw row semantics per mode: `from` row i = e(i→j); `to` row i = e(j→i);
// `round` row i = masked round-trip total (fround(f+b), Infinity if either
// leg unreached or the total cap masks it). Recomputed here from the
// single-source dijkstra() fields — settled energies are heap-order-
// independent, so equality is EXACT (===), not approximate.
for (const dmode of ["from", "to", "round"]) {
  console.log(`matrix mode=${dmode}: dims, dropped ref, brute-force vs single-source`);
  const single = run(mmsg({ densityMode: dmode, mode: dmode }));
  const mat = single.matrix;
  assert(mat instanceof Float32Array && mat.length === MK * MK,
    `matrix is Float32Array of K² = ${MK * MK}`);
  let diagOk = true, dropRowInf = true, dropColInf = true;
  for (let i = 0; i < MK; i++) {
    if (i !== DROPPED && mat[i * MK + i] !== 0) diagOk = false;
    if (mat[DROPPED * MK + i] !== Infinity) dropRowInf = false;
    if (i !== DROPPED && mat[i * MK + DROPPED] !== Infinity) dropColInf = false;
  }
  assert(diagOk, "diagonal is 0 for live refs");
  assert(dropRowInf, "dropped ref's row is all-Infinity (original index kept)");
  assert(dropColInf, "dropped ref's column is all-Infinity (masked cell unreachable)");
  let exact = true;
  for (let i = 0; i < MK - 1; i++) {
    const [sr, sc] = mrefs[i];
    const fields = {};
    if (dmode !== "to") fields.f = run(msg({ mode: "from", seedR: sr, seedC: sc, goalR: -1, goalC: -1 })).energy;
    if (dmode !== "from") fields.b = run(msg({ mode: "to", seedR: sr, seedC: sc, goalR: -1, goalC: -1 })).energy;
    for (let j = 0; j < MK; j++) {
      const cj = mCells[j];
      let want;
      if (dmode === "from") want = fields.f[cj];
      else if (dmode === "to") want = fields.b[cj];
      else {
        const fi = fields.f[cj], bi = fields.b[cj];
        want = (fi < Infinity && bi < Infinity) ? Math.fround(fi + bi) : Infinity;
      }
      if (mat[i * MK + j] !== want) exact = false;
    }
  }
  assert(exact, "every live row equals the single-source field at the ref cells (exact)");
}
{
  console.log("matrix: energy budget bounds");
  const CAP = 15000;
  const from = run(mmsg({ densityMode: "from", mode: "from", eMax: CAP })).matrix;
  let over = 0;
  for (const v of from) if (Number.isFinite(v) && v > CAP) over++;
  assert(over === 0, "mode from: no finite entry exceeds eMax");
  const CAPR = 6000;
  const leg = run(mmsg({ densityMode: "round", mode: "round", eMax: CAPR, eMaxMode: "leg" })).matrix;
  const tot = run(mmsg({ densityMode: "round", mode: "round", eMax: CAPR, eMaxMode: "total" })).matrix;
  let legOver2x = 0, legBeyondCap = 0, totOver = 0, maskedOnly = true;
  for (let i = 0; i < leg.length; i++) {
    if (Number.isFinite(leg[i])) {
      if (leg[i] > 2 * CAPR) legOver2x++;
      if (leg[i] > CAPR) legBeyondCap++;
    }
    if (Number.isFinite(tot[i])) {
      if (tot[i] > CAPR) totOver++;
      if (tot[i] !== leg[i]) maskedOnly = false;
    }
  }
  assert(legOver2x === 0, "round leg mode: totals bounded by 2·eMax");
  assert(legBeyondCap > 0, `round leg mode: totals beyond eMax exist (${legBeyondCap} — the documented 2× reach)`);
  assert(totOver === 0, "round total mode: no finite entry exceeds the cap");
  assert(maskedOnly, "round total mode only masks (never alters) leg-mode entries");
}
for (const dmode of ["from", "round"]) {
  console.log(`matrix mode=${dmode}: pooled slice rows ≡ single run`);
  const single = run(mmsg({ densityMode: dmode, mode: dmode }));
  const merged = new Float32Array(MK * MK).fill(Infinity);
  const bounds = [[0, 3], [3, 5], [5, MK]];
  for (const [lo, hi] of bounds) {
    const part = run(mmsg({
      refPoints: mrefs.slice(lo, hi),
      densityMode: dmode, mode: dmode, densityPartial: true,
    }));
    assert(part.matrix instanceof Float32Array && part.matrix.length === (hi - lo) * MK,
      `slice [${lo},${hi}) returned its rows`);
    merged.set(part.matrix, lo * MK);
  }
  let identical = true;
  for (let i = 0; i < MK * MK; i++) {
    if (merged[i] !== single.matrix[i] && !(Number.isNaN(merged[i]) && Number.isNaN(single.matrix[i]))) identical = false;
  }
  assert(identical, "merged pooled matrix is byte-identical to the single run's");
}
{
  console.log("matrix: absent when not requested / under maximize");
  const plain = run(msg({ wantDensity: true, refPoints: mrefs, densityMode: "from", mode: "from", goalR: -1, goalC: -1 }));
  assert(plain.matrix == null, "no matrix without wantMatrix");
  const maxi = run(mmsg({ densityMode: "from", mode: "from", maximize: true }));
  assert(maxi.matrix == null, "no matrix under maximize (inverted costs)");
}

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
