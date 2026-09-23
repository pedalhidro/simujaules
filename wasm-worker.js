// wasm-worker.js — WebAssembly compute worker (v80).
//
// A SUPERSET of energy-worker.js: it importScripts the JS engine, so every
// message kind keeps working exactly as before (probe, interp, smooth, graph,
// top-N, destination paths, maximize single-source, …). It intercepts only the
// two jobs the WebAssembly build of the native engine serves, and only when
// the page attached a compiled module (msg.wasm = { module, is64 }):
//   • density POOL slices (densityPartial) → the raw accumulators the JS
//     worker returns for the pool merge (density, energySum, energyCount,
//     matrix rows);
//   • plain single-source fields (from/to/round with no destination, top-N or
//     maximize — the same gate as the native backend's /single) → energy +
//     passes, then the JS engine's own network IDW fill when requested.
// Replies use energy-worker.js's message protocol, so app.js merges and
// renders them unchanged. Requests are framed like the native backend's
// POST /density | /single, because the module IS backend/src/main.rs
// (wasm/src/lib.rs include!s it): its numbers equal the Localhost/Cloud
// engine's, and JS-worker parity is the backend's (backend/test-backend.mjs),
// re-checked through this file by wasm/test-wasm.mjs.
//
// Any wasm failure — instantiation, a validation error, a trap (out of
// memory) — posts { kind: "engine-fallback", stage: "instantiate" | "run" }
// and reruns the SAME message on the JS engine, so a compute never fails
// because of the accelerator.
importScripts("energy-worker.js");

// Everything below is function-scoped: importScripts shares ONE global scope
// with energy-worker.js, where a duplicate top-level const/let would be a
// SyntaxError that only a real browser surfaces.
(() => {
const jsOnMessage = self.onmessage;

const enc = new TextEncoder();
const dec = new TextDecoder();
let inst = null; // { x: exports, is64 } — reused across messages; dropped after a failure

async function wasmInstance(spec) {
  if (inst && inst.is64 === !!spec.is64) return inst;
  inst = null;
  const instance = await WebAssembly.instantiate(spec.module, {});
  inst = { x: instance.exports, is64: !!spec.is64 };
  return inst;
}

// Which wasm job serves this message: 0 = density partial, 1 = single source,
// null = leave it to the JS engine.
function wasmJob(msg) {
  if (!msg || msg.kind !== "run" || !msg.wasm || !msg.wasm.module) return null;
  if (msg.wantDensity) {
    return msg.densityPartial && Array.isArray(msg.refPoints) && msg.refPoints.length > 0 ? 0 : null;
  }
  const hasGoal = msg.goalR >= 0 && msg.goalC >= 0;
  if (hasGoal || msg.wantTopN || msg.maximize) return null;
  return ["from", "to", "round"].includes(msg.mode) ? 1 : null;
}

// Frame params + arrays like the backend's request body, straight into wasm
// memory, run it, and copy the result arrays out (ArrayBuffers).
function call({ x, is64 }, params, arrays, kind) {
  const U = is64 ? BigInt : Number; // usize ABI: u64 (BigInt) on wasm64
  const json = enc.encode(JSON.stringify(params));
  let len = 4 + json.length;
  for (const a of arrays) len += a.byteLength;
  const p = Number(x.alloc(U(len)));
  const u8 = new Uint8Array(x.memory.buffer, p, len); // after alloc: memory may have grown
  new DataView(x.memory.buffer).setUint32(p, json.length, true);
  u8.set(json, 4);
  let off = 4 + json.length;
  for (const a of arrays) {
    u8.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), off);
    off += a.byteLength;
  }
  const status = x.run(U(p), U(len), kind); // consumes the buffer
  const mem = () => x.memory.buffer;        // re-read: the run grew memory
  if (status !== 0) {
    const q = Number(x.err_ptr()), l = Number(x.err_len());
    const text = dec.decode(new Uint8Array(mem(), q, l).slice());
    x.release();
    throw new Error(`wasm engine rejected the request (${status}): ${text}`);
  }
  const outs = [];
  const n = Number(x.out_count());
  for (let i = 0; i < n; i++) {
    const q = Number(x.out_ptr(U(i))), l = Number(x.out_len(U(i)));
    outs.push(mem().slice(q, q + l));
  }
  x.release();
  return outs;
}

// Bridge portal arrays in the backend's wire order (nPortals = 0 when absent).
function portalArrays(msg) {
  if (!msg.portalU || !msg.portalU.length) return { n: 0, arrays: [] };
  const n = msg.portalU.length;
  const nan = () => new Float64Array(n).fill(NaN); // deck ele absent ⇒ DEM height
  return {
    n,
    arrays: [msg.portalU, msg.portalV, msg.portalLenM, msg.portalHU || nan(), msg.portalHV || nan()],
  };
}

function runDensityPartial(engine, msg) {
  const { H, W, dx, dy, cost, eMax = 0, eMaxMode = "leg", refPoints, densityMode = "from",
          maximize = false, wantMatrix = false, matrixCells = null, nDirs = 8,
          height, mask, networkMask = null } = msg;
  const portals = portalArrays(msg);
  const matrix = !!(wantMatrix && matrixCells);
  const params = {
    h: H, w: W, dx, dy, cost, eMax, eMaxMode, densityMode,
    refPoints, hasNetwork: !!networkMask, maximize,
    nPortals: portals.n, wantMatrix: matrix, nDirs,
    // The slice's rows sample at ALL K ref cells (Params.matrix_cells).
    ...(matrix ? { matrixCells: Array.from(matrixCells) } : {}),
  };
  const arrays = [height, mask, ...(networkMask ? [networkMask] : []), ...portals.arrays];
  const [d, es, ec, m] = call(engine, params, arrays, 0);
  return {
    density: new Float64Array(d),
    energySum: new Float64Array(es),
    energyCount: new Uint32Array(ec),
    matrix: m ? new Float32Array(m) : null,
  };
}

function runSingle(engine, msg) {
  const { H, W, dx, dy, cost, eMax = 0, eMaxMode = "leg", mode, seedR, seedC,
          wantPasses = false, nDirs = 8, height, mask, networkMask = null } = msg;
  const portals = portalArrays(msg);
  const params = {
    h: H, w: W, dx, dy, cost, eMax, eMaxMode, densityMode: mode,
    src: [seedR, seedC], wantPasses: !!wantPasses, hasNetwork: !!networkMask,
    maximize: false, nPortals: portals.n, nDirs,
  };
  const arrays = [height, mask, ...(networkMask ? [networkMask] : []), ...portals.arrays];
  const [e, p] = call(engine, params, arrays, 1);
  let energy = new Float32Array(e);
  // Visualisation fill across non-network cells — the JS engine's own code,
  // exactly as its single-source branch runs it (DEM mask, not effMask).
  if (msg.wantNetworkInterp && networkMask) {
    energy = fillAcrossNetwork(energy, networkMask, mask, H, W, dx, dy,
                               msg.interpMaxDistance ?? 50, msg.interpSmoothing ?? 0);
  }
  return { energy, passes: wantPasses && p ? new Float64Array(p) : null };
}

self.onmessage = async (ev) => {
  const msg = ev.data;
  const kind = wasmJob(msg);
  if (kind === null) return jsOnMessage(ev);
  const t0 = performance.now();
  const engineName = msg.wasm.is64 ? "wasm64" : "wasm32";
  let out, transfer, stage = "instantiate";
  try {
    const engine = await wasmInstance(msg.wasm);
    stage = "run";
    if (kind === 0) {
      const r = runDensityPartial(engine, msg);
      out = { kind: "done", partial: true, ...r, elapsedMs: performance.now() - t0, engine: engineName };
      transfer = [r.density.buffer, r.energySum.buffer, r.energyCount.buffer];
      if (r.matrix) transfer.push(r.matrix.buffer);
    } else {
      const r = runSingle(engine, msg);
      out = {
        kind: "done", energy: r.energy, passes: r.passes,
        path: null, pathEnergy: null, pathLengthM: null, routes: null,
        elapsedMs: performance.now() - t0, engine: engineName,
      };
      transfer = [r.energy.buffer];
      if (r.passes) transfer.push(r.passes.buffer);
    }
  } catch (err) {
    // A trap leaves the instance unusable — drop it (and its memory) before
    // the JS engine allocates its own buffers for the same job.
    inst = null;
    postMessage({ kind: "engine-fallback", engine: engineName, stage, reason: String((err && err.message) || err) });
    return jsOnMessage(ev);
  }
  postMessage(out, transfer);
};
})();
