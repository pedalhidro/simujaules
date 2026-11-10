// Tests for lib/pool-merge.js — the density pool's arrival-order-independent
// merge (app/run.js computeDensityField). Drives the real engines through
// their onmessage handlers — energy-worker.js densityField (like
// test-worker-pool.mjs) and wasm-worker.js with engine32.wasm attached (like
// wasm/test-wasm.mjs) — splits the refs into 3 and 4 densityPartial slices,
// and feeds them to the merger in EVERY arrival permutation. Asserts:
//   (a) slot-order merge → bit-identical totals for every permutation;
//   (b) the old arrival-order summation gives different bits for at least one
//       permutation on the same data (the test is sensitive). This bites on
//       the WASM engine's slices: its density accumulator is f64 (passes/N at
//       full precision), so adding 3+ of them is order-sensitive. The JS
//       engine's slices are f32 density and f64 sums of f32 energies, and a
//       handful of such values adds EXACTLY in f64 — the old order is
//       reported for it, not asserted;
//   (c) held slices are released as they merge, none survive the last merge,
//       and drop() (cancel / error) releases whatever is still held.
// Run: node test-pool-merge.mjs
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { addDensityPartial, createSlotMerger } from "./lib/pool-merge.js";

const here = dirname(fileURLToPath(import.meta.url));

// wasm-worker.js importScripts energy-worker.js into one global scope; model
// that by splicing the JS engine in place of the call (as wasm/test-wasm.mjs).
function loadWorker(withWasm) {
  const js = readFileSync(join(here, "energy-worker.js"), "utf8");
  let src = js;
  if (withWasm) {
    const ww = readFileSync(join(here, "wasm-worker.js"), "utf8");
    src = ww.replace('importScripts("energy-worker.js");', () => js + "\n;");
    if (src === ww) throw new Error("wasm-worker.js no longer importScripts(\"energy-worker.js\")");
  }
  const messages = [];
  let settle = null;
  const sandbox = {
    postMessage: (m) => {
      messages.push(m);
      if (settle && (m.kind === "done" || m.kind === "error")) settle();
    },
    self: {}, performance, console, WebAssembly, TextEncoder, TextDecoder,
  };
  new Function(...Object.keys(sandbox), src)(...Object.values(sandbox));
  return async (msg) => {
    messages.length = 0;
    const finished = new Promise((r) => (settle = r));
    sandbox.self.onmessage({ data: msg });
    await finished;
    const err = messages.find((m) => m.kind === "error");
    if (err) throw new Error("worker error: " + err.message);
    if (messages.some((m) => m.kind === "engine-fallback")) throw new Error("wasm engine fell back to JS");
    return messages.find((m) => m.kind === "done");
  };
}
const engines = [
  { name: "js", run: loadWorker(false), extra: {} },
  {
    name: "wasm32", run: loadWorker(true),
    extra: { wasm: { module: new WebAssembly.Module(readFileSync(join(here, "engine32.wasm"))), is64: false } },
  },
];

let failures = 0;
function assert(cond, label) {
  console.log(`  ${cond ? "✓" : "✗ FAIL:"} ${label}`);
  if (!cond) failures++;
}

// Non-power-of-two grid so the per-ref density (count / N) is not exact in
// binary and density sums are order-sensitive too, not only energySum.
const H = 181, W = 203, N = H * W;
const height = new Float32Array(N);
for (let r = 0; r < H; r++)
  for (let c = 0; c < W; c++)
    height[r * W + c] =
      50 * Math.sin(r * 0.013) * Math.cos(c * 0.017) +
      20 * Math.sin(r * 0.05 + c * 0.031) + 800;
const mask = new Uint8Array(N).fill(1);
for (let i = 0; i < N; i += 997) mask[i] = 0;
const cost = { aRoll: 1, aAero: 0.5, beta: 30, climbThr: 0.05, abRatio: 0.05, epsOffset: 0.13 };
const refs = [[20, 30], [90, 180], [150, 25], [170, 190], [95, 100], [15, 195], [60, 60], [130, 140]];

async function slices(engine, P, dmode) {
  const K = refs.length;
  const out = [];
  for (let p = 0; p < P; p++) {
    const lo = Math.floor(p * K / P), hi = Math.floor((p + 1) * K / P);
    const m = await engine.run({
      kind: "run", H, W, dx: 30, dy: 30, cost,
      height: new Float32Array(height), mask: new Uint8Array(mask),
      wantDensity: true, refPoints: refs.slice(lo, hi),
      densityMode: dmode, mode: dmode, densityPartial: true, goalR: -1, goalC: -1,
      ...engine.extra,
    });
    out.push({ density: m.density, energySum: m.energySum, energyCount: m.energyCount });
  }
  return out;
}

function perms(n) {
  if (n === 1) return [[0]];
  const res = [];
  for (const p of perms(n - 1))
    for (let i = 0; i <= p.length; i++) res.push([...p.slice(0, i), n - 1, ...p.slice(i)]);
  return res;
}

const freshAcc = () => ({
  density: new Float64Array(N), energySum: new Float64Array(N), energyCount: new Int32Array(N),
});
const sameBits = (a, b) => {
  for (const k of ["density", "energySum", "energyCount"]) {
    const x = a[k], y = b[k];
    for (let i = 0; i < N; i++) if (!Object.is(x[i], y[i])) return false;
  }
  return true;
};

for (const engine of engines) for (const dmode of ["from", "round"]) {
  for (const P of [3, 4]) {
    console.log(`${engine.name} mode=${dmode}, ${P} slices: every arrival permutation`);
    const parts = await slices(engine, P, dmode);

    // Reference: plain slot order 0..P−1 (what any in-order arrival gives).
    const ref = freshAcc();
    for (const s of parts) addDensityPartial(ref, s);

    let allSame = true, oldDiffers = 0, mergeOrderOk = true, releasedOk = true, doneOk = true;
    const ps = perms(P);
    for (const order of ps) {
      // New: slot merger.
      const acc = freshAcc();
      const seen = [];
      const mg = createSlotMerger({ slots: P, onMerge: (slot, part) => { seen.push(slot); addDensityPartial(acc, part); } });
      let doneAt = -1;
      order.forEach((slot, j) => { if (mg.add(slot, parts[slot]) && doneAt < 0) doneAt = j; });
      if (!sameBits(acc, ref)) allSame = false;
      if (seen.join() !== [...Array(P).keys()].join()) mergeOrderOk = false;
      if (doneAt !== P - 1 || !mg.done) doneOk = false;
      if (mg.heldCount !== 0 || mg._held().some((x) => x !== null)) releasedOk = false;

      // Old: arrival-order summation (the pre-fix app/run.js handler).
      const old = freshAcc();
      for (const slot of order) addDensityPartial(old, parts[slot]);
      if (!sameBits(old, ref)) oldDiffers++;
    }
    assert(allSame, `slot merger: all ${ps.length} permutations bit-identical`);
    assert(mergeOrderOk, "onMerge called once per slot, in slot order");
    assert(doneOk, "add() reports done exactly on the last arrival");
    assert(releasedOk, "no slice held after the last merge");
    const oldMsg = `old arrival-order sum differs in ${oldDiffers}/${ps.length} permutations`;
    if (engine.name === "js") console.log(`  · ${oldMsg} (JS slices add exactly — informational)`);
    else assert(oldDiffers > 0, `${oldMsg} (test is sensitive)`);
  }
}

// ---- held-buffer release + cancel ----
{
  console.log("held buffers: released on merge, dropped on cancel");
  const merged = [];
  const mg = createSlotMerger({ slots: 4, onMerge: (s) => merged.push(s) });
  const a = { id: 1 }, b = { id: 2 }, c = { id: 3 };
  mg.add(3, c); mg.add(1, a);
  assert(mg.heldCount === 2 && mg._held()[3] === c && mg._held()[1] === a, "early slots 1 and 3 are held");
  mg.add(0, {});
  assert(merged.join() === "0,1" && mg._held()[1] === null && mg.heldCount === 1,
    "slot 0 drains slot 1 and releases it; slot 3 still waits for 2");
  mg.drop();
  assert(mg.heldCount === 0 && mg._held().every((x) => x === null), "drop() releases every held slice");
  const r = mg.add(2, b);
  assert(r === false && merged.join() === "0,1" && mg.heldCount === 0, "after drop(), add() merges and holds nothing");

  const mg2 = createSlotMerger({ slots: 2, onMerge: (s) => merged.push(10 + s) });
  mg2.add(0, {}); mg2.add(0, {});
  assert(merged.filter((x) => x === 10).length === 1, "a duplicate slot is ignored");
}

if (failures) { console.error(`\n${failures} assertion(s) FAILED`); process.exit(1); }
console.log("\nall pool-merge tests passed");
