// Sanity check for passes-count + top-N. Loads the production worker
// module, simulates a `run` postMessage in-process, and prints summary
// stats so we can compare against expected behaviour.
const fs = require("fs");
const Module = require("module");

// Stub the Web Worker self/postMessage so the worker module loads under Node.
const messages = [];
global.self = {
  set onmessage(fn) { global.self._handler = fn; },
  get onmessage() { return global.self._handler; },
};
global.postMessage = (m, transfer) => messages.push({ msg: m });
global.performance = { now: () => Date.now() };

// Load the worker by reading + evaluating its source (it's a classic worker
// script, not an ES module).
const src = fs.readFileSync("./energy-worker.js", "utf8");
new Function(src)();

const H = 568, W = 975, N = H * W;
const buf = fs.readFileSync("/tmp/dem.bin");
const height = new Float32Array(buf.buffer, buf.byteOffset, N);
const mask = new Uint8Array(N).fill(1);
const dxM = 4.887778601902139, dyM = 5.295618378919024;
const seedR = (H/2)|0, seedC = (W/2)|0;
const goalR = seedR + 100, goalC = seedC + 200;

function run(extra) {
  messages.length = 0;
  const t0 = Date.now();
  global.self._handler({
    data: {
      kind: "run",
      height: new Float32Array(height),
      mask: new Uint8Array(mask),
      H, W, dx: dxM, dy: dyM,
      seedR, seedC, goalR, goalC,
      mode: "from",
      alpha: 0.008, beta: 1.0, eta: 0.1,
      ...extra,
    },
  });
  const done = messages.find((m) => m.msg.kind === "done");
  return { done, dt: Date.now() - t0 };
}

console.log("--- baseline (energy only) ---");
{
  const { done, dt } = run({});
  const e = done.msg.energy;
  let fin = 0, max = 0;
  for (let i = 0; i < N; i++) if (Number.isFinite(e[i])) { fin++; if (e[i] > max) max = e[i]; }
  console.log(`finite=${fin}/${N}  maxE=${max.toFixed(2)}  passes=${done.msg.passes}  routes=${done.msg.routes}  dt=${dt}ms`);
}

console.log("--- with wantPasses ---");
{
  const { done, dt } = run({ wantPasses: true });
  const p = done.msg.passes;
  let nz = 0, max = 0, sum = 0;
  for (let i = 0; i < N; i++) {
    if (p[i] > 0) {
      nz++;
      if (p[i] > max) max = p[i];
      sum += p[i];
    }
  }
  console.log(`passes nonzero=${nz}/${N}  maxPasses=${max}  sum=${sum}  dt=${dt}ms`);
  console.log(`passes at seed = ${p[seedR*W+seedC]} (should equal cells settled)`);
  // Diagnostic: how many cells with passes==1 (leaves)?
  let leaves = 0;
  for (let i = 0; i < N; i++) if (p[i] === 1) leaves++;
  console.log(`leaves (passes==1) = ${leaves}`);

  // Re-run dijkstra ourselves to inspect the parents/order arrays directly.
  // We re-implement just enough to grab those internals.
}


for (const mode of ["per-cell", "linear", "square"]) {
  console.log(`--- top-N (mode=${mode}, n=3, penalty=2) ---`);
  const { done, dt } = run({ wantTopN: true, nRoutes: 3, penalty: 2.0, repulsionMode: mode });
  const r = done.msg.routes;
  console.log(`routes returned=${r ? r.length : 0}  dt=${dt}ms`);
  if (r) for (const x of r) {
    console.log(`  E=${x.energy.toFixed(2)}  L=${x.length.toFixed(0)}m  shared=${x.shared}/${x.path.length}`);
  }
}
