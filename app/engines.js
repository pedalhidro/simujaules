// Engine sizing and choice: memory budget, densityPoolSize(), the
// WebAssembly engine selection, backend capabilities, compute-source UI.
import "./refgeom.js"; // evaluation order — see ../app.js
import { WASM_ENGINE_URLS } from "./boot.js";
import { state } from "./state.js";
import { computeMode, effectiveBackendUrl } from "./compute-source.js";
import { setCloudHint } from "./cloud.js";
import { estimateRunTime } from "./estimate.js";

// Shared conservative memory budget (bytes) for browser worker pools, derived
// from navigator.deviceMemory (GB; the spec CAPS it at 8 — a floor on true
// RAM, never the full amount) with a conservative fraction. densityPoolSize,
// interpPoolSize AND startComparePair's parallelism gate all size against
// this SAME number so they can't drift into three independently-tuned
// budgets.
export function memBudgetBytes() {
  const devMemGB = navigator.deviceMemory || 4;
  return Math.max(1.5e9, devMemGB * 1e9 * 0.45);
}

// Density worker-pool size, shared by the runner and the time estimator so
// they can never drift. Each worker's resident set ≈ DEM copy (height f32 4 +
// mask u8 1 = 5 B/cell) + densityField scratch (E4 + settled1 + parents4 +
// order4 + passes-f32 4 = 17) + outputs (density-f32 4 + energySum-f64 8 +
// energyCount 4 = 16) ≈ 38 B/cell, ~55 in round mode (a second search
// resident). The optional #max-workers input lets a user on a big-RAM machine
// (which deviceMemory can't see) force more, still clamped by K.
// `engine` ("wasm32"/"wasm64", default null = the JS worker) switches the
// per-worker footprint to wasmJobBytes — the wasm engine holds more per worker.
export function densityPoolSize({ N, K, round, nDirs = 8, hasNet = false, engine = null }) {
  if (!K) return 1;
  const cores = Math.max(1, (navigator.hardwareConcurrency || 4) - 1);
  // nDirs > 8: densityField precomputes f64 long-edge cost tables per worker
  // (8 B/cell per long move, both travel directions resident in round mode)
  // — see energy-worker.js longTables. Budget them or a 16-direction run on
  // a big DEM OOMs the pool that 38 B/cell would have allowed.
  const nLong = { 16: 8, 32: 24, 64: 56, 128: 120 }[nDirs] || 0;
  const tableBytes = 8 * nLong * (round ? 2 : 1);
  const bytesPerWorker = engine
    ? wasmJobBytes({ N, density: true, round, nDirs, hasNet }).total
    : ((round ? 55 : 38) + tableBytes) * N;
  const memCap = Math.max(1, Math.floor(memBudgetBytes() / bytesPerWorker));
  const overrideN = maxWorkersOverride();
  return overrideN
    ? Math.max(1, Math.min(K, overrideN))
    : Math.max(1, Math.min(K, cores, memCap));
}

// The #max-workers override (0 = auto). A set value is also the user vouching
// for a big-RAM machine that navigator.deviceMemory (capped at 8) can't see.
function maxWorkersOverride() {
  const v = parseInt(document.getElementById("max-workers")?.value, 10);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

// ---- WebAssembly engine selection (v80) ------------------------------------
// Shared by the runner AND the time estimate (currentRunOpts) so they can't
// drift — the same rule as densityPoolSize.

// Measured per-worker speedups of the wasm engine over the JS worker (Chrome
// 151 / Firefox 155 on the SP DTMs, 0.55–8.5 M cells, best-vs-best): density
// 1.9–2.4× at 8 directions and 1.45–2.1× at 16; single-source 1.4–1.5× at 8
// and 1.3–1.46× at 16. Conservative round numbers — the corrWasm online
// correction absorbs the per-machine residual.
export function wasmSpeedup(density, nDirs = 8) {
  const classic = nDirs <= 8;
  return density ? (classic ? 2.0 : 1.5) : (classic ? 1.4 : 1.3);
}

// Bytes/cell ONE wasm job holds, mirroring backend/src/main.rs's buffers (keep
// in sync with Scratch/Acc/compute_single there). `linear` = the module's
// linear memory: parsed inputs (height 4 + mask 1, + the effective network
// mask 1) + the engine's working set + ~2 B/cell of radix-heap frontier;
// `total` adds the worker's JS-side copies of the outputs and the message's
// own DEM arrays.
//   density slice: Scratch 17 (+1 parent_long with long moves) + Acc 20
//     (density f64 + energy_sum f64 + energy_count u32); round keeps a second
//     Scratch + the include mask; long-edge tables 8 B per long move per
//     travel direction. Outputs copied out: 20.
//   single: Scratch 17(+1) + passes f64 8 + energy copy 4; round: two Scratch
//     + energy 4 + include 1 + three f64 passes arrays 24 (no tables — long
//     moves integrate on demand). Outputs copied out: 12.
// The linear-memory high-water mark never shrinks, and a pool worker is
// terminated after its slice, so these are per-worker peaks.
function wasmJobBytes({ N, density, round, nDirs = 8, hasNet = false }) {
  const nLong = { 16: 8, 32: 24, 64: 56, 128: 120 }[nDirs] || 0;
  const scratch = 17 + (nLong ? 1 : 0);
  const inputs = 5 + (hasNet ? 1 : 0);
  let work, copies;
  if (density) {
    work = (round ? 2 * scratch + 1 : scratch) + 20 + 8 * nLong * (round ? 2 : 1);
    copies = 20;
  } else {
    work = round ? 2 * scratch + 4 + 1 + 24 : scratch + 8 + 4;
    copies = 12;
  }
  const linear = (inputs + work + 2) * N;
  return { linear, total: linear + (copies + inputs) * N };
}

// wasm32 addresses 4 GiB; keep headroom for allocator fragmentation. wasm64
// (Memory64, Chrome ≥ 133 / Firefox ≥ 143) is built with a declared 16 GiB max.
const WASM32_MAX_LINEAR = 3.75 * 2 ** 30;
const WASM64_MAX_LINEAR = 15 * 2 ** 30;

// A 13-byte module declaring one i64-indexed memory: validates iff Memory64.
const MEMORY64_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 5, 3, 1, 4, 1]);
let memory64Supported_ = null;
function memory64Supported() {
  if (memory64Supported_ === null) {
    try { memory64Supported_ = WebAssembly.validate(MEMORY64_PROBE); } catch { memory64Supported_ = false; }
  }
  return memory64Supported_;
}

function wasmEnabled() {
  return typeof WebAssembly === "object" && !!document.getElementById("use-wasm")?.checked;
}

// Which wasm engine should run one job — or null for the JS engine. Past the
// conservative browser budget the JS engine (smaller footprint) keeps the job,
// unless #max-workers vouches for a big-RAM machine; wasm32 when it fits,
// else wasm64 where the browser has Memory64. A module that failed to load
// is skipped for the rest of the session.
function wasmEngineFor(job) {
  if (!wasmEnabled()) return null;
  const { linear, total } = wasmJobBytes(job);
  if (!maxWorkersOverride() && total > memBudgetBytes()) return null;
  if (linear <= WASM32_MAX_LINEAR && !state.wasm.failed.wasm32) return "wasm32";
  if (linear <= WASM64_MAX_LINEAR && memory64Supported() && !state.wasm.failed.wasm64) return "wasm64";
  return null;
}

// Density pools: a wasm worker is ~1.5–2× faster but holds more memory, so on
// a big DEM the budget can fit fewer wasm workers than JS ones. Use wasm only
// when its pool's throughput (workers × speedup) matches or beats the JS pool.
export function densityEngine({ N, K, round, nDirs = 8, hasNet = false }) {
  const engine = wasmEngineFor({ N, density: true, round, nDirs, hasNet });
  if (!engine) return null;
  const pJs = densityPoolSize({ N, K, round, nDirs, hasNet });
  const pWasm = densityPoolSize({ N, K, round, nDirs, hasNet, engine });
  return pWasm * wasmSpeedup(true, nDirs) >= pJs ? engine : null;
}

// Single-source runs take the wasm engine only for the plain energy field —
// the same gate as the native backend's /single (no destination path, top-N
// or maximize; graph mode and the constrained-vs-free compare stay JS).
export function singleEngine({ N, mode, nDirs = 8, hasNet = false, wantTopN, maximize, wantPath, graph, compare }) {
  if (wantTopN || maximize || wantPath || graph || compare) return null;
  if (!["from", "to", "round"].includes(mode)) return null;
  return wasmEngineFor({ N, density: false, round: mode === "round", nDirs, hasNet });
}

// Compile an engine module once per session; every worker gets the compiled
// WebAssembly.Module (structured clone shares the code, no recompile).
// Resolves { module, is64 }, or null when it can't be fetched/compiled — the
// failure is remembered, so later runs (and the estimate) fall to the next
// engine or the JS worker straight away.
export function loadWasmEngine(engine) {
  if (!state.wasm.loading[engine]) {
    state.wasm.loading[engine] = (async () => {
      const resp = await fetch(WASM_ENGINE_URLS[engine]);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      let module;
      // compileStreaming needs Content-Type application/wasm; fall back to bytes.
      try { module = await WebAssembly.compileStreaming(resp.clone()); }
      catch { module = await WebAssembly.compile(await resp.arrayBuffer()); }
      return { module, is64: engine === "wasm64" };
    })().catch((err) => {
      console.warn(`[wasm] ${engine} unavailable — using the JS engine:`, err);
      state.wasm.failed[engine] = String(err?.message || err);
      estimateRunTime();
      return null;
    });
  }
  return state.wasm.loading[engine];
}

// Interp worker-pool size, shared by runInterp AND the time estimate
// (predictInterpMs) so they can never drift — same rule as densityPoolSize.
// Each band worker holds the FULL grid PLUS its idwFill scratch (~15 B/cell:
// inputs 6 [energy f32 4 + mask 1 + networkMask 1] + idwFill's out Float32
// 4 + seedMask u8 1 + chamfer Int32 dist 4; the returned band slice is
// ≤4·N/P, excluded) since rays read past band edges; budgeted against
// deviceMemory (spec-capped at 8 GB) with the #max-workers override
// (clamped by the band cap). The interp runs AFTER the Dijkstra workers are
// freed (and in Cloud mode the browser never ran them), so this RAM is
// genuinely available.
export function interpPoolSize(N, H) {
  const cores = Math.max(1, (navigator.hardwareConcurrency || 4) - 1);
  const memCap = Math.max(1, Math.floor(memBudgetBytes() / (15 * N)));
  const userMax = parseInt(document.getElementById("max-workers")?.value, 10);
  const overrideN = Number.isFinite(userMax) && userMax > 0 ? userMax : 0;
  const bandCap = Math.ceil(H / 64);
  return overrideN
    ? Math.max(1, Math.min(bandCap, overrideN))
    : Math.max(1, Math.min(cores, memCap, bandCap));
}

// Cache the native backend's core count from /health so the time estimate's
// backend-parallelism model reflects the actual server. Only pinged when the
// backend toggle/URL changes (not per estimate). Cleared/ignored when the
// backend is off; falls back to BACKEND_PAR_CAP if unreachable.
export async function refreshBackendCores() {
  // Only Localhost probes /health on idle. Browser has no backend; Cloud's VM is
  // off between runs (and the orchestrator itself has no /health — it doesn't
  // serve density/single, just start/stop/status) — ensureCloudVm fills
  // state.backendCores at run time instead.
  if (computeMode() !== "localhost") { state.backendCores = null; estimateRunTime(); return; }
  const url = effectiveBackendUrl();
  if (!url) { state.backendCores = null; estimateRunTime(); return; }
  try {
    const resp = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
    if (resp.ok) {
      const h = await resp.json();
      // mem_budget_bytes lets the estimate replicate the server's slice cap
      // (the dominant backend parallelism limit on huge DEMs). Older backends
      // don't send it — fall back to a default in the estimate.
      if (Number.isFinite(h.cores)) {
        state.backendCores = {
          url, cores: h.cores,
          memBudgetBytes: Number.isFinite(h.mem_budget_bytes) ? h.mem_budget_bytes : null,
          version: typeof h.version === "string" ? h.version : null,
        };
      }
    }
  } catch { /* unreachable — estimate falls back to the parallelism cap */ }
  estimateRunTime();
}

// Does the last-probed backend serve nDirs ≠ 8? The move-set port shipped in
// backend 0.2.0 — an OLDER binary silently IGNORES the params field (serde
// skips unknown keys) and would return an 8-direction field the app would
// mislabel, so the version gate is load-bearing, not cosmetic.
export function backendServesNDirs() {
  const v = state.backendCores && state.backendCores.version;
  if (!v) return false;
  const [maj, min] = v.split(".").map((x) => parseInt(x, 10));
  return maj > 0 || min >= 2;
}

// Reconcile the compute-source sub-panels (Localhost URL / Cloud orchestrator)
// to the selected radio (Cloud has no origin gating — see the body comment
// below). Called on every selector change AND on load (the radiogroup is in
// PERSIST_REFIRE). Mirrors the old syncBackend's show/hide, extended to three
// states.
export function syncComputeSourceUI() {
  const mode = computeMode();
  const lh = document.getElementById("localhost-extra");
  const cl = document.getElementById("cloud-extra");
  if (lh) lh.style.display = mode === "localhost" ? "" : "none";
  if (cl) cl.style.display = mode === "cloud" ? "" : "none";
  // Cloud now works from ANY origin (the orchestrator is a public Cloud Run
  // service, not loopback), so there's no origin gating — the run path requires
  // the orchestrator URL + password instead. Seed the VM-status hint when Cloud
  // is freshly shown (no VM up yet); a live boot/stop overwrites it via setCloudHint.
  if (mode === "cloud") {
    if (!state.cloud.keepaliveTimer && state.cloud.vmState !== "RUNNING") setCloudHint("cloud.idle");
  } else {
    setCloudHint(null);
  }
}
