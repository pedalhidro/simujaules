// Parity check for the in-browser WebAssembly engine: drives wasm-worker.js
// (with the compiled engine32.wasm / engine64.wasm attached, exactly as app.js
// attaches them) and the plain energy-worker.js through their real onmessage
// handlers, and compares the replies message-for-message. Same synthetic DEM,
// cost bundle, portals and network masks as backend/test-backend.mjs — the
// wasm module IS backend/src/main.rs, so this is the backend parity suite
// replayed through the worker protocol (density POOL partials + single-source),
// plus the fallback paths (jobs the wasm engine must hand to the JS engine).
// Usage (after ./build.sh): node wasm/test-wasm.mjs
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

// ---- workers, driven through their real onmessage handlers ----
// wasm-worker.js importScripts energy-worker.js into ONE shared global scope;
// here that is modelled by splicing the JS engine's source in place of the
// importScripts call and evaluating the result as a single script.
function loadWorker(withWasm) {
  const js = readFileSync(join(root, "energy-worker.js"), "utf8");
  let src = js;
  if (withWasm) {
    const ww = readFileSync(join(root, "wasm-worker.js"), "utf8");
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
    if (err) throw new Error(err.message);
    return { done: messages.find((m) => m.kind === "done"), fallback: messages.find((m) => m.kind === "engine-fallback") };
  };
}

// ---- engines ----
const MEMORY64_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 5, 3, 1, 4, 1]);
const engines = [{ name: "wasm32", is64: false, file: "engine32.wasm" }];
if (WebAssembly.validate(MEMORY64_PROBE)) engines.push({ name: "wasm64", is64: true, file: "engine64.wasm" });
else console.log("(this runtime has no Memory64 — skipping engine64.wasm)");
for (const e of engines) e.module = new WebAssembly.Module(readFileSync(join(root, e.file)));

// ---- fixtures: identical to backend/test-backend.mjs ----
const H = 256, W = 256, N = H * W;
const height = new Float32Array(N);
for (let r = 0; r < H; r++)
  for (let c = 0; c < W; c++)
    height[r * W + c] =
      50 * Math.sin(r * 0.013) * Math.cos(c * 0.017) +
      20 * Math.sin(r * 0.05 + c * 0.031) + 800;
const mask = new Uint8Array(N).fill(1);
for (let i = 0; i < N; i += 997) mask[i] = 0;
const refs = [[40, 60], [100, 200], [180, 30], [220, 230], [128, 128]];
const cost = { aRoll: 1, aAero: 0.5, beta: 30, climbThr: 0.05, abRatio: 0.05, epsOffset: 0.13 };
const portalU    = new Int32Array([ 10 * W + 10,  50 * W + 200, 200 * W + 20 ]);
const portalV    = new Int32Array([ 240 * W + 240, 60 * W + 60,  30 * W + 220 ]);
const portalLenM = new Float64Array([ 1500, 800, 2000 ]);
const portalHU   = new Float64Array([ NaN, 730, 712 ]);
const portalHV   = new Float64Array([ NaN, 705, 718 ]);
const netMask = new Uint8Array(N);
for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) netMask[r * W + c] = Math.abs(r - c) < 90 ? 1 : 0;
let rawMinH = Infinity, rawMaxH = -Infinity;
for (let i = 0; i < N; i++) if (mask[i]) { rawMinH = Math.min(rawMinH, height[i]); rawMaxH = Math.max(rawMaxH, height[i]); }
const netMaskInner = new Uint8Array(N);
for (let i = 0; i < N; i++) {
  const f = (height[i] - rawMinH) / (rawMaxH - rawMinH);
  netMaskInner[i] = f > 0.15 && f < 0.85 ? 1 : 0;
}
for (const [r, c] of refs) netMaskInner[r * W + c] = 1;

// A fresh message per run (the workers keep the arrays they are handed).
function msgFor(c, wasm) {
  return {
    kind: "run", H, W, dx: 30, dy: 30, cost, eMax: c.eMax ?? 0, eMaxMode: c.eMaxMode ?? "leg",
    seedR: c.src ? c.src[0] : -1, seedC: c.src ? c.src[1] : -1,
    goalR: c.goal ? c.goal[0] : -1, goalC: c.goal ? c.goal[1] : -1,
    mode: c.mode ?? "from", densityMode: c.mode ?? "from",
    wantPasses: !!c.wantPasses, wantDensity: !!c.refs, densityPartial: c.partial ?? !!c.refs,
    refPoints: c.refs ?? null, maximize: !!c.maximize, nDirs: c.nDirs ?? 8,
    wantMatrix: !!c.matrixCells, matrixCells: c.matrixCells ? Int32Array.from(c.matrixCells) : null,
    wantNetworkInterp: !!c.interp, interpMaxDistance: 50, interpSmoothing: c.interp ? 2 : 0,
    height: new Float32Array(height), mask: new Uint8Array(mask),
    networkMask: c.network ? new Uint8Array(c.network) : null,
    portalU: c.portals ? portalU : null, portalV: c.portals ? portalV : null,
    portalLenM: c.portals ? portalLenM : null, portalHU: c.portals ? portalHU : null, portalHV: c.portals ? portalHV : null,
    ...(wasm ? { wasm } : {}),
  };
}

// |a − b| over two arrays (Infinity patterns must agree); null-safe.
function diff(a, b) {
  if (!a && !b) return { max: 0, bad: 0 };
  if (!a || !b || a.length !== b.length) return { max: Infinity, bad: -1 };
  let max = 0, bad = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (Number.isFinite(x) !== Number.isFinite(y)) bad++;
    else if (Number.isFinite(x)) max = Math.max(max, Math.abs(x - y));
  }
  return { max, bad };
}

const cellOf = ([r, c]) => r * W + c;
const allCells = refs.map(cellOf);
const densityCases = [];
for (const portals of [false, true]) {
  for (const mode of ["from", "to", "round"]) {
    for (const eMax of [0, 20000]) densityCases.push({ mode, eMax, portals });
  }
  densityCases.push({ mode: "round", eMax: 20000, eMaxMode: "total", portals });
}
densityCases.push({ mode: "from", maximize: true });
for (const mode of ["from", "to", "round"]) densityCases.push({ mode, eMax: 20000, network: netMask });
densityCases.push({ mode: "round", eMax: 20000, eMaxMode: "total", network: netMask });
densityCases.push({ mode: "from", eMax: 20000, portals: true, network: netMask });
densityCases.push({ mode: "from", maximize: true, network: netMaskInner });
for (const mode of ["from", "to", "round"]) densityCases.push({ mode, eMax: 20000, droppedRef: true });
for (const nDirs of [16, 32]) {
  densityCases.push({ mode: "from", nDirs });
  densityCases.push({ mode: "from", eMax: 20000, nDirs });
  densityCases.push({ mode: "to", eMax: 20000, nDirs, portals: true });
  densityCases.push({ mode: "round", eMax: 20000, nDirs });
  densityCases.push({ mode: "from", eMax: 20000, nDirs, network: netMask });
}
densityCases.push({ mode: "round", eMax: 20000, eMaxMode: "total", nDirs: 16, portals: true, network: netMask });
densityCases.push({ mode: "from", eMax: 20000, nDirs: 4 });
densityCases.push({ mode: "from", maximize: true, nDirs: 16 });
// Pool slices: a SUBSET of the refs per worker, every slice sampling the
// matrix at ALL K ref cells (matrixCells ≠ the slice's own refs).
densityCases.push({ mode: "from", eMax: 20000, slice: [0, 2] });
densityCases.push({ mode: "round", eMax: 20000, slice: [2, 5], nDirs: 16, portals: true });
// < 3 refs with long moves: both engines skip the long-edge tables and
// integrate on demand (JS useTables / main.rs use_tables) — a 2-ref slice.
densityCases.push({ mode: "from", eMax: 20000, slice: [0, 2], nDirs: 16, network: netMask });
densityCases.push({ mode: "round", slice: [3, 5], nDirs: 32 });

const singleCases = [];
for (const portals of [false, true]) {
  for (const network of [null, netMask]) {
    for (const mode of ["from", "to", "round"]) {
      for (const eMax of [0, 20000]) {
        for (const wantPasses of [false, true]) singleCases.push({ mode, eMax, portals, network, wantPasses });
      }
    }
    singleCases.push({ mode: "round", eMax: 20000, eMaxMode: "total", portals, network, wantPasses: true });
  }
}
for (const nDirs of [16, 32]) {
  singleCases.push({ mode: "from", wantPasses: true, nDirs });
  singleCases.push({ mode: "from", eMax: 20000, portals: true, wantPasses: true, nDirs });
  singleCases.push({ mode: "round", eMax: 20000, network: netMask, wantPasses: true, nDirs });
}
singleCases.push({ mode: "round", eMax: 20000, eMaxMode: "total", portals: true, network: netMask, wantPasses: true, nDirs: 16 });
singleCases.push({ mode: "to", eMax: 20000, wantPasses: true, nDirs: 32 });
// The network IDW fill (visualisation) runs on the JS engine's code after the wasm search.
singleCases.push({ mode: "from", eMax: 20000, network: netMask, wantPasses: true, interp: true });
singleCases.push({ mode: "round", network: netMask, wantPasses: true, interp: true, nDirs: 16 });

// Jobs the wasm engine must NOT serve (or rejects) — they must reach the JS
// engine and reproduce its reply exactly. `fallback` = expect an
// engine-fallback notice (wasm tried and handed over) vs a silent routing.
const routedCases = [
  { label: "single maximize → JS", mode: "from", maximize: true, wantPasses: true, fallback: false },
  { label: "single with destination → JS", mode: "from", goal: [200, 200], wantPasses: true, fallback: false },
  { label: "non-partial density → JS", mode: "from", eMax: 20000, refs, partial: false, fallback: false },
  { label: "nDirs=12 (wasm rejects) → JS", mode: "from", eMax: 20000, wantPasses: true, nDirs: 12, fallback: true },
];

const js = loadWorker(false);
const ww = loadWorker(true);
let allOk = true;
const SEED = [128, 128];

for (const e of engines) {
  const wasm = { module: e.module, is64: e.is64 };
  console.log(`\n=== ${e.name} (${e.file}) ===`);

  for (const c of densityCases) {
    const caseRefs = c.slice ? refs.slice(c.slice[0], c.slice[1]) : (c.droppedRef ? [...refs, [0, 0]] : refs);
    const cells = c.slice ? allCells : caseRefs.map(cellOf);
    const tc = { ...c, refs: caseRefs, matrixCells: cells };
    const a = (await js(msgFor(tc))).done;
    const { done: b, fallback } = await ww(msgFor(tc, wasm));
    const dD = diff(a.density, b.density);
    const dS = diff(a.energySum, b.energySum);
    const dC = diff(a.energyCount, b.energyCount);
    const dM = diff(a.matrix, b.matrix);
    const matrixOk = c.maximize ? (a.matrix == null && b.matrix == null) : (dM.max === 0 && dM.bad === 0);
    const ok = !fallback && b.partial === true && b.engine === e.name &&
      dD.max < 1e-15 && dD.bad === 0 && dS.max === 0 && dS.bad === 0 && dC.max === 0 && matrixOk;
    allOk &&= ok;
    console.log(
      `density ${c.mode}${c.eMax ? ` eMax=${c.eMax}` : ""}${c.eMaxMode === "total" ? " (total)" : ""}` +
      `${c.portals ? " +portals" : ""}${c.network ? " +net" : ""}${c.maximize ? " (maximize)" : ""}` +
      `${c.droppedRef ? " +droppedRef" : ""}${c.slice ? ` slice[${c.slice}]` : ""}${c.nDirs ? ` +ndirs=${c.nDirs}` : ""}: ` +
      `max|Δdensity|=${dD.max.toExponential(1)} |ΔenergySum|=${dS.max.toExponential(1)} |Δcount|=${dC.max} ` +
      `matrix=${c.maximize ? "omitted" : `${dM.max.toExponential(1)}/${dM.bad}`}${fallback ? ` FELL BACK: ${fallback.reason}` : ""} ${ok ? "✓" : "✗"}`,
    );
  }

  for (const c of singleCases) {
    const tc = { ...c, src: SEED };
    const a = (await js(msgFor(tc))).done;
    const { done: b, fallback } = await ww(msgFor(tc, wasm));
    const dE = diff(a.energy, b.energy);
    const dP = diff(a.passes, b.passes);
    const ok = !fallback && b.engine === e.name && b.path === null && b.routes === null &&
      dE.max === 0 && dE.bad === 0 && dP.max === 0 && dP.bad === 0 &&
      (a.passes == null) === (b.passes == null) && b.energy instanceof Float32Array &&
      (b.passes == null || b.passes instanceof Float64Array);
    allOk &&= ok;
    console.log(
      `single ${c.mode}${c.eMax ? ` eMax=${c.eMax}` : ""}${c.eMaxMode === "total" ? " (total)" : ""}` +
      `${c.portals ? " +portals" : ""}${c.network ? " +net" : ""}${c.interp ? " +interp" : ""}` +
      `${c.wantPasses ? " +passes" : ""}${c.nDirs ? ` +ndirs=${c.nDirs}` : ""}: ` +
      `max|Δenergy|=${dE.max.toExponential(1)} finite-mismatch=${dE.bad} max|Δpasses|=${dP.max.toExponential(1)}` +
      `${fallback ? ` FELL BACK: ${fallback.reason}` : ""} ${ok ? "✓" : "✗"}`,
    );
  }

  for (const c of routedCases) {
    const tc = { ...c, src: c.refs ? null : SEED };
    const a = (await js(msgFor(tc))).done;
    const { done: b, fallback } = await ww(msgFor(tc, wasm));
    const dE = diff(a.energy, b.energy);
    const dP = diff(a.passes, b.passes);
    const samePath = JSON.stringify(a.path) === JSON.stringify(b.path);
    const ok = !b.engine && !!fallback === c.fallback && dE.max === 0 && dE.bad === 0 && dP.max === 0 && samePath;
    allOk &&= ok;
    console.log(`${c.label}: identical to JS=${dE.max === 0 && dP.max === 0 && samePath}${fallback ? ` (fallback: ${fallback.reason})` : ""} ${ok ? "✓" : "✗"}`);
  }
}

console.log(allOk ? "\nWASM WORKER MATCHES JS WORKER" : "\nMISMATCH");
process.exit(allOk ? 0 : 1);
