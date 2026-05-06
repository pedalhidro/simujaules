// energy-worker-wasm.js — Wasm-backed Web Worker. Same message API as
// energy-worker.js so app.js can use either one interchangeably.
//
// Speed comes from two places:
//  1. The Dijkstra inner loop is compiled Rust, with bounds-checks elided
//     where LLVM can prove safety, and tighter cache locality on the heap.
//  2. The DEM and result buffers live in wasm linear memory, so loading the
//     DEM and reading back the energy field are zero-copy memcpys via typed
//     array views — no per-cell marshalling across the JS/wasm boundary.
//
// Module-worker (`type: "module"`) so we can dynamic-import the wasm-pack
// glue. Browsers that don't support module workers will fail to construct
// this worker, in which case app.js silently falls back to energy-worker.js.

let wasm = null;          // exports object from wasm-pack init()
let initError = null;
let initPromise = null;

async function ensureWasm() {
  if (wasm) return wasm;
  if (initError) throw initError;
  if (!initPromise) {
    initPromise = (async () => {
      const mod = await import("./wasm/pkg/energy_wasm.js");
      // wasm-pack `--target web` resolves the .wasm URL relative to its
      // own JS file via import.meta.url, which works inside workers.
      wasm = await mod.default();
      // `wasm` is the exports object from the instantiated module; it has
      // `.memory` and the bindgen-generated class/function exports.
      // Pull the constructor off the namespace too — `wasm` is not always
      // the same reference, depending on bindgen version.
      wasm.EnergySolver = mod.EnergySolver;
      return wasm;
    })().catch((e) => {
      initError = e;
      throw e;
    });
  }
  return initPromise;
}

// Try to init at startup so app.js's probe gets a fast `ready` / `wasm_failed`.
ensureWasm().then(
  () => self.postMessage({ kind: "ready" }),
  (e) => self.postMessage({ kind: "wasm_failed", reason: String(e?.message ?? e) }),
);

self.onmessage = async (ev) => {
  const msg = ev.data;
  if (msg.kind !== "run") return;

  try {
    await ensureWasm();
  } catch (e) {
    self.postMessage({ kind: "error", message: "wasm not available: " + (e?.message ?? e) });
    return;
  }

  const t0 = performance.now();
  const {
    height, mask, H, W, dx, dy,
    seedR, seedC,
    goalR, goalC,
    mode,
    alpha, beta, eta,
    eMax = 0,
  } = msg;

  const wantPath = goalR >= 0 && goalC >= 0;
  const goalIdx = wantPath ? goalR * W + goalC : -1;

  let solver = null;
  try {
    const N = H * W;
    solver = new wasm.EnergySolver(H, W);

    // Copy DEM into wasm memory. Re-fetch buffer each time because wasm
    // memory growth (during Vec allocation) detaches earlier views.
    {
      const hView = new Float32Array(wasm.memory.buffer, solver.height_ptr(), N);
      hView.set(height);
      const mView = new Uint8Array(wasm.memory.buffer, solver.mask_ptr(), N);
      mView.set(mask);
    }

    let energy;
    let path = null;
    let pathEnergy = null;

    if (mode === "from" || mode === "to") {
      const reverse = mode === "to";
      solver.run(seedR, seedC, dx, dy, alpha, beta, eta, reverse, wantPath, eMax);

      // Copy energy out (so we own a buffer we can transfer back to main).
      const eView = new Float32Array(wasm.memory.buffer, solver.energy_ptr(), N);
      energy = new Float32Array(eView);

      if (wantPath && Number.isFinite(energy[goalIdx])) {
        const pView = new Int32Array(wasm.memory.buffer, solver.parents_ptr(), N);
        path = reconstructPath(pView, goalIdx);
        pathEnergy = energy[goalIdx];
      }
    } else {
      // round trip = forward + reverse, summed
      solver.run(seedR, seedC, dx, dy, alpha, beta, eta, false, wantPath, eMax);
      const eFwd = new Float32Array(
        new Float32Array(wasm.memory.buffer, solver.energy_ptr(), N),
      );
      let pFwd = null;
      if (wantPath) {
        pFwd = new Int32Array(
          new Int32Array(wasm.memory.buffer, solver.parents_ptr(), N),
        );
      }

      solver.run(seedR, seedC, dx, dy, alpha, beta, eta, true, false, eMax);
      const eBwd = new Float32Array(wasm.memory.buffer, solver.energy_ptr(), N);

      energy = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        const a = eFwd[i];
        const b = eBwd[i];
        energy[i] = !Number.isFinite(a) || !Number.isFinite(b) ? Infinity : a + b;
      }

      if (wantPath && pFwd && Number.isFinite(energy[goalIdx])) {
        path = reconstructPath(pFwd, goalIdx);
        pathEnergy = energy[goalIdx];
      }
    }

    let pathLengthM = null;
    if (path) {
      let len = 0;
      for (let i = 1; i < path.length; i++) {
        const a = path[i - 1];
        const b = path[i];
        const ar = (a / W) | 0;
        const ac = a - ar * W;
        const br = (b / W) | 0;
        const bc = b - br * W;
        len += Math.hypot((br - ar) * dy, (bc - ac) * dx);
      }
      pathLengthM = len;
    }

    const t1 = performance.now();
    self.postMessage(
      {
        kind: "done",
        energy,
        path,
        pathEnergy,
        pathLengthM,
        elapsedMs: t1 - t0,
        engine: "wasm",
      },
      [energy.buffer],
    );
  } catch (err) {
    self.postMessage({ kind: "error", message: err?.message ?? String(err) });
  } finally {
    if (solver) {
      try { solver.free(); } catch { /* free is wasm-bindgen-generated; safe to ignore */ }
    }
  }
};

function reconstructPath(parents, goalIdx) {
  const path = [];
  let idx = goalIdx;
  // Cap iterations defensively in case of a corrupt parents array.
  const cap = parents.length + 1;
  let steps = 0;
  while (idx >= 0 && steps++ < cap) {
    path.push(idx);
    idx = parents[idx];
  }
  path.reverse();
  return path;
}
