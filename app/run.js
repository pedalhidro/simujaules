// The Run button: builds the compute message, dispatches to workers / wasm /
// backend, merges density pools — and renderResult().
import "./points.js"; // evaluation order — see ../app.js
import { buildRunMessage, densitySliceMessage } from "../lib/run-message.js";
import { t, workerWarningText } from "./i18n.js";
import { readCost, setGroupOpen, syncLoadedHighlights } from "./panel.js";
import { WASM_WORKER_URL, WORKER_URL } from "./boot.js";
import { escapeHtml, state } from "./state.js";
import {
  cancelActiveCompute, cloudComputeHeaders, cloudNoFallback, cloudToken, computeDataUrl,
  computeMode, effectiveBackendUrl,
} from "./compute-source.js";
import { progress, progressBar, resultMeta, runBtn, status } from "./dom.js";
import { networkConstraintActive, pixelToLatLng, snapToNetwork } from "./network-view.js";
import {
  computeNetworkGraphToken, graphJunctionMode, graphModeActive, networkLinesToCellLines,
  rasterizeGraphEnergy, removeGraphLayers, renderGraphOverlay,
} from "./graph-mode.js";
import { scheduleStatusClear, updateRunButtonState } from "./points.js";
import { installKpiResult } from "./kpi.js";
import { rerenderCachedResult } from "./render.js";
import {
  backendServesNDirs, densityEngine, densityPoolSize, interpPoolSize, loadWasmEngine,
  memBudgetBytes, singleEngine,
} from "./engines.js";
import {
  ensureCloudVm, setCloudHint, startCloudKeepalive, stopCloudKeepalive, stopCloudVm,
} from "./cloud.js";
import {
  currentRunOpts, estimateRunTime, formatDuration, predictComputeMs, startCalibrationProbe,
  updateEstimateCorrection,
} from "./estimate.js";
import { buildComputeGrid, buildPortals, stampBridgeDeckPasses } from "./grid.js";

// ------- Run -------
runBtn.addEventListener("click", async () => {
  const wantDensity = !!document.getElementById("want-density")?.checked;
  // Density mode runs from refPoints, not src — relax the src-required guard.
  if (!state.dem) return;
  if (!wantDensity && !state.src) return;
  if (wantDensity && (!state.refPoints || state.refPoints.length === 0)) {
    status.innerHTML = `<span style="color:#ff6b6b">${t("status.density_needs_ref")}</span>`;
    return;
  }
  // Mobile: close the drawer so the user sees the result land on the map
  // instead of staring at the parameter panel while the compute runs.
  // No-op on desktop (drawer never opens above 860 px).
  window.__simuDrawer?.close();

  const mode = document.getElementById("mode").value;
  // The v2 cost bundle derived from the physics inputs (readCost clamps each to a
  // sane range, so edge weights stay non-negative and the time estimate finite).
  const cost = readCost();
  const eMaxRaw = parseFloat(document.getElementById("e-max")?.value);
  let eMax = Number.isFinite(eMaxRaw) && eMaxRaw > 0 ? eMaxRaw : 0;
  // Round mode only: budget caps each leg ("leg", default — totals reach
  // 2·eMax) or the round-trip sum ("total").
  const eMaxMode = document.getElementById("e-max-mode")?.value || "leg";

  // Optional extras. Passes are ALWAYS computed since v68 (the "contagem de
  // passagens" checkbox was dropped — behaviour is identical to it being
  // permanently checked); the density branch ignores the flag as before.
  const wantPasses = true;
  const wantTopN   = !!document.getElementById("want-topn")?.checked;
  const nRoutes    = Math.max(1, Math.min(20, parseInt(document.getElementById("n-routes")?.value, 10) || 3));
  const penalty    = Math.max(0, parseFloat(document.getElementById("penalty")?.value) || 2.0);
  const repulsionMode = document.getElementById("repulsion-mode")?.value || "per-cell";
  // Reverse-optimization: flip the cost function so Dijkstra finds the
  // most expensive (under the original metric) routes rather than the
  // cheapest. The worker does the inversion against a precomputed
  // MAX_EDGE_COST = α·diagonal + β·(maxH − minH).
  // maximizeLength > 0 activates a length-constrained layered-DP path
  // search instead of the inverted Dijkstra. Memory-bounded; the worker
  // refuses if L·H·W exceeds the cap.
  const maximize       = !!document.getElementById("maximize")?.checked;
  const maximizeLength = Math.max(0, parseInt(document.getElementById("maximize-length")?.value, 10) || 0);
  // The budget is in REAL kJ, but under maximize every edge cost is INVERTED
  // against MAX_EDGE_COST (hundreds of kJ per edge) — a realistic budget
  // would prune the whole field to empty. The budget does not apply; forcing
  // 0 here covers every payload built below (baseMsg, backend, graph).
  if (maximize) eMax = 0;
  // Density follows the global Mode select instead of having its own
  // direction toggle.
  const densityMode  = mode;
  // Move directions (grid neighborhood, docs/grid-connectivity-sensitivity):
  // 8 = the classic engine and the ONLY value the native backend serves —
  // any other value computes in-browser (gated below, like top-N/maximize).
  // The worker forces 8 under maximize regardless (inversion degeneracy).
  const nDirsRaw = parseInt(document.getElementById("n-dirs")?.value, 10);
  const nDirs = [4, 8, 16, 32, 64, 128].includes(nDirsRaw) ? nDirsRaw : 8;
  // String pulling: post-hoc shortcutting of the displayed route(s).
  const stringPull = !!document.getElementById("string-pull")?.checked;

  if (wantTopN && !state.dst) {
    status.innerHTML = `<span style="color:#ff6b6b">${t("status.topn_needs_dst")}</span>`;
    return;
  }

  // Whether the loaded network constrains THIS run (checkbox can disable
  // the constraint while keeping the network loaded for rendering).
  const constrainNet = networkConstraintActive();

  // If a constraining network is loaded, src/dst must lie on it — otherwise
  // the Dijkstra is constrained to network cells and can't relax through
  // them. Re-snap here defensively: covers the case where the user clicked
  // points BEFORE loading the .gpkg, and the case where snap-radius was 0
  // at click time. If a point can't be snapped (no network cell within
  // radius) we abort with a clear message rather than silently producing
  // empty routes.
  if (constrainNet && state.dem) {
    const W = state.dem.W;
    const offNet = (rc) => rc && !state.networkMask[rc[0] * W + rc[1]];
    const reSnapAndUpdate = (rc, marker, displayId, label) => {
      if (!rc || !offNet(rc)) return rc;
      const snapped = snapToNetwork(rc);
      if (offNet(snapped)) {
        // Snap is grid-wide now — this means the network has no usable
        // cells at all on this DEM.
        status.innerHTML = `<span style="color:#ff6b6b">${t("status.snap_failed_label", escapeHtml(label))}</span>`;
        return null;
      }
      // Move the marker so the user sees where compute actually started.
      const { originX, originY, dx, dy } = state.dem;
      const latlng = L.latLng(originY - (snapped[0] + 0.5) * dy, originX + (snapped[1] + 0.5) * dx);
      if (marker) marker.setLatLng(latlng);
      const disp = document.getElementById(displayId);
      if (disp) {
        disp.textContent = `r=${snapped[0]}, c=${snapped[1]}`;
        disp.classList.add("set");
      }
      return snapped;
    };
    // Gate each point on its existence: state.src is ALWAYS null in
    // density mode, and the old unconditional call returned that null
    // through `if (newSrc === null) return;` — silently aborting every
    // density compute whenever a constraining network was loaded.
    if (state.src) {
      const newSrc = reSnapAndUpdate(state.src, state.srcMarker, "src-display", t("marker.src"));
      if (newSrc === null) return;
      state.src = newSrc;
    }
    if (state.dst) {
      const newDst = reSnapAndUpdate(state.dst, state.dstMarker, "dst-display", t("marker.dst"));
      if (newDst === null) return;
      state.dst = newDst;
    }
    // Density refs get the same defensive re-snap: refs placed before the
    // network loaded (or via random placement over the whole DEM) may sit
    // off-network; their per-ref Dijkstras would start from isolated
    // seeds. Markers follow their snapped cells.
    if (wantDensity && state.refPoints?.length) {
      for (let i = 0; i < state.refPoints.length; i++) {
        const rc = state.refPoints[i];
        if (!offNet(rc)) continue;
        const snapped = snapToNetwork(rc);
        if (offNet(snapped)) {
          status.innerHTML = `<span style="color:#ff6b6b">${t("status.refs_no_snap")}</span>`;
          return;
        }
        state.refPoints[i] = snapped;
        const m = state.refMarkers[i];
        if (m) {
          const ll = pixelToLatLng(snapped[0], snapped[1]);
          if (ll) m.setLatLng(ll);
          m.unbindTooltip().bindTooltip(`ref ${i + 1} · r=${snapped[0]}, c=${snapped[1]}`);
        }
      }
    }
  }

  // Cancel any in-flight run, then capture this run's generation. Every
  // worker callback below checks it — a mismatch means the run was
  // superseded (new Compute click, new DEM/network) and the message is
  // dropped instead of rendered against the wrong grid.
  cancelActiveCompute();
  const gen = state.computeGen;

  status.textContent = t("status.computing");
  progress.classList.add("active");
  progressBar.style.width = "0%";
  runBtn.disabled = true;

  // ETA bookkeeping. The worker emits progress every ~N/50 cells, which
  // gives a usable ETA after the first few percent.
  state.computeStartedAt = performance.now();
  state.estimatedTotalMs = 0;
  syncLoadedHighlights(); // 3C → running (orange)
  // Cache density's expected ref count so the progress text reads
  // "ref X/N" while the workers are iterating.
  state.computeRefTotal = wantDensity ? state.refPoints.length : 0;

  const { H, W } = state.dem;
  const N = H * W;
  // Snapshot the run config now (engine/refs/budget/mode) so computeDone can
  // online-correct the estimate against the real elapsed time.
  if (state.calibration) state.lastRun = currentRunOpts(state.calibration, N);
  state.lastRunPredictedMs = state.lastRun ? predictComputeMs(state.calibration, state.lastRun, true) : 0;
  state.lastRunEngine = null;
  const wantNetworkInterp = !!document.getElementById("net-interp")?.checked;
  const interpMaxDistance = Math.max(1, parseInt(document.getElementById("net-interp-max-dist")?.value, 10) || 50);
  const interpSmoothing   = Math.max(0, parseInt(document.getElementById("net-interp-smoothing")?.value, 10) || 0);

  const computeFailed = (message) => {
    if (gen !== state.computeGen) return;
    cancelActiveCompute();
    // Falha de cálculo na nuvem: para a VM agora em vez de deixá-la ligada até o
    // watchdog de ócio da VM desligar sozinho (cancelActiveCompute só corta o
    // keepalive local — que é só uma flag, não há lease no orquestrador).
    // computeDone faz o mesmo no sucesso; stopCloudVm é idempotente.
    if (state.cloud.mode === "cloud" && state.cloud.orchestratorUrl) {
      stopCloudVm(state.cloud.orchestratorUrl);
    }
    status.innerHTML = `<span style="color:#ff6b6b">${t("status.worker_error", escapeHtml(message))}</span>`;
  };

  const computeDone = (m) => {
    if (gen !== state.computeGen) return;
    // Terminate now rather than waiting for the next run — finished
    // workers pin their DEM copy + Dijkstra buffers otherwise.
    for (const w of state.workers) w.terminate();
    state.workers = [];
    progress.classList.remove("active");
    updateRunButtonState();
    state.computeStartedAt = 0;
    stampBridgeDeckPasses(m.passes); // deck cells carry the bridge flow (portals skip them)
    // Snapshot the run's OWN mode — the #mode select isn't disabled mid-run,
    // so reading it live in renderResult would mislabel a result if the user
    // changed it while this compute was in flight (see the round_note gate).
    m.runMode = mode;
    renderResult(m);
    status.textContent = t("status.done_ms", m.elapsedMs.toFixed(0)) +
      (state.lastRunEngine ? t("status.engine_wasm") : "");
    scheduleStatusClear(status.textContent);
    setGroupOpen("result-group", true); // compute done → reveal results
    syncLoadedHighlights();              // 3C → done (green), 4 → ready (orange)
    // Learn from this run: nudge the estimate toward reality (single runs
    // only — compare runs carry energyAlt and time ~2 scenarios). Compute and
    // interp phases are corrected separately (m.computeMs/m.interpMs when the
    // density path split them; else the whole run is compute). Then refresh
    // the pre-flight number so the correction is visible immediately.
    if (!m.energyAlt) {
      updateEstimateCorrection(m.computeMs ?? m.elapsedMs, m.interpMs ?? 0);
      estimateRunTime();
    }
    // The calibration probe is skipped while a compute runs — if this DEM
    // still has no calibration, run it now that the cores are free.
    if (!state.calibration) startCalibrationProbe();
    // Cloud: stop the VM after each run (default-ON) so it doesn't bill idle.
    // With "keep warm" ticked, leave the VM up to reuse on the next run — just
    // drop the keepalive (a client-side in-flight flag; /cloud/keepalive is a
    // no-op on the orchestrator) so the in-VM idle-watchdog reaps it after ~15
    // min idle (the keepalive is also cleared inside stopCloudVm).
    if (state.cloud.mode === "cloud" && state.cloud.orchestratorUrl) {
      if (document.getElementById("cloud-keep-warm")?.checked) {
        stopCloudKeepalive();
        setCloudHint("cloud.warm");
      } else {
        stopCloudVm(state.cloud.orchestratorUrl);
      }
    }
  };

  const reportProgress = (frac) => {
    if (gen !== state.computeGen) return;
    const pct = Math.min(100, frac * 100);
    progressBar.style.width = `${pct.toFixed(1)}%`;
    // Live ETA: linear extrapolation. Skip the noisy first 5% of the run.
    if (frac > 0.05) {
      const elapsed = performance.now() - state.computeStartedAt;
      const total = elapsed / frac;
      const remaining = Math.max(0, total - elapsed);
      let label;
      if (state.computeRefTotal > 0) {
        const cur = Math.max(1, Math.min(state.computeRefTotal, Math.ceil(frac * state.computeRefTotal)));
        label = t("status.density_progress", cur, state.computeRefTotal, pct.toFixed(0));
      } else {
        label = t("status.computing_pct", pct.toFixed(0));
      }
      status.textContent = t("status.time_left", label, formatDuration(remaining));
    }
  };

  // A worker-load failure (404, parse error) or an exception outside the
  // worker's own try/catch surfaces as an `error` event, not a message —
  // without these handlers the UI used to stay stuck on "Computing…".
  const spawnWorker = (onMessage, url = WORKER_URL) => {
    const w = new Worker(url);
    w.onmessage = (ev) => { if (gen === state.computeGen) onMessage(ev.data); };
    w.onerror = (e) => computeFailed(e.message || "worker failed to load or crashed");
    w.onmessageerror = () => computeFailed("worker message could not be deserialised");
    state.workers.push(w);
    return w;
  };

  // ---- WebAssembly engine bookkeeping (v80) ---------------------------------
  // Record the engine a grid job actually runs on (a module that failed to
  // load falls back to JS), so the done status and the online correction
  // (corrWasm vs corrBrowser) describe the real run, not the estimate's guess.
  const noteRunEngine = (engine) => {
    state.lastRunEngine = engine;
    if (state.lastRun) state.lastRun.wasm = engine;
  };
  // wasm-worker.js reran a job on the JS engine. An instantiate failure
  // disables that module for the session; a trap/rejection (e.g. out of
  // memory on this DEM) only affects this job. The run's timing is now a
  // wasm/JS mix — keep it out of the online correction.
  const noteEngineFallback = (m) => {
    console.warn(`[wasm] ${m.engine} fell back to the JS engine (${m.stage}):`, m.reason);
    if (m.stage === "instantiate") state.wasm.failed[m.engine] = m.reason;
    state.lastRunEngine = null;
    if (state.lastRun) state.lastRun.skipCorrection = true;
  };
  // A wasm job is one call into the module — no progress events. Animate the
  // bar against the run's predicted time instead (capped below 100 % until the
  // result lands). Returns the stop function.
  const wasmTicker = (onFrac) => {
    const predicted = state.lastRunPredictedMs;
    if (!(predicted > 0)) return () => {};
    const t0 = performance.now();
    const id = setInterval(() => {
      if (gen !== state.computeGen) { clearInterval(id); return; }
      onFrac(Math.min(0.95, (performance.now() - t0) / predicted));
    }, 250);
    return () => clearInterval(id);
  };

  // Per-worker DEM clones — buffers are transferred, so each worker needs
  // its own copy. The pool sizing below accounts for this memory.
  const demPayload = () => {
    // buildComputeGrid composes the impassable mask + bridge corridors into the
    // height/mask; networkMask stays the separate constraint slot the worker ANDs.
    const { height, mask, transfer } = buildComputeGrid();
    const networkMask = constrainNet ? new Uint8Array(state.networkMask) : null;
    if (networkMask) transfer.push(networkMask.buffer);
    return { height, mask, networkMask, transfer };
  };

  // ---- Accessibility KPI inputs (density only) -----------------------------
  // The density engines sample each ref's energy field at every ref cell,
  // returning the pairwise K×K matrix the KPI block evaluates. Suppressed
  // under maximize (inverted costs) and graph mode (raster refs only).
  const wantMatrix = wantDensity && !maximize && !graphModeActive();
  const matrixCells = wantMatrix
    ? Int32Array.from(state.refPoints, ([r, c]) => r * W + c)
    : null;
  // Snapshot the refs (+ lat/lng for the CSV export) and the census
  // population proxy NOW — the user can edit refs while the run is in
  // flight, and the matrix rows are keyed to the refs it ran with.
  const kpiSnapshot = wantMatrix ? {
    refs: state.refPoints.map(([r, c]) => {
      const ll = pixelToLatLng(r, c);
      return { r, c, lat: ll ? ll.lat : null, lng: ll ? ll.lng : null };
    }),
    popM: state.refPopM,
    eMax, eMaxMode, mode: densityMode,
  } : null;

  const portals = buildPortals();
  // The engine's run message is built by lib/run-message.js — the same builder
  // the MCP server and the census harness call, so a new field cannot reach
  // one sender and not the others (the worker silently defaults missing keys).
  const baseMsg = buildRunMessage({
    H, W,
    dxM: state.dem.dxM,
    dyM: state.dem.dyM,
    seed: state.src || state.refPoints[0] || null,
    goal: state.dst || null,
    mode, cost, eMax, eMaxMode,
    wantPasses, wantTopN, nRoutes, penalty, repulsionMode,
    wantDensity,
    refPoints: wantDensity ? state.refPoints.slice() : null,
    densityMode,
    wantNetworkInterp,
    interpMaxDistance,
    interpSmoothing,
    nDirs,
    stringPull,
    // Bridge portal edges (hybrid raster overlay). Small arrays — spread into
    // every worker message via baseMsg (structured-cloned, NOT transferred, so
    // the shared arrays survive across the density pool's workers). The native
    // backend path appends them to its Blob separately.
    portals: portals || null,
  });

  // Shared tail for the density paths (pool and native backend): optional
  // IDW fill as a follow-up worker task (the fill helpers live in the
  // worker; per-slice filling would be wrong), then computeDone.
  // ---- Pooled network interpolation -----------------------------------------
  // The IDW fill is embarrassingly parallel by rows: split the grid into
  // bands across the worker pool (each band worker gets the FULL inputs —
  // rays read past band edges — so memory is ~6 bytes/cell per worker,
  // capped). Smoothing can't be banded (it would seam at band edges), so
  // it runs as one cheap full-grid pass after the merge. Resolves with the
  // filled field; failures go through computeFailed (promise stays pending,
  // the generation bump kills the chain).
  const runInterp = (energy) => new Promise((resolve) => {
    status.textContent = t("status.interpolating_net");
    progressBar.style.width = "0%";
    const interpPayload = () => ({
      // Effective mask (impassable blocked, corridors open) so IDW energy never
      // bleeds across water; networkMask stays the fill seed.
      mask: buildComputeGrid({ maskOnly: true }).mask,
      networkMask: new Uint8Array(state.networkMask),
    });
    const smoothThenResolve = (filled) => {
      if (!(interpSmoothing > 0)) { resolve(filled); return; }
      const { mask, networkMask } = interpPayload();
      const w = spawnWorker((m) => {
        if (m.kind === "smooth-done") resolve(m.energy);
        else if (m.kind === "error") computeFailed(m.message);
      });
      w.postMessage(
        { kind: "smooth", energy: filled, networkMask, mask, H, W, iters: interpSmoothing },
        [filled.buffer, mask.buffer, networkMask.buffer],
      );
    };
    // Pool sizing lives in interpPoolSize — shared with the time estimate
    // (predictInterpMs) so runner and estimator can never drift.
    const P = interpPoolSize(N, H);
    if (P <= 1) {
      // Single worker — smoothing handled worker-side in the same job.
      const { mask, networkMask } = interpPayload();
      const w = spawnWorker((m) => {
        if (m.kind === "progress") {
          progressBar.style.width = `${Math.min(100, m.progress * 100).toFixed(1)}%`;
        } else if (m.kind === "interp-done") resolve(m.energy);
        else if (m.kind === "error") computeFailed(m.message);
      });
      w.postMessage(
        {
          kind: "interp", energy, networkMask, mask, H, W,
          dx: state.dem.dxM, dy: state.dem.dyM,
          interpMaxDistance, interpSmoothing,
        },
        [energy.buffer, mask.buffer, networkMask.buffer],
      );
      return;
    }
    const merged = new Float32Array(N);
    const frac = new Float64Array(P);
    let remaining = P;
    for (let p = 0; p < P; p++) {
      const r0 = Math.floor(p * H / P);
      const r1 = Math.floor((p + 1) * H / P);
      const slot = p;
      const w = spawnWorker((m) => {
        if (m.kind === "progress") {
          frac[slot] = m.progress;
          let acc = 0;
          for (let i = 0; i < P; i++) acc += frac[i];
          progressBar.style.width = `${Math.min(100, (acc / P) * 100).toFixed(1)}%`;
        } else if (m.kind === "interp-done") {
          merged.set(m.energy, m.rowStart * W);
          frac[slot] = 1;
          if (--remaining === 0) smoothThenResolve(merged);
        } else if (m.kind === "error") computeFailed(m.message);
      });
      const eCopy = new Float32Array(energy);
      const { mask, networkMask } = interpPayload();
      w.postMessage(
        {
          kind: "interp", energy: eCopy, networkMask, mask, H, W,
          dx: state.dem.dxM, dy: state.dem.dyM,
          interpMaxDistance, rowStart: r0, rowEnd: r1,
        },
        [eCopy.buffer, mask.buffer, networkMask.buffer],
      );
    }
  });

  const finishDensityOutputs = (energy, density, alt, src) => {
    // Split the two phases so the online correction learns them independently
    // (interp often dominates a network-constrained run).
    const computeMs = performance.now() - state.computeStartedAt;
    const finalize = (energyOut, interpMs) => computeDone({
      energy: energyOut, passes: density,
      path: null, pathEnergy: null, pathLengthM: null, routes: null,
      elapsedMs: performance.now() - state.computeStartedAt,
      computeMs, interpMs: interpMs || 0,
      energyAlt: alt?.energyAlt || null,
      passesAlt: alt?.passesAlt || null,
      // Accessibility matrix + the refs/population snapshot it was run with.
      matrix: src?.matrix || null,
      matrixOutdated: !!src?.matrixOutdated,
      kpi: kpiSnapshot,
    });
    if (wantNetworkInterp && constrainNet) {
      const t = performance.now();
      runInterp(energy).then((e) => finalize(e, performance.now() - t));
    } else finalize(energy, 0);
  };

  // ---- Density worker pool -------------------------------------------------
  // Each reference point's Dijkstra is independent, so density runs split
  // the refs across min(cores − 1, K, memory-cap) workers — near-linear
  // wall-clock speedup. Workers return raw accumulators (densityPartial);
  // the merge + final normalisation happens here.
  //
  // Memory cap: each worker's resident set is the DEM copy (height f32 4 +
  // mask u8 1 = 5 B/cell) + densityField scratch (E4 + settled1 + parents4 +
  // order4 + passes-f32 4 = 17) + outputs (density-f32 4 + energySum-f64 8 +
  // energyCount 4 = 16) ≈ 38 B/cell, and ~55 in round mode (a second
  // search resident). Budget it against navigator.deviceMemory (GB, which
  // the spec CAPS at 8 — it's a floor on true RAM, never the full amount),
  // taking a conservative fraction to leave room for the browser, the
  // main-thread DEM, and the OS. On huge DEMs this still yields 1 worker
  // (the honest ceiling: two won't fit), exactly the old behaviour.
  const K = wantDensity ? state.refPoints.length : 0;

  // Run one full density field over the worker pool and resolve with the
  // raw outputs (no interp, no UI finalisation — the callers compose those).
  // useNetwork toggles the network constraint per scenario, which is what
  // the constrained-vs-unconstrained comparison varies. Progress maps into
  // [progressBase, progressBase + progressScale].
  // Engine per scenario (v80): the wasm engine when densityEngine picks it and
  // its module loads — otherwise the JS worker; the pool is sized for the
  // engine it actually runs (densityPoolSize, shared with the estimate).
  const computeDensityField = async ({ useNetwork, progressBase = 0, progressScale = 1, wantMatrix: sliceMatrix = false }) => {
    const round = densityMode === "round";
    let engine = densityEngine({ N, K, round, nDirs, hasNet: useNetwork });
    const wasmSpec = engine ? await loadWasmEngine(engine) : null;
    if (gen !== state.computeGen) return new Promise(() => {});
    if (!wasmSpec) engine = null;
    noteRunEngine(engine);
    const poolN = densityPoolSize({ N, K, round, nDirs, hasNet: useNetwork, engine });
    return new Promise((resolve) => {
      const density = new Float64Array(N);
      const energySum = new Float64Array(N);
      const energyCount = new Int32Array(N);
      // Pairwise accessibility matrix, assembled from each slice's rows at
      // its ref offset (rows are disjoint — merge order is irrelevant,
      // unlike the f64 accumulators above).
      const matrix = (sliceMatrix && matrixCells) ? new Float32Array(K * K).fill(Infinity) : null;
      const workerFrac = new Float64Array(poolN);
      const sliceLen = new Float64Array(poolN);
      let remaining = poolN;

      const poolProgress = () => {
        let acc = 0;
        for (let i = 0; i < poolN; i++) acc += workerFrac[i] * sliceLen[i];
        reportProgress(progressBase + progressScale * (acc / K));
      };
      // wasm slices post no progress — animate the unfinished ones against
      // the predicted time (stopped on completion, failure or a JS fallback,
      // whose own progress events then take over).
      const stopTicker = engine ? wasmTicker((frac) => {
        for (let i = 0; i < poolN; i++) if (workerFrac[i] < 1) workerFrac[i] = frac;
        poolProgress();
      }) : () => {};

      for (let p = 0; p < poolN; p++) {
        const lo = Math.floor(p * K / poolN);
        const hi = Math.floor((p + 1) * K / poolN);
        sliceLen[p] = hi - lo;
        const slot = p;
        const w = spawnWorker((m) => {
          if (m.kind === "progress") {
            workerFrac[slot] = m.progress;
            poolProgress();
          } else if (m.kind === "done") {
            for (let i = 0; i < N; i++) density[i] += m.density[i];
            for (let i = 0; i < N; i++) energySum[i] += m.energySum[i];
            for (let i = 0; i < N; i++) energyCount[i] += m.energyCount[i];
            if (matrix && m.matrix) matrix.set(m.matrix, lo * K);
            workerFrac[slot] = 1;
            poolProgress();
            // This slice's worker is done — terminate it now rather than
            // leaving it resident until the next cancelActiveCompute()/
            // computeDone() (same rationale as computeDone's terminate loop):
            // a finished pool worker still pins its DEM copy + Dijkstra
            // buffers, which stacks on top of the NEXT pool (compare's
            // scenario B, or the post-merge interp pool) otherwise.
            w.terminate();
            const ix = state.workers.indexOf(w);
            if (ix >= 0) state.workers.splice(ix, 1);
            if (--remaining === 0) {
              stopTicker();
              // Second density normalisation (per-ref /N happened worker-side).
              for (let i = 0; i < N; i++) density[i] /= N;
              const energy = new Float32Array(N);
              for (let i = 0; i < N; i++) {
                energy[i] = energyCount[i] > 0 ? energySum[i] / energyCount[i] : Infinity;
              }
              resolve({ energy, passes: density, matrix });
            }
          } else if (m.kind === "engine-fallback") {
            stopTicker();
            noteEngineFallback(m);
          } else if (m.kind === "error") {
            stopTicker();
            computeFailed(m.message);
          }
        }, engine ? WASM_WORKER_URL : WORKER_URL);
        const { height, mask, transfer } = buildComputeGrid();
        const networkMask = useNetwork ? new Uint8Array(state.networkMask) : null;
        if (networkMask) transfer.push(networkMask.buffer);
        w.postMessage(
          {
            // This slice's refs, raw accumulators back (densityPartial), and
            // never the IDW fill — interp (if any) runs after the merge.
            ...densitySliceMessage(baseMsg, {
              refPoints: state.refPoints.slice(lo, hi),
              // Accessibility matrix: each slice samples its refs' fields at
              // ALL K ref cells (matrixCells is structured-cloned, shared
              // read-only across the pool — like the portal arrays).
              matrixCells: matrix ? matrixCells : null,
            }),
            height, mask, networkMask,
            // The compiled engine (structured clone shares the code).
            ...(wasmSpec ? { wasm: wasmSpec } : {}),
          },
          transfer,
        );
      }
    });
  };

  const startSingleWorker = async () => {
    // Single worker: regular from/to/round runs, top-N, maximize. The plain
    // energy field (no destination / top-N / maximize) may run on the wasm
    // engine (v80); callers never reach here for the compare pair.
    let engine = singleEngine({
      N, mode, nDirs, hasNet: constrainNet, wantTopN, maximize,
      wantPath: !!state.dst, graph: graphModeActive(), compare: false,
    });
    const wasmSpec = engine ? await loadWasmEngine(engine) : null;
    if (gen !== state.computeGen) return;
    if (!wasmSpec) engine = null;
    noteRunEngine(engine);
    const stopTicker = engine ? wasmTicker(reportProgress) : () => {};
    const w = spawnWorker((m) => {
      if (m.kind === "progress") {
        reportProgress(m.progress);
      } else if (m.kind === "done") {
        stopTicker();
        computeDone(m);
      } else if (m.kind === "error") {
        stopTicker();
        computeFailed(m.message);
      } else if (m.kind === "engine-fallback") {
        stopTicker();
        noteEngineFallback(m);
      } else if (m.kind === "warning") {
        // Non-fatal — the worker is still going and will follow up with
        // a `done` message. Yellow-tint the status; the next progress
        // tick will overwrite it.
        console.warn("[worker]", m.message);
        status.innerHTML = `<span style="color:#ffb86b">${escapeHtml(workerWarningText(m))}</span>`;
      }
    }, engine ? WASM_WORKER_URL : WORKER_URL);
    const { height, mask, networkMask, transfer } = demPayload();
    w.postMessage({ ...baseMsg, height, mask, networkMask, ...(wasmSpec ? { wasm: wasmSpec } : {}) }, transfer);
  };

  // ---- Optional native backend (density only, OFF by default) --------------
  // Sends the DEM + params to the local Rust server (backend/ in the repo)
  // which runs the per-ref Dijkstras on all cores. Any failure — server not
  // running, version mismatch, network error — falls back to the in-browser
  // pool. Protocol documented in backend/src/main.rs.
  const startDensityBackend = async (baseUrl, { useNetwork, wantMatrix: sliceMatrix = false }) => {
    progressBar.style.width = "10%"; // no streaming progress from the backend
    // Liveness ticker: large runs take a while server-side and fetch gives
    // no progress events — an elapsed counter shows the app isn't hung.
    const t0 = performance.now();
    status.textContent = t(cloudMode ? "status.cloud_computing" : "status.backend_computing");
    const ticker = setInterval(() => {
      if (gen !== state.computeGen) { clearInterval(ticker); return; }
      status.textContent = t(
        cloudMode ? "status.cloud_computing_elapsed" : "status.backend_computing_elapsed",
        formatDuration(performance.now() - t0));
    }, 1000);
    try {
      const params = {
        h: H, w: W,
        dx: state.dem.dxM, dy: state.dem.dyM,
        cost, eMax, eMaxMode,
        densityMode,
        refPoints: state.refPoints.map(([r, c]) => [r, c]),
        hasNetwork: useNetwork,
        maximize,
        // Bridge portal edges appended after the (optional) network mask, in
        // order: portalU (i32×P), portalV (i32×P), portalLenM (f64×P),
        // portalHU (f64×P), portalHV (f64×P). HU/HV are deck-end ele (NaN=use DEM).
        nPortals: portals ? portals.n : 0,
        // Accessibility matrix: the backend samples ref cells itself from
        // refPoints (no matrixCells on the wire) and appends f32×K² after
        // the energy field, announcing it with "matrix":K in the meta. An
        // older binary ignores the flag — detected below via the meta.
        wantMatrix: !!sliceMatrix,
        // Move set (backend ≥ 0.2.0; dispatch is version-gated — an older
        // binary would silently ignore this field and compute 8 directions).
        nDirs,
      };
      const json = new TextEncoder().encode(JSON.stringify(params));
      const head = new Uint8Array(4);
      new DataView(head.buffer).setUint32(0, json.length, true);
      // Compose the impassable mask + bridge corridors into the grid the native
      // backend computes on (sent as raw bytes — parity kept).
      const { height: gridHeight, mask: gridMask } = buildComputeGrid();
      const body = new Blob([
        head, json, gridHeight, gridMask,
        ...(useNetwork ? [state.networkMask] : []),
        ...(portals ? [portals.u, portals.v, portals.lenM, portals.hu, portals.hv] : []),
      ]);
      const resp = await fetch(`${baseUrl}/density`, { method: "POST", body, headers: cloudComputeHeaders() });
      if (!resp.ok) throw new Error(`backend HTTP ${resp.status}`);
      const buf = await resp.arrayBuffer();
      if (gen !== state.computeGen) return new Promise(() => {});

      // From here on the backend HAS answered — a parsing/allocation error
      // must surface as a failure, NOT fall through to the browser-pool
      // fallback (silently recomputing a huge DEM there looks like a hang).
      try {
        const dv = new DataView(buf);
        const jlen = dv.getUint32(0, true);
        // Meta JSON (padded with trailing spaces — legal JSON whitespace).
        // "matrix":K announces the appended f32×K² accessibility matrix; an
        // older backend that predates the field simply omits it.
        let respMeta = {};
        try {
          respMeta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, jlen)));
        } catch { /* tolerate unparseable meta — fall through to length check */ }
        const mk = respMeta.matrix | 0;
        const expect = 4 + jlen + 8 * N + 4 * N + 4 * mk * mk;
        if (buf.byteLength !== expect) {
          throw new Error(`backend response ${buf.byteLength} B, expected ${expect} B`);
        }
        let off = 4 + jlen;
        // Always slice-copy: a zero-copy VIEW over the response buffer would
        // keep the WHOLE response (header + JSON + density + energy) reachable
        // for the lifetime of the result (state.lastResult.passes), doubling
        // up the 4·N energy bytes (once here, once inside `buf`) — ~540 MB of
        // dead weight on the 135 M-cell target. The transient +8·N copy cost
        // is worth not retaining the 12·N response buffer.
        const density = new Float64Array(buf.slice(off, off + 8 * N));
        off += 8 * N;
        // Energy is always copied out: downstream steps (interp) transfer
        // it to workers, and a view would drag the whole response buffer —
        // density included — along and detach it.
        const energy = new Float32Array(buf.slice(off, off + 4 * N));
        off += 4 * N;
        // Slice-copied like the fields above (a view would pin the whole
        // response). mk===0 with sliceMatrix requested ⇒ the backend binary
        // predates the matrix — degrade to "KPI unavailable", never fail
        // (and never fall back to the browser: the fields are good).
        const matrix = mk > 0 ? new Float32Array(buf.slice(off, off + 4 * mk * mk)) : null;
        if (sliceMatrix && !matrix) console.warn("[backend] no accessibility matrix in response — backend predates the feature");
        progressBar.style.width = "100%";
        return { energy, passes: density, matrix, matrixOutdated: !!(sliceMatrix && !matrix) };
      } catch (err) {
        console.error("[backend] response handling failed:", err);
        computeFailed(`backend response handling failed: ${err.message}`);
        return new Promise(() => {}); // run is dead; keep the chain pending
      }
    } finally {
      clearInterval(ticker);
    }
  };

  // ---- Optional native backend: single-source energy field ------------------
  // POST /single — one Dijkstra (two for round) on the native server, returning
  // the raw energy field + optional passes. Maximize/top-N/path stay browser-
  // only (the backend produces no routes), so the caller only reaches here for
  // the plain from/to/round energy field. Throws on any failure → browser
  // fallback (a 404 from an old backend without /single lands here too).
  const startSingleBackend = async (baseUrl) => {
    progressBar.style.width = "10%"; // no streaming progress from the backend
    const t0 = performance.now();
    status.textContent = t(cloudMode ? "status.cloud_computing" : "status.backend_computing");
    const ticker = setInterval(() => {
      if (gen !== state.computeGen) { clearInterval(ticker); return; }
      status.textContent = t(
        cloudMode ? "status.cloud_computing_elapsed" : "status.backend_computing_elapsed",
        formatDuration(performance.now() - t0));
    }, 1000);
    try {
      const params = {
        h: H, w: W,
        dx: state.dem.dxM, dy: state.dem.dyM,
        cost, eMax, eMaxMode,
        densityMode: mode,                 // from | to | round (single-source dir)
        src: [state.src[0], state.src[1]],
        wantPasses,
        hasNetwork: constrainNet,
        maximize: false,                   // excluded from the single-source path
        nPortals: portals ? portals.n : 0,
        // Move set (backend ≥ 0.2.0; dispatch is version-gated).
        nDirs,
      };
      const json = new TextEncoder().encode(JSON.stringify(params));
      const head = new Uint8Array(4);
      new DataView(head.buffer).setUint32(0, json.length, true);
      const { height: gridHeight, mask: gridMask } = buildComputeGrid();
      const body = new Blob([
        head, json, gridHeight, gridMask,
        ...(constrainNet ? [state.networkMask] : []),
        ...(portals ? [portals.u, portals.v, portals.lenM, portals.hu, portals.hv] : []),
      ]);
      const resp = await fetch(`${baseUrl}/single`, { method: "POST", body, headers: cloudComputeHeaders() });
      if (!resp.ok) throw new Error(`backend HTTP ${resp.status}`);
      const buf = await resp.arrayBuffer();
      if (gen !== state.computeGen) return new Promise(() => {});
      try {
        const dv = new DataView(buf);
        const jlen = dv.getUint32(0, true);
        // v49 shipped /single passes as f64 (subtree_passes_f64, counts exceed
        // 2^24 on big DEMs). A pre-v49 backend binary (stale self-hosted build,
        // or the cloud VM's boot-disk-cached binary — see vm/startup-script.sh)
        // still answers with f32 passes. Accept both layouts, mirroring the
        // /density decoder's old-backend tolerance, rather than hard-failing.
        const expectF64 = 4 + jlen + 4 * N + (wantPasses ? 8 * N : 0);
        const expectF32 = 4 + jlen + 4 * N + (wantPasses ? 4 * N : 0);
        let passesAreF32 = false;
        if (buf.byteLength === expectF64) {
          // current layout
        } else if (wantPasses && buf.byteLength === expectF32) {
          passesAreF32 = true;
          console.warn("[backend] pre-v49 backend detected: /single passes received as f32 — rebuild the backend (cargo build --release) for exact counts above 2^24");
        } else {
          throw new Error(`backend response ${buf.byteLength} B, expected ${expectF64} B`);
        }
        let off = 4 + jlen;
        // Slice-copy (a single search, so the copy is cheap and the views need
        // no alignment): f32 energy first, then passes when present.
        const energy = new Float32Array(buf.slice(off, off + 4 * N));
        off += 4 * N;
        const passes = wantPasses
          ? (passesAreF32
              ? Float64Array.from(new Float32Array(buf.slice(off, off + 4 * N)))
              : new Float64Array(buf.slice(off, off + 8 * N)))
          : null;
        progressBar.style.width = "100%";
        return { energy, passes };
      } catch (err) {
        console.error("[backend] single response handling failed:", err);
        computeFailed(`backend response handling failed: ${err.message}`);
        return new Promise(() => {}); // run is dead; keep the chain pending
      }
    } finally {
      clearInterval(ticker);
    }
  };

  // Backend with browser-pool fallback, per scenario. Resolves with raw
  // {energy, passes} like computeDensityField.
  const densityField = async (opts) => {
    // nDirs ≠ 8 needs backend ≥ 0.2.0 (the move-set port). Cloud enters
    // optimistically (version only known post-boot) and the in-try check
    // throws a reason-ful error an OLD binary — the shared catch below turns
    // it into the no-fallback abort or the browser fallback with motivo.
    if (runUseBackend && (nDirs === 8 || cloudMode || backendServesNDirs())) {
      try {
        if (nDirs !== 8 && !backendServesNDirs()) {
          throw new Error(t("cloud.backend_old_ndirs",
                            (state.backendCores && state.backendCores.version) || "?", nDirs));
        }
        return await startDensityBackend(computeDataUrl(), opts);
      } catch (err) {
        if (gen !== state.computeGen) return new Promise(() => {});
        // "Falhar em vez de cair pro navegador": abort loudly (computeFailed
        // also stops the VM) instead of silently recomputing on the laptop.
        if (cloudMode && cloudNoFallback()) {
          computeFailed(t("cloud.failed_hard", err?.message || String(err)));
          return new Promise(() => {}); // run is dead; keep the chain pending
        }
        console.warn("[backend] falling back to in-browser workers:", err);
        // Surface the REASON in the status line, not just the console — a
        // silent fallback reads as "the cloud just didn't run" (visto na
        // prática). err.message is our own fetch/HTTP wording, not user data.
        status.textContent = t(cloudMode ? "cloud.preempted" : "status.backend_fallback",
                               err?.message || String(err));
        // This run is now executing on the browser pool, not the backend.
        // Re-tag it so computeDone's online correction trains corrBrowser
        // (actual/predicted vs the browser model), not corrBackend — otherwise
        // every fallback run corrupts the native-slice correction with
        // browser timings and leaves corrBrowser untrained.
        if (state.lastRun) state.lastRun.backend = false;
      }
    }
    return computeDensityField(opts);
  };

  // ---- Constrained vs unconstrained comparison ------------------------------
  // Two full-grid single-source workers: the primary run exactly as
  // configured (network mask, passes, top-N, path, interp), plus a secondary
  // run WITHOUT the network (energy + passes when enabled). The energy
  // difference (constrained − unconstrained, clamped at 0 — a constraint can
  // never reduce cost) quantifies what the network costs in energy; it's
  // defined on network cells only (off-network constrained values are interp
  // visualisation, not analysis). Passes difference is signed: positive
  // where the network concentrates traffic, negative where unconstrained
  // corridors ran.
  //
  // Each worker's resident set (height+mask+E+settled+parents+order+passes,
  // ~26-40 B/cell) is comparable to a density-pool worker's, but nothing
  // budgeted the pair — run BOTH in parallel only when that fits the SAME
  // conservative budget the density/interp pools use (38/55 B/cell are
  // densityPoolSize's constants; slightly conservative here, which is fine).
  // Otherwise run wB only after wA's buffers are actually released
  // (terminated), so the two full-grid workers are never resident together —
  // peak memory halves at the cost of serialized wall time.
  const startComparePair = () => {
    let primary = null, secondary = null;
    const maybeFinish = async () => {
      if (!primary || !secondary) return;
      // The difference is ANALYSED on network cells only (off-network
      // constrained values are interpolation, not analysis), then — when
      // the interp option is on — visually filled across non-network
      // cells exactly like the constrained field.
      const net = state.networkMask;
      let diff = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        if (net && !net[i]) { diff[i] = Infinity; continue; }
        const a = primary.energy[i], b = secondary.energy[i];
        diff[i] = (Number.isFinite(a) && Number.isFinite(b)) ? Math.max(0, a - b) : Infinity;
      }
      if (wantNetworkInterp && constrainNet) {
        diff = await runInterp(diff);
        if (gen !== state.computeGen) return;
      }
      primary.energyAlt = { unconstrained: secondary.energy, difference: diff };
      if (primary.passes && secondary.passes) {
        primary.passesAlt = { unconstrained: secondary.passes };
      }
      // The secondary now also traces the unconstrained best TERRAIN route (only
      // when a destination is set) → the compare route view's blue line.
      if (secondary.path && secondary.path.length) {
        primary.pathAlt = secondary.path;
        primary.pathAltEnergy = secondary.pathEnergy ?? null;
        primary.pathAltLengthM = secondary.pathLengthM ?? null;
      }
      computeDone(primary);
    };
    const perWorker = (mode === "round" ? 55 : 38) * N;
    const parallelOk = 2 * perWorker <= memBudgetBytes();
    // Progress: in the parallel case only the primary reports (unchanged
    // behaviour). In the sequential case wA and wB each cover half the bar —
    // without this, wB's run (roughly as long as wA's, on exactly the huge
    // DEMs this fix targets) would leave the bar sitting at ~100% with zero
    // feedback for the whole second pass.
    const startSecondary = (opts = {}) => {
      const { progressBase = 0, progressScale = 1 } = opts;
      const wB = spawnWorker((m) => {
        if (m.kind === "progress") {
          if (progressBase || progressScale !== 1) reportProgress(progressBase + progressScale * m.progress);
        } else if (m.kind === "done") { secondary = m; maybeFinish(); }
        else if (m.kind === "error") computeFailed(m.message);
      });
      // No network — same mode/cost/budget; passes mirror the primary so the
      // overlay is comparable across scenarios. Bridges are terrain, so the
      // composed grid applies here too (only the networkMask constraint slot
      // differs from the primary). We KEEP baseMsg's goalR/goalC so the
      // unconstrained partner ALSO traces the best TERRAIN route to the
      // destination (single best — no top-N/interp); that's the compare route
      // view's blue line.
      const { height, mask, transfer } = buildComputeGrid();
      wB.postMessage(
        {
          ...baseMsg,
          height, mask, networkMask: null,
          wantTopN: false,
          wantNetworkInterp: false,
          maximizeLength: 0,
        },
        transfer,
      );
    };
    const wA = spawnWorker((m) => {
      if (m.kind === "progress") reportProgress(parallelOk ? m.progress : m.progress * 0.5);
      else if (m.kind === "done") {
        primary = m;
        if (!parallelOk) {
          // Release wA's full-grid buffers before wB allocates its own —
          // otherwise the two ~3.5 GB workers are resident together anyway
          // and the memory-halving below doesn't hold (computeDone's later
          // terminate loop is a no-op on an already-removed worker, so this
          // is safe to do here).
          wA.terminate();
          state.workers = state.workers.filter((w) => w !== wA);
          startSecondary({ progressBase: 0.5, progressScale: 0.5 });
        }
        maybeFinish();
      }
      else if (m.kind === "error") computeFailed(m.message);
      else if (m.kind === "warning") {
        console.warn("[worker]", m.message);
        status.innerHTML = `<span style="color:#ffb86b">${escapeHtml(workerWarningText(m))}</span>`;
      }
    });
    {
      const { height, mask, networkMask, transfer } = demPayload();
      wA.postMessage({ ...baseMsg, height, mask, networkMask }, transfer);
    }
    if (parallelOk) startSecondary();
  };

  const compareOn = constrainNet && !!document.getElementById("vec-compare")?.checked;
  // Graph mode is inherently network-constrained, so "Compare with unconstrained"
  // applies there too (independent of the now-locked-on raster constrain toggle):
  // graph mode runs a full-DEM unconstrained RASTER scenario alongside the graph
  // compute and exposes the difference through the displayed-scenario picker.
  const graphCompareOn = graphModeActive() && !!document.getElementById("vec-compare")?.checked;

  // Compute source: Browser (in-page pool) / Localhost (native Rust) / Cloud
  // (local orchestrator → pre-baked VM). backendOn = "anything but browser":
  // the density/single dispatch is engine-agnostic and just gets the right
  // base URL (the orchestrator mirrors the backend's /density,/single bytes).
  const cloudMode = computeMode() === "cloud";
  const backendOn = computeMode() !== "browser";
  const backendUrl = effectiveBackendUrl();
  // Will THIS run actually use the native backend? It only does raster density
  // and backend-eligible single-source (from/to/round); top-N, the destination
  // path, "maximize", graph mode, AND a non-density compare (which routes to the
  // browser-only startComparePair) always run in-browser. Used to avoid booting a
  // cloud VM for a run that would compute in-browser anyway.
  // nDirs ≠ 8: served by backend ≥ 0.2.0 (the move-set port). Cloud is
  // OPTIMISTIC here — the VM's version is only known after boot, so we boot
  // and re-check at dispatch (backendServesNDirs), falling back with a clear
  // reason if the binary is older. Localhost knows the version from the idle
  // /health probe, so it gates accurately up front.
  const nDirsOk = nDirs === 8 ||
    (cloudMode ? true : backendServesNDirs());
  const willUseBackend = backendOn && !graphModeActive() && nDirsOk &&
    (wantDensity || (!compareOn && !wantTopN && !maximize && !state.dst));
  // Run-scoped engine override. Normally tracks backendOn, but a failed cloud
  // boot flips it to false so the density path (which reads it inside
  // densityField) finishes in-browser like the single path. Assigned in
  // dispatchCompute(useBackend) before any compute starts.
  let runUseBackend = backendOn;

  // Density + compare: the two scenarios run sequentially (each already
  // saturates the cores), splitting the progress bar. Diffs come from the
  // RAW constrained field (pre-interp); the energy difference is therefore
  // naturally confined to network cells.
  const startDensityCompare = async () => {
    // The accessibility matrix rides on scenario A (the constrained one —
    // the realistic access); B is the counterfactual and skips it.
    const A = await densityField({ useNetwork: true, progressBase: 0, progressScale: 0.5, wantMatrix });
    if (gen !== state.computeGen) return;
    const B = await densityField({ useNetwork: false, progressBase: 0.5, progressScale: 0.5 });
    if (gen !== state.computeGen) return;
    let diffE = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const a = A.energy[i], b = B.energy[i];
      diffE[i] = (Number.isFinite(a) && Number.isFinite(b)) ? Math.max(0, a - b) : Infinity;
    }
    // Difference is computed from the RAW constrained field (network cells
    // only), then visually filled like the constrained field when the
    // interp option is on.
    if (wantNetworkInterp && constrainNet) {
      diffE = await runInterp(diffE);
      if (gen !== state.computeGen) return;
    }
    finishDensityOutputs(A.energy, A.passes, {
      energyAlt: { unconstrained: B.energy, difference: diffE },
      passesAlt: { unconstrained: B.passes },
    }, A);
  };

  // Full-DEM UNCONSTRAINED raster energy field for graph-mode compare (no network
  // mask). Density → browser pool; single-source → one worker (energy only, no
  // path/top-N). Resolves a Float32Array (Infinity where unreachable), or null on
  // cancel/error. Runs in-browser (graph mode never uses the native backend).
  // Returns { energy, passes } — passes is the unconstrained TERRAIN density (a
  // raster), present only for the density partner (the from/to partner is
  // energy-only). Used for the graph-mode difference's 3C.b terrain channel.
  const computeUnconstrainedEnergy = () => {
    if (wantDensity) return computeDensityField({ useNetwork: false }).then((r) => ({ energy: r.energy, passes: r.passes || null, path: null, pathEnergy: null, pathLengthM: null }));
    return new Promise((resolve) => {
      const w = spawnWorker((m) => {
        if (m.kind === "done") resolve({ energy: m.energy, passes: m.passes || null, path: m.path || null, pathEnergy: m.pathEnergy ?? null, pathLengthM: m.pathLengthM ?? null });
        else if (m.kind === "error") { computeFailed(m.message); resolve(null); }
      });
      const { height, mask, transfer } = buildComputeGrid();
      // Same mode/cost/budget as the graph run; no network, no top-N/interp. We
      // KEEP baseMsg's goalR/goalC so the partner ALSO traces the best TERRAIN
      // route to the destination → the compare route view's blue line.
      w.postMessage(
        { ...baseMsg, height, mask, networkMask: null, wantTopN: false, maximizeLength: 0, wantNetworkInterp: false },
        transfer,
      );
    });
  };

  // "Follow the vectors": route on the network graph instead of the raster.
  // Lazily (re)builds the cached graph in a worker, then runs the chosen mode
  // on it and renders the colored-vector overlay. Same gen/cancel semantics.
  const startGraphCompute = () => {
    const token = computeNetworkGraphToken();
    // IDW-fill a rasterised graph field (energy or difference) off-network, using
    // the field's own finite cells as seeds (the graph IS the network). Resolves
    // with the filled field; transfers the input buffer (caller must not reuse it).
    const graphInterp = (field) => new Promise((resolve) => {
      const seedMask = new Uint8Array(field.length);
      for (let i = 0; i < field.length; i++) seedMask[i] = Number.isFinite(field[i]) ? 1 : 0;
      const mask = buildComputeGrid({ maskOnly: true }).mask; // don't fill across water
      const w = spawnWorker((m) => {
        // Terminate here rather than waiting for the next compute — this
        // worker's job is done either way, and leaving it resident pins its
        // full-grid buffers (~15 B/cell) until the next cancelActiveCompute()/
        // DEM change (same rationale as computeDone's terminate loop).
        const done = () => {
          w.terminate();
          const ix = state.workers.indexOf(w);
          if (ix >= 0) state.workers.splice(ix, 1);
        };
        if (m.kind === "interp-done") { done(); if (gen !== state.computeGen) return; resolve(m.energy); }
        // On error, `field` is already DETACHED (transferred to the worker), so it
        // can't be returned — resolve null and let the caller keep the prior field.
        else if (m.kind === "error") { done(); console.warn("[graph interp]", m.message); resolve(null); }
      });
      w.postMessage(
        { kind: "interp", energy: field, networkMask: seedMask, mask, H: state.dem.H, W: state.dem.W, dx: state.dem.dxM, dy: state.dem.dyM, interpMaxDistance, interpSmoothing },
        [field.buffer, seedMask.buffer, mask.buffer],
      );
    });
    const finishGraph = async (graph, result) => {
      if (gen !== state.computeGen) return;
      // Rasterise the graph energy onto the grid (network cells only) BEFORE
      // terminating workers — graph-mode compare spawns an unconstrained partner.
      const eGrid = rasterizeGraphEnergy(graph, result);

      // Graph-mode compare: run a full-DEM unconstrained RASTER scenario and diff
      // it against the graph energy (network cells), mirroring raster compare. The
      // diff is the energy COST of being restricted to the network (clamped ≥ 0).
      let energyAlt = null;
      let passesAlt = null;
      let terrainPath = null, terrainPathEnergy = null, terrainPathLengthM = null;
      if (graphCompareOn && eGrid) {
        status.textContent = t("status.computing");
        const unconR = await computeUnconstrainedEnergy();
        if (gen !== state.computeGen || !unconR || !unconR.energy) return;
        const uncon = unconR.energy;
        const diff = new Float32Array(N);
        for (let i = 0; i < N; i++) {
          const a = eGrid[i], b = uncon[i];
          diff[i] = (Number.isFinite(a) && Number.isFinite(b)) ? Math.max(0, a - b) : Infinity;
        }
        energyAlt = { unconstrained: uncon, difference: diff };
        // Terrain (free-movement) passes as a RASTER → the difference view's 3C.b
        // channel. Present for density compares; null for from/to (energy-only partner).
        if (unconR.passes) passesAlt = { unconstrained: unconR.passes };
        // The unconstrained best TERRAIN route (raster) for the compare route view's
        // blue line — only present when a destination is set (from/to/round).
        if (unconR.path && unconR.path.length) {
          terrainPath = unconR.path;
          terrainPathEnergy = unconR.pathEnergy ?? null;
          terrainPathLengthM = unconR.pathLengthM ?? null;
        }
      }

      // Finalise the run now (the partner, if any, is done).
      for (const w of state.workers) w.terminate();
      state.workers = [];
      progress.classList.remove("active");
      updateRunButtonState();
      state.computeStartedAt = 0;
      setGroupOpen("result-group", true); // graph compute done → reveal results (3)
      state.lastGraphResult = { graph, result, energyAlt, passesAlt, pathAlt: terrainPath, pathAltEnergy: terrainPathEnergy, pathAltLengthM: terrainPathLengthM };
      state.graphEnergyRaster = null;
      renderGraphOverlay();   // passes corridors show immediately
      // Learn the graph engine's real per-edge cost (corrGraph). The graph's
      // actual node/edge counts also sharpen the next estimate. Skip the
      // correction on compare runs — their elapsed includes the partner scenario.
      if (state.networkGraph) { state.networkGraph.nNodes = graph.nNodes; state.networkGraph.nEdges = graph.nEdges; }
      if (!energyAlt) { updateEstimateCorrection(result.elapsedMs, 0); estimateRunTime(); }
      // Same retry as the grid computeDone: the calibration probe is skipped
      // while a compute runs — if this DEM still has no calibration (e.g. the
      // probe errored at DEM load), run it now that the cores are free. Graph
      // users never hit the grid completion path, so without this the
      // pre-flight estimate would stay blank for the rest of the session.
      if (!state.calibration) startCalibrationProbe();
      const routeNote = result.routes ? t("status.graph_route_note", result.routes.length) : "";
      const doneMsg = t("status.graph_done", result.elapsedMs.toFixed(0), graph.nNodes, graph.nEdges, routeNote);
      // Energy field: rasterise the graph energy onto the grid, then (when the
      // interp option is on) IDW-fill off-network — the smooth field grid shows.
      if (eGrid && wantNetworkInterp) {
        status.textContent = t("status.interpolating_energy");
        const interpStart = performance.now();
        // null = interp failed (e.g. OOM); leave graphEnergyRaster null (no energy
        // overlay, passes corridors still show) — the pre-refactor behaviour.
        const filled = await graphInterp(eGrid);
        if (gen !== state.computeGen) return;
        if (filled) state.graphEnergyRaster = filled;
        // Fill the difference field the same way so the "difference" scenario reads
        // as a smooth field (it's analysed on network cells, filled for display).
        // On interp failure difference becomes null → the picker falls back to the
        // constrained field (renderGraphOverlay) instead of a blank overlay.
        if (energyAlt) {
          energyAlt.difference = await graphInterp(energyAlt.difference);
          if (gen !== state.computeGen) return;
        }
        renderGraphOverlay();
        status.textContent = doneMsg;
        scheduleStatusClear(doneMsg);
        // Graph interp is single-worker — learn its rate (corrInterp).
        if (!energyAlt) { updateEstimateCorrection(0, performance.now() - interpStart); estimateRunTime(); }
      } else {
        if (eGrid) state.graphEnergyRaster = eGrid;
        renderGraphOverlay();
        status.textContent = doneMsg;
        scheduleStatusClear(doneMsg);
      }
    };
    const runOnGraph = (graph) => {
      if (gen !== state.computeGen) return;
      const params = {
        mode, cost, eMax, eMaxMode,
        srcRC: state.src || null,
        dstRC: state.dst || null,
        wantPath: !!state.dst,
        wantTopN, nRoutes, penalty,
        maximize, maximizeLength,
        densityMode: mode,
      };
      if (wantDensity) {
        params.mode = "density";
        params.refRCs = state.refPoints.slice();
      }
      const w = spawnWorker((m) => {
        if (m.kind === "progress") reportProgress(m.progress);
        else if (m.kind === "graph-result") finishGraph(graph, m.result);
        else if (m.kind === "error") computeFailed(m.message);
      });
      // No transfer list → the cached graph is structured-cloned, not detached.
      w.postMessage({ kind: "graphRun", graph, params, gen });
    };
    if (state.networkGraph && state.networkGraphToken === token) { runOnGraph(state.networkGraph); return; }
    status.textContent = t("status.building_graph");
    const wb = spawnWorker((m) => {
      if (m.kind === "graph-built") {
        if (gen !== state.computeGen) return;
        state.networkGraph = m.graph;
        state.networkGraphToken = token;
        runOnGraph(m.graph);
      } else if (m.kind === "error") computeFailed(m.message);
    });
    // Compose the impassable mask + bridge corridors so graph node elevations
    // get the bridge profile and water nodes are marked invalid.
    const grid = buildComputeGrid();
    const dem = {
      height: grid.height, mask: grid.mask,
      H: state.dem.H, W: state.dem.W, dxM: state.dem.dxM, dyM: state.dem.dyM,
    };
    // Node-snap tolerance: the engine takes CELLS, but a fixed 0.5 scales with
    // resolution (45 m on COP90 — coarse DEMs collapse distinct junctions).
    // Cap the physical size at 15 m; on FABDEM 30 m this stays exactly 0.5.
    const cellMetres = Math.min(state.dem.dxM, state.dem.dyM);
    const snapTolCells = Math.min(0.5, 15 / cellMetres);
    wb.postMessage(
      { kind: "graphBuild", lines: networkLinesToCellLines(), dem, opts: { junctionMode: graphJunctionMode(), snapTolCells, stepCells: 1, lineMeta: state.networkLinesMeta }, gen },
      [dem.height.buffer, dem.mask.buffer],
    );
  };

  // The actual engine dispatch. `useBackend` is normally `backendOn`, but a
  // failed cloud boot calls it with `false` so the run finishes in-browser.
  // Mirror it into runUseBackend so the density path (densityField) agrees.
  const dispatchCompute = (useBackend) => {
    runUseBackend = useBackend;
    if (graphModeActive() && state.networkLines && state.networkLines.length) {
      startGraphCompute();
    } else if (wantDensity && compareOn) {
      startDensityCompare();
    } else if (wantDensity) {
      (async () => {
        const r = await densityField({ useNetwork: constrainNet, wantMatrix });
        if (gen !== state.computeGen) return;
        finishDensityOutputs(r.energy, r.passes, null, r);
      })();
    } else if (compareOn) {
      startComparePair();
    } else if (useBackend && !wantTopN && !maximize && !state.dst &&
               (nDirs === 8 || cloudMode || backendServesNDirs())) {
      // Single-source energy field on the native backend (energy + optional
      // passes). Top-N / maximize / a destination path need the browser (the
      // backend produces no routes); any backend failure falls back too.
      // nDirs ≠ 8: same optimistic-cloud + version-check pattern as density.
      (async () => {
        const t0 = performance.now();
        let r;
        try {
          if (nDirs !== 8 && !backendServesNDirs()) {
            throw new Error(t("cloud.backend_old_ndirs",
                              (state.backendCores && state.backendCores.version) || "?", nDirs));
          }
          r = await startSingleBackend(computeDataUrl());
        } catch (err) {
          if (gen !== state.computeGen) return;
          if (cloudMode && cloudNoFallback()) {
            computeFailed(t("cloud.failed_hard", err?.message || String(err)));
            return;
          }
          console.warn("[backend] falling back to in-browser workers:", err);
          status.textContent = t(cloudMode ? "cloud.preempted" : "status.backend_fallback",
                                 err?.message || String(err));
          if (state.lastRun) state.lastRun.backend = false;
          startSingleWorker();
          return;
        }
        if (gen !== state.computeGen || !r) return;
        const computeMs = performance.now() - t0;
        // The backend returns the raw network-constrained field; the IDW fill is
        // a separate browser phase (the worker did it inline for the JS path).
        let energy = r.energy, interpMs = 0;
        if (wantNetworkInterp && constrainNet) {
          const ti = performance.now();
          energy = await runInterp(energy);
          if (gen !== state.computeGen) return;
          interpMs = performance.now() - ti;
        }
        computeDone({
          energy, passes: r.passes,
          path: null, pathEnergy: null, pathLengthM: null, routes: null,
          elapsedMs: performance.now() - t0, computeMs, interpMs,
        });
      })();
    } else {
      startSingleWorker();
    }
  };

  // The browser/localhost paths dispatch straight away. Cloud first boots the
  // VM through the orchestrator (idempotent), runs the client-side keepalive
  // (in-flight flag only — no orchestrator-side lease) while the compute runs,
  // and stops the VM in computeDone. On a missing
  // orchestrator URL, or an orchestrator/boot failure, it falls back to the
  // in-browser pool for this run (densityField()/single's own try/catch then
  // re-tags lastRun.backend=false; here we force useBackend=false up front).
  if (!cloudMode) {
    state.cloud.mode = "browser"; // a prior cloud run must not stop a VM in this run's computeDone
    dispatchCompute(backendOn);
  } else if (!willUseBackend) {
    // Cloud selected, but THIS run (top-N / destination / maximize / graph)
    // computes in-browser regardless — don't boot a billable VM we won't touch
    // (it would only delay the run ~1 min and bill for nothing). The orchestrator
    // URL is irrelevant for such a run, so don't require it either.
    state.cloud.mode = "browser";
    dispatchCompute(false);
  } else if (!backendUrl) {
    status.innerHTML = `<span style="color:#ff6b6b">${t("cloud.need_orch_url")}</span>`;
    cancelActiveCompute();
    runBtn.disabled = false;
    progress.classList.remove("active");
  } else if (!cloudToken()) {
    status.innerHTML = `<span style="color:#ff6b6b">${t("cloud.need_password")}</span>`;
    cancelActiveCompute();
    runBtn.disabled = false;
    progress.classList.remove("active");
  } else {
    state.cloud.mode = "cloud";
    state.cloud.orchestratorUrl = backendUrl;
    (async () => {
      let ready = false;
      try {
        ready = await ensureCloudVm(backendUrl, () => gen !== state.computeGen);
      } catch (err) {
        if (gen !== state.computeGen) return;
        console.warn("[cloud] VM unavailable, falling back to browser:", err);
        const reason = err && err.reason;
        const bootFailed = reason === "boot_failed";
        // A boot_failed VM may have actually started before going unhealthy —
        // best-effort stop it so it doesn't linger (the in-VM watchdog backstops).
        if (bootFailed) stopCloudVm(backendUrl);
        // "Falhar em vez de cair pro navegador": abort loudly, no browser run.
        if (cloudNoFallback()) {
          computeFailed(t("cloud.failed_hard", reason || err?.message || String(err)));
          return;
        }
        status.textContent = t(reason === "auth_failed" ? "cloud.auth_failed"
                              : bootFailed ? "cloud.boot_failed"
                              : "cloud.orch_unreachable");
        if (state.lastRun) state.lastRun.backend = false;
        state.cloud.mode = "browser"; // computeDone must not try to stop a VM that never started
        dispatchCompute(false);
        return;
      }
      if (gen !== state.computeGen || !ready) return;
      startCloudKeepalive(backendUrl);
      dispatchCompute(true);
    })();
  }
});

// ------- Render -------
export function renderResult({ energy, passes, path, pathEnergy, pathLengthM, routes, elapsedMs, energyAlt, passesAlt, pathAlt, pathAltEnergy, pathAltLengthM, runMode, matrix, matrixOutdated, kpi, stringPulled }) {
  // A grid result supersedes any graph-mode overlay.
  removeGraphLayers();
  state.lastGraphResult = null;
  state.graphEnergyRaster = null;
  // Cache for live re-render on colormap / view / range changes.
  state.lastResult = {
    energy, passes, path, pathEnergy, pathLengthM, routes, elapsedMs,
    energyAlt: energyAlt || null,
    passesAlt: passesAlt || null,
    // Compare runs also carry the unconstrained best TERRAIN route (blue), shown
    // alongside / instead of the network route (orange) per the scenario picker.
    pathAlt: pathAlt || null,
    pathAltEnergy: pathAltEnergy ?? null,
    pathAltLengthM: pathAltLengthM ?? null,
  };

  // The displayed-scenario selector only makes sense after a compare run.
  const srcRow = document.getElementById("energy-source-row");
  if (srcRow) srcRow.style.display = (energyAlt || passesAlt) ? "" : "none";
  if (!energyAlt && !passesAlt) {
    const sel = document.getElementById("energy-source");
    if (sel) sel.value = "constrained";
  }

  // Auto bounds (state.lastAutoMin/Max and lastPassesAutoMin/Max) are
  // populated by renderFieldToDataURL during rerenderCachedResult below
  // — both layers use percentile clipping by default and the resolved
  // bounds come back from the renderer.

  // Show/hide the passes layer controls based on whether passes was computed
  const passesRow = document.getElementById("passes-row");
  if (passesRow) passesRow.style.display = passes ? "" : "none";

  rerenderCachedResult();

  const meta = [];
  // rerenderCachedResult populates state.lastAutoMax /
  // state.lastPassesAutoMax with the renderer's resolved upper bounds
  // (after percentile clipping etc.). Earlier code referenced bare
  // `autoMax` / `passesMax` here, which were never declared — left over
  // from a refactor that broke the metadata line silently until the
  // length-DP path actually triggered the renderer in a state that
  // exposed the unhandled exception.
  const eHi = state.lastAutoMax;
  if (Number.isFinite(eHi)) {
    meta.push(t("stats.max_e", eHi.toExponential(2)));
  }
  meta.push(t("stats.time", elapsedMs.toFixed(0)));
  if (passes) {
    const pHi = state.lastPassesAutoMax;
    if (Number.isFinite(pHi)) {
      meta.push(t("stats.max_passes", pHi.toExponential(2)));
    }
  }
  if (routes && routes.length) {
    meta.push(t("stats.routes_count", routes.length));
    for (let i = 0; i < routes.length; i++) {
      const r = routes[i];
      meta.push(
        `  ${i + 1}. E=<span class="v">${r.energy.toExponential(2)}</span>, ` +
        `L=<span class="v">${(r.length / 1000).toFixed(2)} km</span>` +
        (r.shared > 0 ? t("stats.shared", r.shared) : "")
      );
    }
    // Round mode: the round FIELD is fwd+bwd, but the A* alternatives are
    // still scored seed→goal only (by design) — say so, or the route
    // energies look inconsistent with the field. Prefer the run's OWN mode
    // (snapshotted by the caller) over the live #mode select, which the user
    // may have changed while this compute was still in flight — the DOM
    // fallback only matters for the bundle-restore path (applyMetadataToUI
    // sets the select from the bundle's params before rendering).
    if (((runMode ?? document.getElementById("mode")?.value) || "from") === "round") {
      meta.push(t("route.round_note"));
    }
  } else if (pathEnergy != null) {
    meta.push(t("stats.path_e", pathEnergy.toExponential(3)));
    meta.push(t("stats.length", (pathLengthM / 1000).toFixed(2)));
  }
  // Compare run: the unconstrained best terrain route, alongside the network one.
  if (pathAlt && pathAlt.length && pathAltEnergy != null) {
    meta.push(t("route.terrain_meta", pathAltEnergy.toExponential(3), (pathAltLengthM / 1000).toFixed(2)));
  }
  if (stringPulled) meta.push(t("stats.pulled"));
  resultMeta.innerHTML = meta.join("<br/>");
  resultMeta.removeAttribute("data-i18n"); // live stats — don't let a lang toggle reset to "—"

  // Accessibility KPIs: install (or clear) the pairwise-matrix cache OUTSIDE
  // state.lastResult — style re-renders must never touch it.
  installKpiResult(matrix || null, kpi || null, !!matrixOutdated);
}
