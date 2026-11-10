// Run-time estimate: calibration probe, predictComputeMs(), the online
// correction, and the duration / byte / energy formatters.
import "./cloud.js"; // evaluation order — see ../app.js
import { t } from "./i18n.js";
import { costAlphaEquiv, readCost } from "./panel.js";
import { WORKER_URL } from "./boot.js";
import { state } from "./state.js";
import { backendSpecForEstimate, computeMode } from "./compute-source.js";
import { networkConstraintActive } from "./network-view.js";
import { graphModeActive } from "./graph-mode.js";
import {
  backendServesNDirs, densityEngine, densityPoolSize, interpPoolSize, singleEngine, wasmSpeedup,
} from "./engines.js";
import { buildComputeGrid, buildPortals } from "./grid.js";

// Calibration probe: each ref runs an UNBUDGETED search stopped after
// PROBE_MAX_SETTLED cells. Capping by cell count (not energy budget) bounds the
// probe's wall time regardless of DEM size — the ≤3 s (ideally ≤1 s) target —
// while anchoring the estimate at an unsaturated point, which fixes the old
// fixed-budget model's up-to-3.8× error on small DEMs it saturated. The few
// spread refs (not 2 central ones) average out per-ref placement variance.
const PROBE_MAX_SETTLED = 1_000_000;
const PROBE_REFS = 3;

// One-shot, off-thread calibration of the compute-time estimate for the
// current DEM. Runs PROBE_REFS budgeted Dijkstras in a dedicated worker,
// measuring the one-time allocation cost and the per-ref search throughput,
// so estimateRunTime() can scale with the energy budget instead of a fixed
// full-grid rate. Generation-guarded (a new DEM load drops a stale result);
// deferred while a real compute is running so it doesn't steal cores.
export function startCalibrationProbe() {
  if (!state.dem) return;
  if (state.computeStartedAt) return; // a compute is running — retried in computeDone
  if (state.probeWorker) { state.probeWorker.terminate(); state.probeWorker = null; }

  const { H, W } = state.dem;
  // Probe the EFFECTIVE compute grid (impassable blocked, corridors reopened)
  // so the time estimate reflects the terrain a real run actually traverses.
  const { height: probeHeight, mask } = buildComputeGrid();
  // Two deterministic interior, on-mask reference cells (sample real relief,
  // not a corner). Spiral out from each target to the nearest valid cell.
  const findValid = (r0, c0) => {
    for (let rad = 0; rad < Math.max(H, W); rad++) {
      for (let dr = -rad; dr <= rad; dr += Math.max(1, 2 * rad)) {
        const r = r0 + dr;
        if (r < 0 || r >= H) continue;
        for (let dc = -rad; dc <= rad; dc++) {
          const c = c0 + dc;
          if (c < 0 || c >= W) continue;
          if (mask[r * W + c]) return [r, c];
        }
      }
    }
    return null;
  };
  const refs = [];
  for (const [fr, fc] of [[0.5, 0.5], [0.3, 0.35], [0.7, 0.65]]) {
    const v = findValid(Math.round(fr * H), Math.round(fc * W));
    if (v) refs.push(v);
  }
  if (refs.length < 2) return; // degenerate mask; estimate stays uncalibrated

  const probeGen = state.calibrationGen;
  const cost = readCost();

  const w = new Worker(WORKER_URL);
  state.probeWorker = w;
  w.onmessage = (ev) => {
    const m = ev.data;
    if (m.kind === "error") {
      // The probe threw in the worker — don't leak the worker or leave the
      // estimate stuck on "estimating…" until the next DEM load. Flag the
      // failure so estimateRunTime blanks instead; computeDone retries later.
      console.warn("[probe] calibration probe failed:", m.message);
      w.terminate();
      if (state.probeWorker === w) state.probeWorker = null;
      if (probeGen === state.calibrationGen) { state.calibrationFailed = true; estimateRunTime(); }
      return;
    }
    if (m.kind !== "probe-done") return;
    w.terminate();
    if (state.probeWorker === w) state.probeWorker = null;
    if (probeGen !== state.calibrationGen) return; // superseded by a newer DEM
    // Anchor this DEM/terrain's compute model at the probe's UNSATURATED
    // cell-capped point (Estar cells reached at budget bStar, in perRefProbe
    // ms incl. the passes walk). The estimate then scales:
    //   explored(eMax,alpha) = min(N, Estar·(eMax·αprobe/(bStar·α))^EXPLORE_EXP)
    //   perRef(explored)     = perRefProbe·(explored/Estar)^RATE_EXP
    // Anchoring at an unsaturated point (vs the old fixed budget that
    // saturated small DEMs) is what fixes the up-to-3.8× small-DEM error;
    // online correction absorbs the residual exponent/scale drift.
    const Estar = Math.max(1, m.exploredTotal / m.nRefs);
    const bStar = Math.max(1, m.budgetReached);
    const perRefProbe = Math.max(0.01, (m.totalMs - m.allocMs) / m.nRefs);
    state.calibration = {
      N: m.N,
      allocMsN: m.allocMs,
      Estar, bStar, perRefProbe,
      alphaAtProbe: costAlphaEquiv(cost),
      // Online correction: actual/predicted from completed computes, per
      // PHASE/engine (the backend's native-speedup × slice-contention factor,
      // the graph engine's per-edge cost, and the interp fill rate are all
      // scale-/network-dependent, so we learn them rather than guess).
      corrBrowser: 1, corrBackend: 1, corrGraph: 1, corrInterp: 1, corrWasm: 1,
    };
    estimateRunTime();
  };
  w.onerror = () => {
    w.terminate();
    if (state.probeWorker === w) state.probeWorker = null;
    if (probeGen === state.calibrationGen) { state.calibrationFailed = true; estimateRunTime(); }
  };

  // Cell cap: bound the probe's search time (the 3 s / ~1 s target) yet stay
  // unsaturated. min(fixed, 0.4·N) keeps it < N (so it always anchors below
  // full grid). On a 135 M-cell DEM ≈ 3×1 M cells ≈ ~1 s search + first-touch.
  const N = H * W;
  const maxSettled = Math.min(PROBE_MAX_SETTLED, Math.max(50_000, Math.floor(0.4 * N)));
  w.postMessage(
    {
      kind: "probe",
      height: probeHeight, mask, H, W,
      dx: state.dem.dxM, dy: state.dem.dyM,
      cost, maxSettled,
      refPoints: refs,
    },
    [probeHeight.buffer, mask.buffer],
  );
  state.calibrationFailed = false; // a fresh probe is in flight
  estimateRunTime(); // show "estimating…" until the probe lands
}

// ------- Compute-time estimation -------
// Calibrated by a per-DEM two-budget probe at load (state.calibration; see
// startCalibrationProbe), which anchors this DEM/terrain at an unsaturated
// cell-capped probe point (Estar cells at budget bStar, perRefProbe ms):
//   explored(eMax,alpha) = min(N, Estar·(eMax·alphaAtProbe/(bStar·alpha))^EXPLORE_EXP)
//   perRef(explored)     = perRefProbe·(explored/Estar)^RATE_EXP
// plus allocMsN (one-time scratch alloc). Online-corrected per engine
// (corrBrowser/corrBackend) from completed computes.
// Tunables:
const EXPLORE_EXP     = 2.1;  // explored ∝ reach^EXPLORE_EXP (reach ∝ eMax/alpha;
                              // area ∝ reach², ~2.1 measured on real terrain).
const RATE_EXP        = 1.1;  // perRef ∝ explored^RATE_EXP (>1 = cache
                              // rate-degradation as the frontier outgrows cache).
const NATIVE_SPEEDUP  = 1.6;  // native per-ref speedup vs JS — nominal; both
                              // converge toward bandwidth-bound on huge
                              // frontiers (~1.3) and diverge on small ones
                              // (~2.4). Online correction adjusts the residual.
const BW_CONTENTION   = 0.2;  // shared-memory-bandwidth penalty coefficient.
                              // Applied SUB-linearly (√(slices−1), below): the
                              // linear USL form was tuned in the 1–2-slice
                              // regime (huge DEMs, RAM-capped) where both agree,
                              // but extrapolated linearly it capped ANY machine
                              // at 1/κ = 5× total speedup — 128 vCPUs estimated
                              // a mere 1.4× faster than 8 on a mid-size DEM
                              // (visto na prática). √ keeps contention growing
                              // with concurrency without that absurd ceiling;
                              // PROVISÓRIO até timings reais em 32/128 vCPUs
                              // treinarem a correção (corrBackend é um escalar
                              // por MOTOR — não absorve erro de FORMA entre
                              // tamanhos de máquina).
const BACKEND_PAR_CAP = 8;    // fallback core count when /health is unreachable
// Per-slice scratch+accumulator bytes/cell in the backend (mirrors
// backend/src/main.rs: 17 scratch + 20 acc; round doubles scratch + 1 byte).
const BACKEND_BYTES_PER_CELL = 37;
const BACKEND_BYTES_PER_CELL_ROUND = 55;
// Cloud transfer-size estimate: assumed wire bandwidth (megabits/s) for the
// up/down byte counts → a rough wall-time guess. Nominal home/office values;
// the estimate is informational only (it never gates a run).
const UPLINK_MBPS   = 50;
const DOWNLINK_MBPS = 200;
// Network-graph ("follow the vectors") compute: a graph Dijkstra is ∝ EDGES,
// not raster cells — orders of magnitude cheaper than the grid, so the raster
// model massively over-estimates it. Nominal; corrGraph tunes per network.
const GRAPH_MS_PER_EDGE = 5e-5;
// Network IDW interpolation (separate phase; often DOMINATES when the compute
// is network-constrained or on the graph, since it fills the whole grid while
// the compute touches only network cells/edges). Nominal per-cell rates;
// corrInterp tunes. Fill scales with the ray search distance.
const INTERP_MS_PER_CELL = 5e-6;        // per cell per maxDist unit (banded)
const INTERP_SMOOTH_MS_PER_CELL = 5e-6; // per cell per 3×3 smoothing pass (banded)

// Graph edge count for the graph-mode estimate — the built graph if cached,
// else the network polyline segment count (≈ edges) before it's built.
function networkEdgeCount() {
  if (state.networkGraph && state.networkGraph.nEdges) return state.networkGraph.nEdges;
  if (state.networkLines && state.networkLines.length) {
    let v = 0;
    for (const ln of state.networkLines) v += Math.max(0, ln.length - 1);
    return Math.max(1, v);
  }
  return 0;
}

// Graph-mode compute: per-ref graph Dijkstra ∝ edges (round = both legs).
function predictGraphComputeMs(opts) {
  const dijk = opts.mode === "round" ? 2 : 1;
  const refs = opts.wantDensity ? (opts.refs || 1) : 1;
  return refs * Math.max(1, opts.netEdges) * GRAPH_MS_PER_EDGE * dijk;
}

// Network interpolation phase (0 when not interpolating). Graph-mode interp
// runs single-worker; raster-constrained interp is banded across the pool.
function predictInterpMs(opts) {
  if (!opts.interp || !(opts.N > 0)) return 0;
  const poolN = opts.graph ? 1 : interpPoolSize(opts.N, state.dem?.H || 1);
  const fill = INTERP_MS_PER_CELL * opts.N * Math.max(1, opts.interpMaxDist || 50);
  const smooth = INTERP_SMOOTH_MS_PER_CELL * opts.N * (opts.smoothIters || 0);
  // The IDW fill is banded across the pool; smoothing is a single post-merge
  // worker pass, so it is NOT divided by poolN (poolN=1 in graph mode → same).
  return fill / poolN + smooth;
}

function exploredCells(cal, N, eMax, alpha) {
  if (!(eMax > 0)) return N; // no budget → full grid
  // flat reach ∝ eMax/alpha; anchored at (bStar, Estar) from the probe.
  const ratio = (eMax * cal.alphaAtProbe) / (cal.bStar * alpha);
  return Math.min(N, cal.Estar * Math.pow(ratio, EXPLORE_EXP));
}

// Pre-flight compute-time prediction in ms (raw, before the network-interp
// term). Shared by the live estimate and the online-correction update so they
// can't drift. `applyCorr` multiplies in the learned per-engine factor.
// Move-directions cost multipliers vs the 8-move probe anchor (measured in
// docs/grid-sens.mjs / docs/grid-longedge.mjs on the SP DTM; 64/128
// extrapolated from edge-count scaling). Density runs amortize precomputed
// long-edge tables across their refs, so they use the cheaper lookup-search
// factors; single-source runs integrate on demand. The per-engine online
// correction (corrBrowser) absorbs the residual per-machine scale.
const DIRS_COST_SINGLE  = { 4: 0.7, 8: 1, 16: 2.4, 32: 5.8, 64: 15, 128: 38 };
const DIRS_COST_DENSITY = { 4: 0.7, 8: 1, 16: 1.5, 32: 2.7, 64: 8,  128: 18 };

export function predictComputeMs(cal, opts, applyCorr) {
  const { N, wantDensity, wantTopN, refs, eMax, mode, alpha, backend, graph } = opts;

  // "Follow the vectors": cost is ∝ graph edges, not raster cells (~1000× less
  // on a typical network/DEM). Using the raster model here is the severe
  // over-estimate users hit in graph mode.
  if (graph) {
    let ms = predictGraphComputeMs(opts);
    // Compare adds a full-DEM unconstrained RASTER scenario (single-point or
    // density pool) — add its cost via the raster model (graph off, browser).
    if (opts.graphCompare) ms += predictComputeMs(cal, { ...opts, graph: false, backend: false }, false);
    return applyCorr ? ms * (cal.corrGraph || 1) : ms;
  }

  const explored = exploredCells(cal, N, eMax, alpha);
  const dirsTable = wantDensity ? DIRS_COST_DENSITY : DIRS_COST_SINGLE;
  const dirsFactor = dirsTable[opts.nDirs || 8] || 1;
  const perRef = cal.perRefProbe * Math.pow(explored / cal.Estar, RATE_EXP) * dirsFactor;
  const dijk = mode === "round" ? 2 : 1;

  let ms, corr = 1;
  if (wantDensity) {
    if (backend) {
      // Native backend: per-ref speedup, parallel across refs but capped by
      // the server's MEMORY-bounded slice count (the dominant factor on huge
      // DEMs — each slice holds full-grid scratch, so 1-2 fit in RAM, not
      // cores-many) and slowed by shared-bandwidth contention between slices.
      // nDirs > 8 (backend ≥ 0.2.0): parent_long adds 1 B/cell per scratch
      // (37→38, 55→57 round), and the request-shared long-edge cost tables
      // ((nDirs−8) tables × 8 B/cell × revs) come off the budget ONCE before
      // the per-slice division — mirrors backend/src/main.rs's budget math.
      const nd = opts.nDirs || 8;
      const nLong = Math.max(0, nd - 8);
      const revs = mode === "round" ? 2 : 1;
      const perSlice = ((mode === "round" ? BACKEND_BYTES_PER_CELL_ROUND : BACKEND_BYTES_PER_CELL)
                        + (nLong ? revs : 0)) * N;
      const spec = backendSpecForEstimate();
      const memBudget = Math.max(1, (spec.memBudgetBytes || 8e9) - revs * nLong * 8 * N);
      const memCap = Math.max(1, Math.floor(memBudget / perSlice));
      const cores = spec.cores || BACKEND_PAR_CAP;
      const slices = Math.max(1, Math.min(refs || 1, cores, memCap));
      const contention = 1 + BW_CONTENTION * Math.sqrt(slices - 1);
      ms = (refs / slices) * (perRef / NATIVE_SPEEDUP) * contention * dijk;
      corr = cal.corrBackend || 1;
    } else {
      // Browser worker pool: per-ref work splits across poolN; each worker
      // pays its own alloc, overlapping in wall-clock (so allocMsN once).
      // opts.wasm (v80): the pool runs the wasm engine — its own pool size
      // (more memory per worker), per-ref speedup and learned correction.
      const nd = opts.nDirs || 8;
      const poolN = densityPoolSize({ N, K: refs, round: mode === "round", nDirs: nd, hasNet: !!opts.hasNet, engine: opts.wasm || null });
      const speedup = opts.wasm ? wasmSpeedup(true, nd) : 1;
      ms = cal.allocMsN + (refs / poolN) * (perRef / speedup) * dijk;
      corr = opts.wasm ? (cal.corrWasm || 1) : (cal.corrBrowser || 1);
    }
  } else if (backend && !wantTopN && !opts.maximize && !opts.wantPath) {
    // Native backend single-source (POST /single) — same dispatch gate as the
    // runner. No per-worker browser DEM alloc; native per-Dijkstra speedup.
    // corrBackend is trained by density backend runs (a reasonable proxy — the
    // online correction skips the fast single-point modes by design).
    ms = (perRef / NATIVE_SPEEDUP) * dijk;
    corr = cal.corrBackend || 1;
  } else {
    // Single-point modes (from/to/round) — one Dijkstra (two for round); the
    // plain field may run on the wasm engine (opts.wasm — never with top-N).
    ms = cal.allocMsN + perRef * dijk / (opts.wasm ? wasmSpeedup(false, opts.nDirs || 8) : 1);
    if (wantTopN) {
      const k = Math.max(1, Math.min(20, parseInt(document.getElementById("n-routes")?.value, 10) || 3));
      const rep = document.getElementById("repulsion-mode")?.value || "per-cell";
      const perIter = rep === "per-cell" ? 0.5 : 0.8;
      ms += perRef * perIter * k;
    }
    // corrWasm is trained by wasm density runs (the online correction skips
    // the fast single-point modes by design) — the same proxy the backend's
    // single-source arm uses with corrBackend.
    corr = opts.wasm ? (cal.corrWasm || 1) : (cal.corrBrowser || 1);
  }
  return applyCorr ? ms * corr : ms;
}

// Read the current run config from the DOM (used by both the estimate and the
// post-compute correction, so they describe the same run).
export function currentRunOpts(cal, N) {
  const mode = document.getElementById("mode")?.value || "from";
  // The v2 analogue of v1's α for the reach model (flat reach ∝ eMax/alpha).
  const alpha = costAlphaEquiv(readCost()) || cal.alphaAtProbe;
  const eMaxRaw = parseFloat(document.getElementById("e-max")?.value);
  const graph = graphModeActive();
  // Interp runs when its toggle is on AND there's a network to fill around —
  // either a raster constraint or graph mode (graph energy is IDW-filled too).
  const interp = !!document.getElementById("net-interp")?.checked
    && (networkConstraintActive() || graph);
  const opts = {
    N,
    wantDensity: !!document.getElementById("want-density")?.checked,
    wantTopN: !!document.getElementById("want-topn")?.checked,
    // maximize / a destination path keep single-source runs in the browser (the
    // backend produces no routes) — the predictor gates the backend arm on these.
    maximize: !!document.getElementById("maximize")?.checked,
    wantPath: !!state.dst,
    refs: state.refPoints?.length || 0,
    // Mirror the runner: the kJ budget is ignored under maximize (inverted
    // costs), so the reach model must assume full grid there too.
    eMax: !document.getElementById("maximize")?.checked && Number.isFinite(eMaxRaw) && eMaxRaw > 0 ? eMaxRaw : 0,
    mode, alpha,
    // nDirs ≠ 8 always computes in-browser (the backend serves the classic
    // 8-move engine only) — the predictor must mirror the runner's gate.
    nDirs: (() => { const v = parseInt(document.getElementById("n-dirs")?.value, 10); return [4, 8, 16, 32, 64, 128].includes(v) ? v : 8; })(),
    // nDirs ≠ 8 runs on the backend when it's ≥ 0.2.0; cloud assumes the
    // deployed binary is current (we control it), localhost asks the probe.
    backend: computeMode() !== "browser" && (() => {
      const nd = parseInt(document.getElementById("n-dirs")?.value, 10) || 8;
      return nd === 8 || computeMode() === "cloud" || backendServesNDirs();
    })(),
    graph,
    // Graph-mode compare also runs a full-DEM unconstrained raster scenario.
    graphCompare: graph && !!document.getElementById("vec-compare")?.checked,
    netEdges: graph ? networkEdgeCount() : 0,
    interp,
    interpMaxDist: Math.max(1, parseInt(document.getElementById("net-interp-max-dist")?.value, 10) || 50),
    smoothIters: Math.max(0, parseInt(document.getElementById("net-interp-smoothing")?.value, 10) || 0),
  };
  // Engine the in-browser path will use (v80) — the runner makes the SAME
  // call (densityEngine / singleEngine) at dispatch, then re-tags lastRun.wasm
  // with what actually ran (noteRunEngine). Backend and graph runs: no wasm.
  opts.hasNet = networkConstraintActive();
  const compare = opts.hasNet && !!document.getElementById("vec-compare")?.checked;
  opts.wasm = (opts.backend || graph) ? null
    : opts.wantDensity
      ? densityEngine({ N, K: opts.refs, round: mode === "round", nDirs: opts.nDirs, hasNet: opts.hasNet })
      : singleEngine({ N, mode, nDirs: opts.nDirs, hasNet: opts.hasNet, wantTopN: opts.wantTopN,
                       maximize: opts.maximize, wantPath: opts.wantPath, graph, compare });
  return opts;
}

export function estimateRunTime() {
  // Cloud transfer-size estimate (always reconciled — even before a DEM/probe).
  updateCloudTransferEstimate();

  const out = document.getElementById("time-estimate");
  if (!out) return;
  if (!state.dem) { out.textContent = ""; return; }

  const cal = state.calibration;
  if (!cal) {
    // Probe errored → no anchor for a number; stay blank instead of showing
    // "estimating…" forever (computeDone retries the probe after each run).
    out.textContent = state.calibrationFailed ? "" : t("estimate.calibrating");
    return;
  }

  const N = state.dem.H * state.dem.W;
  const opts = currentRunOpts(cal, N);
  // Two phases, separately corrected: compute (raster/backend/graph) + the
  // network interpolation fill (frequently the larger of the two).
  let ms = predictComputeMs(cal, opts, true);
  ms += predictInterpMs(opts) * (cal.corrInterp || 1);
  out.textContent = `≈ ${formatDuration(ms)}`;
}

// Cloud-only: estimate the bytes shipped to/from the orchestrator for the
// current run config and render them (+ a wire-time guess) into #cloud-transfer.
// Pulls the same inputs estimateRunTime uses. Cleared when not in cloud mode or
// when there's no DEM to size against.
function updateCloudTransferEstimate() {
  const line = document.getElementById("cloud-transfer");
  if (!line) return;
  if (computeMode() !== "cloud" || !state.dem) { line.textContent = ""; return; }

  const N = state.dem.H * state.dem.W;
  const mode = document.getElementById("mode")?.value || "from";
  const wantDensity = !!document.getElementById("want-density")?.checked;
  const hasNetwork  = networkConstraintActive();
  const nPortals    = buildPortals()?.n || 0;

  // Upload: gridHeight (f32 → 4·N) + gridMask (u8 → N) + optional networkMask
  // (u8 → N) + the bridge portal arrays (~32 B/portal: 2×i32 + 3×f64). The JSON
  // header is negligible against the grid.
  const up = 4 * N + N + (hasNetwork ? N : 0) + nPortals * 32;
  // Download: density returns f64 density (8·N) + f32 energy (4·N); single
  // returns f32 energy (4·N) + f64 passes (8·N — always on since v68; the
  // /single wire ships passes as f64 to match the JS worker's Float64Array).
  const down = wantDensity ? (8 * N + 4 * N) : (4 * N + 8 * N);
  // Rough wire time at the assumed link speeds (bytes·8 / (Mbps·1e6)).
  const wireMs = (up * 8 / (UPLINK_MBPS * 1e6) + down * 8 / (DOWNLINK_MBPS * 1e6)) * 1000;
  line.textContent = t("cloud.transfer", formatBytes(up), formatBytes(down), formatDuration(wireMs));
}

// Online correction: after a run finishes, nudge the per-PHASE correction
// toward actual/predicted so subsequent estimates converge to this machine's
// reality (EMA, clamped). The compute phase keys by engine (browser/backend/
// graph); the interp phase has its own factor — keeping them separate stops
// a slow interp from inflating the compute correction (and vice-versa).
export function updateEstimateCorrection(computeMs, interpMs) {
  const cal = state.calibration, lr = state.lastRun;
  if (!cal || !lr) return;
  const nudge = (key, actual, predicted) => {
    if (!(actual > 0) || !(predicted > 0)) return;
    const ratio = Math.min(5, Math.max(0.2, actual / predicted));
    cal[key] = Math.min(5, Math.max(0.2, 0.5 * (cal[key] || 1) + 0.5 * ratio));
  };
  // Correct the compute phase only for the perf-critical paths (density and
  // graph), not the fast single-point modes — they share corrBrowser but have
  // a different cost shape, so learning from them would muddy the density one.
  // A run that fell back mid-way (wasm → JS) timed a mix of engines: skip it.
  if (computeMs > 0 && (lr.wantDensity || lr.graph) && !lr.skipCorrection) {
    const key = lr.graph ? "corrGraph" : (lr.backend ? "corrBackend" : (lr.wasm ? "corrWasm" : "corrBrowser"));
    nudge(key, computeMs, predictComputeMs(cal, lr, false));
  }
  if (interpMs > 0 && lr.interp) {
    nudge("corrInterp", interpMs, predictInterpMs(lr));
  }
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms)) return "—";
  if (ms < 950) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms / 1000)} s`;
}

// Binary-unit byte formatter for the cloud transfer estimate (KiB/MiB/GiB).
function formatBytes(b) {
  if (!Number.isFinite(b) || b < 0) return "—";
  if (b < 1024) return `${Math.round(b)} B`;
  const u = ["KiB", "MiB", "GiB", "TiB"];
  let v = b / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

export function formatEnergy(v) {
  if (!Number.isFinite(v) || v === 0) return "0";
  const a = Math.abs(v);
  // Plain decimal, never scientific — energy reads as e.g. "3357", not "3.3e+3".
  // Large values stay whole; smaller ones keep 1–2 decimals for precision.
  if (a >= 100) return v.toFixed(0);
  if (a >= 10)  return v.toFixed(1);
  return v.toFixed(2);
}

// Always-scientific formatter — passes/density bounds span many orders of
// magnitude (≈1e-9…1e-3), so fixed notation is unreadable; show e.g. "3.8e-9".
export function formatSci(v) {
  if (!Number.isFinite(v) || v === 0) return "0";
  return v.toExponential(1);
}

// ------- DEM metadata formatters -------
export function formatCellSize(dx, dy, originY, H, isGeographic) {
  if (isGeographic) {
    const latRef = originY - (H * dy) / 2;
    const dxM = dx * 111320 * Math.cos((latRef * Math.PI) / 180);
    const dyM = dy * 110574;
    return `<span class="v">${dxM.toFixed(1)} × ${dyM.toFixed(1)} m</span> <span style="opacity:0.6">(${dx.toExponential(2)}° × ${dy.toExponential(2)}°)</span>`;
  }
  return `<span class="v">${dx.toFixed(1)} × ${dy.toFixed(1)} m</span>`;
}

export function formatCoverage(W, H, dx, dy, originY, isGeographic) {
  let xKm, yKm;
  if (isGeographic) {
    const latRef = originY - (H * dy) / 2;
    xKm = (W * dx * 111320 * Math.cos((latRef * Math.PI) / 180)) / 1000;
    yKm = (H * dy * 110574) / 1000;
  } else {
    xKm = (W * dx) / 1000;
    yKm = (H * dy) / 1000;
  }
  return t("dem.meta_coverage", `<span class="v">${xKm.toFixed(2)} × ${yKm.toFixed(2)} km</span>`);
}
