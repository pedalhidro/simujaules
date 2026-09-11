// Headless Simujaules — the library behind mcp/server.mjs (and usable from
// node scripts directly). Everything that decides a NUMBER is imported from
// the existing hand-kept mirrors of app.js rather than copied a third time:
//   - census/census-density.mjs: loadDem (app-identical GeoTIFF read),
//     deriveCost (readCost mirror — carries its own hand-copied G_SP like the
//     other mirrors; see app.js's GRAVITY note / CLAUDE.md "grep 9.7864".
//     This file adds NO copy), loadWorker (sync engine shim), runDensity (the
//     app's pool merge with poolN = 1 — it builds its OWN run message, so a
//     new engine field must land there as well as in buildRunMessage below),
//     tiffMetadataForDem / writeRasterAsGeoTIFF / writeBundle;
//   - test-dem-smoothing.mjs: smoothHeightsInPlace (byte-identical mirror).
// What this file adds is the app's DEM-load smoothing rule, the run-message
// construction app.js does in baseMsg (no network / bridges / impassable
// layers — those stay browser-only for now), worker_threads runners for the
// engine and the DEM load, and the GeoJSON / bundle output shapes
// downloadBundle writes.
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import {
  loadDem as loadDemRaw, deriveCost, loadWorker,
  runDensity as runDensityHarness,
  writeBundle, writeRasterAsGeoTIFF, ENERGY_NODATA_MD, SIMU_CONTEXT,
} from "../census/census-density.mjs";
import { smoothHeightsInPlace } from "../test-dem-smoothing.mjs";

export { deriveCost, loadWorker, SIMU_CONTEXT };

const here = dirname(fileURLToPath(import.meta.url));
export const ENGINE_PATH = join(here, "..", "energy-worker.js");
const ENGINE_THREAD_PATH = join(here, "engine-thread.mjs");
const DEM_THREAD_PATH = join(here, "dem-thread.mjs");

// App UI defaults (index.html) — the physics inputs readCost() folds into the
// v2 cost bundle, plus the run knobs. nDirs 16 is the v64 default; 8 is the
// "fast" classic neighbourhood and the Rust-parity anchor.
export const DEFAULT_PHYSICS = Object.freeze({
  mass: 75, crr: 0.008, cda: 0.45, rho: 1.1, keff: 0.97, pFlat: 80, climbThrPct: 2, kSmooth: 1,
});
export const N_DIRS_ALLOWED = [4, 8, 16, 32, 64, 128];
export const DEFAULT_N_DIRS = 16;
export const AUTO_SMOOTH_SIGMA_M = 30;
// The app's #dem-smooth <select> options (index.html). Bundle metadata may
// only carry one of these as params.demSmooth: the importer assigns the value
// to the select unconditionally, and an off-menu value blanks it — after
// which the app's next DEM load silently applies NO smoothing.
export const DEM_SMOOTH_MENU = ["auto", "0", "10", "20", "30"];

// ---- DEM ---------------------------------------------------------------------
// app.js loadDemFromArrayBuffer's smoothing rule on top of the shared loader:
// "auto" = σ 30 m on every source unless the file already carries the
// `simujaules:demSmoothSigmaM=` tag (an app dem.tif export); an explicit σ
// overrides the guard (re-smooths even a tagged file, like the app's select).
// Runs in place BEFORE any engine sees the heights — never inside an engine.
// `onStage("decode" | "smooth")` fires at the two coarse boundaries (the
// smoothing mirror itself is never instrumented).
export async function loadDemSmoothed(path, { label, smooth = "auto", onStage } = {}) {
  onStage?.("decode");
  const dem = await loadDemRaw(path, label);
  const auto = smooth === "auto" || smooth == null;
  const sigma = auto
    ? (dem.srcSmoothSigmaM > 0 ? 0 : AUTO_SMOOTH_SIGMA_M)
    : Math.max(0, parseFloat(smooth) || 0);
  if (sigma > 0) {
    onStage?.("smooth");
    smoothHeightsInPlace(dem.height, dem.mask, dem.H, dem.W, dem.dxM, dem.dyM, sigma);
  }
  dem.smoothSel = auto ? "auto" : String(sigma);   // the #dem-smooth knob value, for bundle metadata
  dem.smoothSigmaM = sigma;
  dem.smoothCumSigmaM = Math.hypot(dem.srcSmoothSigmaM, sigma);   // Gaussians compose in quadrature
  dem.path = resolve(path);
  return dem;
}

// Same load, off the main thread (dem-thread.mjs). Resolves with the dem
// object (height/mask transferred back); rejects on error or abort.
export function loadDemInThread(path, { label, smooth = "auto" } = {}, { onStage, signal } = {}) {
  return new Promise((resolvePromise, reject) => {
    const worker = new Worker(DEM_THREAD_PATH, { workerData: { path: resolve(path), label, smooth } });
    let settled = false;
    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      worker.terminate().catch(() => {});
      fn(v);
    };
    const onAbort = () => finish(reject, new Error("DEM load cancelled"));
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    worker.on("message", (m) => {
      if (m?.kind === "stage") { onStage?.(m.stage); return; }
      if (m?.kind === "done") finish(resolvePromise, m.dem);
      else if (m?.kind === "error") finish(reject, new Error(m.message));
    });
    worker.on("error", (e) => finish(reject, e));
    worker.on("exit", (code) => {
      if (!settled) finish(reject, new Error(`DEM thread exited before answering (code ${code})`));
    });
  });
}

export function demSummary(dem) {
  let valid = 0, hMin = Infinity, hMax = -Infinity;
  for (let i = 0; i < dem.height.length; i++) {
    if (!dem.mask[i]) continue;
    valid++;
    const h = dem.height[i];
    if (h < hMin) hMin = h;
    if (h > hMax) hMax = h;
  }
  return {
    path: dem.path ?? null, label: dem.label ?? null,
    H: dem.H, W: dem.W, cells: dem.H * dem.W, validCells: valid,
    isGeographic: dem.isGeographic,
    crsUnits: dem.isGeographic ? "degrees (lon/lat)" : "projected CRS units",
    originX: dem.originX, originY: dem.originY, dx: dem.dx, dy: dem.dy,
    cellSizeM: { dx: dem.dxM, dy: dem.dyM },
    bbox: dem.bbox,
    nodata: dem.nodata,
    elevationM: valid ? { min: hMin, max: hMax } : null,
    smoothing: {
      selection: dem.smoothSel ?? "auto",
      appliedSigmaM: dem.smoothSigmaM ?? 0,
      sourceSigmaM: dem.srcSmoothSigmaM ?? 0,
      cumulativeSigmaM: dem.smoothCumSigmaM ?? 0,
    },
  };
}

// ---- coordinates ----------------------------------------------------------------
// Same conventions as app.js: a coordinate maps to a cell by FLOOR on the
// corner-based grid (latLngToPixel); a cell maps back to its CENTRE
// (pixelToLonLat, +0.5). Native CRS units — lon/lat on a geographic DEM.
export function pointToRC(dem, x, y) {
  const col = Math.floor((x - dem.originX) / dem.dx);
  const row = Math.floor((dem.originY - y) / dem.dy);
  if (!Number.isFinite(row) || !Number.isFinite(col)) return null;
  if (row < 0 || row >= dem.H || col < 0 || col >= dem.W) return null;
  return [row, col];
}
export function cellCentre(dem, r, c) {
  return [dem.originX + (c + 0.5) * dem.dx, dem.originY - (r + 0.5) * dem.dy];
}
export function idxToLonLat(dem, idx) {
  const r = (idx / dem.W) | 0;
  const c = idx - r * dem.W;
  return cellCentre(dem, r, c);
}

// A tool point is {lon, lat} (CRS units) or {row, col} (pixel). Returns
// [row, col] or throws a descriptive error — mirrors the app's click guards
// (outside the extent, or on a nodata cell, are rejected).
export function resolvePoint(dem, pt, what = "point") {
  let rc;
  if (pt && Number.isFinite(pt.row) && Number.isFinite(pt.col)) {
    const r = pt.row | 0, c = pt.col | 0;
    if (r < 0 || r >= dem.H || c < 0 || c >= dem.W) {
      throw new Error(`${what}: row/col [${r}, ${c}] is outside the ${dem.H}x${dem.W} grid`);
    }
    rc = [r, c];
  } else if (pt && Number.isFinite(pt.lon) && Number.isFinite(pt.lat)) {
    rc = pointToRC(dem, pt.lon, pt.lat);
    if (!rc) {
      const b = dem.bbox;
      throw new Error(`${what}: (${pt.lon}, ${pt.lat}) is outside the DEM extent ` +
        `x ${b.xmin}..${b.xmax}, y ${b.ymin}..${b.ymax}`);
    }
  } else {
    throw new Error(`${what}: give either {lon, lat} or {row, col}`);
  }
  if (!dem.mask[rc[0] * dem.W + rc[1]]) {
    throw new Error(`${what}: cell [${rc[0]}, ${rc[1]}] is nodata (impassable)`);
  }
  return rc;
}

// ---- engine runner (worker thread) ------------------------------------------------
// One Worker per compute, like the app. `height`/`mask`/`networkMask`
// buffers are TRANSFERRED (zero-copy) — always hand it fresh copies, which
// buildRunMessage and runDensity both do. Resolves with the engine's `done`
// message (typed arrays intact), rejects on its `error` message, a thread
// crash, or abort. Progress (0..1) is forwarded to `onProgress`.
export function runEngine(msg, { onProgress, onWarning, signal } = {}) {
  return new Promise((resolvePromise, reject) => {
    const worker = new Worker(ENGINE_THREAD_PATH, { workerData: { enginePath: ENGINE_PATH } });
    let settled = false;
    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      worker.terminate().catch(() => {});
      fn(v);
    };
    const onAbort = () => finish(reject, new Error("compute cancelled"));
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    worker.on("message", (m) => {
      if (m?.kind === "progress") { onProgress?.(m.progress); return; }
      if (m?.kind === "warning") { onWarning?.(m); return; }
      if (m?.kind === "done") finish(resolvePromise, m);
      else if (m?.kind === "error") finish(reject, new Error("engine error: " + m.message));
    });
    worker.on("error", (e) => finish(reject, e));
    worker.on("exit", (code) => {
      if (!settled) finish(reject, new Error(`engine thread exited before answering (code ${code})`));
    });
    const transfer = [];
    for (const k of ["height", "mask", "networkMask"]) {
      if (msg[k] && msg[k].buffer instanceof ArrayBuffer) transfer.push(msg[k].buffer);
    }
    try { worker.postMessage(msg, transfer); }
    catch (e) { finish(reject, e); }   // e.g. an uncloneable field — don't leak the Worker
  });
}

// ---- single-source run (from / to / round, optional goal + top-N) ----------------
// Mirror of app.js baseMsg + startSingleWorker's `{ ...baseMsg, height, mask,
// networkMask }` for a run with NO network constraint, NO bridges and NO
// impassable/drawn layers (those are the only app inputs missing here).
// Like the app it permits seed === goal; callers that need two distinct
// cells (a LineString) guard for it themselves.
export function buildRunMessage(dem, opts) {
  const {
    mode = "from", seed, goal = null,
    physics = {}, eMax = 0, eMaxMode = "leg", nDirs = DEFAULT_N_DIRS,
    topN = 0, penalty = 2.0, repulsionMode = "per-cell", stringPull = false,
  } = opts;
  if (!["from", "to", "round"].includes(mode)) throw new Error(`mode must be from | to | round (got ${mode})`);
  if (!seed) throw new Error("seed [row, col] is required");
  const nDirsEff = N_DIRS_ALLOWED.includes(nDirs | 0) ? (nDirs | 0) : 8;   // app.js: invalid → 8
  const wantTopN = topN > 0;
  if (wantTopN && !goal) throw new Error("top-N routes need a destination");
  return {
    kind: "run",
    H: dem.H, W: dem.W,
    dx: dem.dxM, dy: dem.dyM,                         // METRES — the cost model's units
    seedR: seed[0], seedC: seed[1],
    goalR: goal ? goal[0] : -1, goalC: goal ? goal[1] : -1,
    mode,
    cost: deriveCost({ ...DEFAULT_PHYSICS, ...physics }),
    eMax: eMax > 0 ? eMax : 0,
    eMaxMode: eMaxMode === "total" ? "total" : "leg",
    wantPasses: true,                                 // always, like the app since v68
    wantTopN,
    nRoutes: Math.max(1, Math.min(20, topN | 0)),
    penalty: Math.max(0, penalty || 2.0),
    repulsionMode: ["per-cell", "linear", "square"].includes(repulsionMode) ? repulsionMode : "per-cell",
    wantDensity: false,
    refPoints: null,
    densityMode: mode,
    wantNetworkInterp: false, interpMaxDistance: 50, interpSmoothing: 0,
    maximize: false, maximizeLength: 0,
    nDirs: nDirsEff,
    stringPull: !!stringPull,
    portalU: null, portalV: null, portalLenM: null, portalHU: null, portalHV: null,
    height: new Float32Array(dem.height),
    mask: new Uint8Array(dem.mask),
    networkMask: null,
  };
}

// ---- multi-reference density ----------------------------------------------------
// The app's pool merge with a single slice (census runDensity), run in the
// worker thread. refs: [[r, c], …] (duplicates are weights, like census).
export function runDensity(dem, refs, opts, engineOpts) {
  const { mode = "from", physics = {}, eMax = 0, eMaxMode = "leg", nDirs = DEFAULT_N_DIRS } = opts;
  if (!["from", "to", "round"].includes(mode)) throw new Error(`mode must be from | to | round (got ${mode})`);
  const params = {
    mode, ...DEFAULT_PHYSICS, ...physics,
    eMax: eMax > 0 ? eMax : 0,
    eMaxMode: eMaxMode === "total" ? "total" : "leg",
    nDirs: N_DIRS_ALLOWED.includes(nDirs | 0) ? (nDirs | 0) : 8,
  };
  return runDensityHarness(dem, refs, params, (msg) => runEngine(msg, engineOpts));
}

// ---- result summaries ------------------------------------------------------------
export function fieldStats(energy, passes, mask) {
  const N = energy.length;
  let valid = 0, reachable = 0, sumE = 0, maxE = -Infinity, maxP = 0;
  for (let i = 0; i < N; i++) {
    if (mask && !mask[i]) continue;
    valid++;
    const e = energy[i];
    if (Number.isFinite(e)) { reachable++; sumE += e; if (e > maxE) maxE = e; }
    if (passes) { const p = passes[i]; if (p > maxP) maxP = p; }
  }
  // Percentiles over a deterministic stride sample (≤ 200 k finite values) —
  // enough for a summary, bounded on 100 M-cell DEMs.
  const stride = Math.max(1, Math.ceil(reachable / 200000));
  const sample = [];
  for (let i = 0, k = 0; i < N; i++) {
    const e = energy[i];
    if (!Number.isFinite(e) || (mask && !mask[i])) continue;
    if (k++ % stride === 0) sample.push(e);
  }
  sample.sort((a, b) => a - b);
  const q = (p) => sample.length ? sample[Math.min(sample.length - 1, Math.floor(p * (sample.length - 1)))] : null;
  return {
    cells: N, validCells: valid, reachableCells: reachable,
    reachableFraction: valid ? reachable / valid : 0,
    energyKJ: reachable ? { mean: sumE / reachable, p50: q(0.5), p80: q(0.8), p95: q(0.95), max: maxE } : null,
    passesMax: passes ? maxP : null,
  };
}

// What a FIELD's energy means per mode (the route label below is for
// LineStrings and talks about coordinate order, which a field has none of).
export function fieldDirectionLabel(mode, tool) {
  const density = tool === "density";
  const anchor = density ? "the reference points" : "the point";
  const short = density ? "refs" : "point";
  const tail = density ? "; per-cell mean over the refs that reach it" : "";
  if (mode === "to") return `cell→${short}: energy to reach ${anchor} from each cell${tail}`;
  if (mode === "round") return `${short}→cell→${short}: round trip, both legs summed${tail}`;
  return `${short}→cell: energy to ride from ${anchor} to each cell${tail}`;
}

// ---- GeoJSON (mirror of app.js pathFCFromIndices / routesFCFromList) ------------
// Full-precision cell centres, exactly what the app's own bundle export writes
// (the importer re-floors them to cells). Never round or thin here — see
// fcForWire for the response copy.
export function routeDirectionLabel(mode) {
  return mode === "to"
    ? "destination→source (energy direction; coordinates written source→destination)"
    : "source→destination";
}
export function pathFCFromIndices(path, dem, props = {}, mode) {
  return {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      geometry: { type: "LineString", coordinates: path.map((i) => idxToLonLat(dem, i)) },
      properties: { ...props, direction: routeDirectionLabel(mode) },
    }],
  };
}
export function routesFCFromList(routes, dem, mode) {
  return {
    type: "FeatureCollection",
    features: routes.map((r, i) => ({
      type: "Feature",
      geometry: { type: "LineString", coordinates: r.path.map((idx) => idxToLonLat(dem, idx)) },
      properties: {
        rank: i + 1, energy: r.energy, length_m: r.length, shared_cells: r.shared,
        direction: routeDirectionLabel(mode),
      },
    })),
  };
}

// The copy of a FeatureCollection that goes on the MCP wire: coordinates
// rounded (6 decimals ≈ 0.1 m on a geographic DEM; 2 in projected metres) and
// thinned to a vertex budget — every k-th vertex plus the last one of each
// line — so a 20-route answer cannot blow the 10 MB stdio frame or a model's
// context. Files on disk are never touched by this.
export function fcForWire(fc, { maxVertices = 1500, decimals = 6 } = {}) {
  if (!fc) return { fc: null, vertices: 0, totalVertices: 0, decimated: false, step: 1 };
  const total = fc.features.reduce((n, f) => n + f.geometry.coordinates.length, 0);
  const step = total > maxVertices ? Math.ceil(total / maxVertices) : 1;
  const rnd = (v) => Number(v.toFixed(decimals));
  const features = fc.features.map((f) => {
    const c = f.geometry.coordinates;
    const kept = [];
    for (let i = 0; i < c.length; i += step) kept.push(c[i]);
    if (c.length > 1 && (c.length - 1) % step !== 0) kept.push(c[c.length - 1]);
    return { ...f, geometry: { type: f.geometry.type, coordinates: kept.map(([x, y]) => [rnd(x), rnd(y)]) } };
  });
  const vertices = features.reduce((n, f) => n + f.geometry.coordinates.length, 0);
  return { fc: { ...fc, features }, vertices, totalVertices: total, decimated: step > 1, step };
}

// ---- bundle metadata (the app-importable metadata.jsonld) -------------------------
// Shape follows app.js buildMetadata for everything the importer reads
// (dem block for bundleDemMatch, params.src/dst/refPoints/mode/physics,
// stats.pathEnergy/pathLengthM, outputs). Deliberately ABSENT: `config` and
// `viz` — both optional to the importer (`md.viz || {}`, per-layer guards),
// and a headless run makes no style decisions; shipping values would
// overwrite the user's colormap/opacity/mean-window knobs on import and then
// be persisted by their next change. Don't "restore parity" by adding them.
export function buildBundleMetadata(dem, run, result) {
  const p = { ...DEFAULT_PHYSICS, ...(run.physics || {}) };
  const ts = new Date().toISOString();
  const refPoints = Array.isArray(run.refPoints) ? run.refPoints.map(([r, c]) => [r, c]) : [];
  const nDirs = N_DIRS_ALLOWED.includes(run.nDirs | 0) ? (run.nDirs | 0) : 8;   // what buildRunMessage actually ran
  return {
    "@context": SIMU_CONTEXT,
    "@type": "EnergyFieldComputation",
    "schema:dateCreated": ts,
    timestamp: ts,
    schemaVersion: 3,
    engine: "js",
    generator: "simujaules-mcp",
    elapsedMs: result?.elapsedMs ?? null,
    dem: {
      label: dem.label || null, sourceUrl: null,
      H: dem.H, W: dem.W,
      originX: dem.originX, originY: dem.originY,
      dx: dem.dx, dy: dem.dy, dxM: dem.dxM, dyM: dem.dyM,
      isGeographic: dem.isGeographic,
    },
    params: {
      mode: run.mode,
      mass: p.mass, crr: p.crr, cda: p.cda, rho: p.rho, keff: p.keff, pFlat: p.pFlat,
      kSmooth: p.kSmooth, deadbandM: 2,
      // Only a value the app's select offers; null leaves the knob alone on
      // import (demSmoothAppliedSigmaM still records the truth).
      demSmooth: DEM_SMOOTH_MENU.includes(dem.smoothSel) ? dem.smoothSel : null,
      demSmoothAppliedSigmaM: dem.smoothSigmaM ?? 0,
      climbThr: p.climbThrPct / 100,                  // bundle stores the grade fraction
      eMax: run.eMax || 0,
      eMaxMode: run.eMaxMode || "leg",
      src: run.src ?? null, dst: run.dst ?? null,   // [row, col] pairs
      wantPasses: true,
      wantTopN: !!run.topN, nRoutes: run.topN || 3,
      penalty: run.penalty ?? 2.0,
      repulsionMode: run.repulsionMode || "per-cell",
      wantDensity: !!run.wantDensity,
      nRefs: refPoints.length || 10,
      refSource: run.refSource || "random",
      maximize: false, maximizeLength: 0,
      nDirs,
      stringPull: !!run.stringPull,
      kpiCorr: 1,
      refPoints,
    },
    network: { enabled: false },
    stats: {
      maxE: null, maxPasses: null,                    // the app's legend bounds — not reproduced
      pathEnergy: result?.pathEnergy ?? null,
      pathLengthM: result?.pathLengthM ?? null,
    },
    outputs: {
      energy: { format: "GeoTIFF", type: "Float32", shape: [dem.H, dem.W], file: "energy.tif" },
      passes: { format: "GeoTIFF", type: "Float64", shape: [dem.H, dem.W], file: "passes.tif" },
      network: null,
      routes: result?.routes?.length ? { format: "GeoJSON", file: "routes.geojson" } : null,
      path: result?.path?.length ? { format: "GeoJSON", file: "path.geojson" } : null,
    },
  };
}

// ---- outputs on disk -------------------------------------------------------------
// Writes <outDir>/<base>.zip (app-importable bundle) plus loose
// <base>.energy.tif / <base>.passes.tif (QGIS-ready, same georeferencing) and
// <base>.geojson (routes, else the single path) when there is one. Each
// raster is encoded ONCE and shared between the zip and the loose file.
export async function writeRunOutputs(outDir, base, dem, md, result, { pathFC = null, routesFC = null } = {}) {
  mkdirSync(outDir, { recursive: true });
  const safe = String(base).replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "") || "simujaules";
  const files = {};
  const energyTif = new Uint8Array(writeRasterAsGeoTIFF(result.energy, dem, "float32", ENERGY_NODATA_MD));
  const passesTif = result.passes ? new Uint8Array(writeRasterAsGeoTIFF(result.passes, dem, "float64")) : null;
  files.energyTif = join(outDir, `${safe}.energy.tif`);
  writeFileSync(files.energyTif, energyTif);
  if (passesTif) {
    files.passesTif = join(outDir, `${safe}.passes.tif`);
    writeFileSync(files.passesTif, passesTif);
  }
  const fc = routesFC || pathFC;
  if (fc) {
    files.geojson = join(outDir, `${safe}.geojson`);
    writeFileSync(files.geojson, JSON.stringify(fc, null, 2));
  }
  files.bundle = join(outDir, `${safe}.zip`);
  await writeBundle(files.bundle, dem, md, { ...result, pathFC, routesFC }, { energyTif, passesTif });
  return files;
}
