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
  assert(r.routes.every((x, i) => i === 0 || x.energy >= r.routes[i - 1].energy - 1e-9),
    "route energies non-decreasing");
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

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
