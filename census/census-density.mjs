#!/usr/bin/env node
// Headless population-weighted passes-density compute + bundle export for
// simujoules. Loads a geographic DEM GeoTIFF, converts a GeoJSON of sample
// points to DEM reference pixels, runs the SAME densityField engine the PWA
// uses (energy-worker.js, driven through its real onmessage handler), and
// writes an app-importable v3 bundle (.zip: metadata.jsonld + energy.tif +
// passes.tif). No browser. See census/README.md.
//
// Parity notes (mirrors app.js exactly):
//   - density workers receive dx/dy = dxM/dyM (METRES) for the cost model
//     (app.js baseMsg, ~app.js:2624);
//   - the worker takes a v2 `cost` bundle derived from the physics inputs —
//     deriveCost() below is the hand-kept mirror of app.js readCost();
//   - exported GeoTIFFs use NATIVE dx/dy + originX/originY (degrees) for
//     georeferencing (tiffMetadataForDem, ~app.js:4361);
//   - runDensity sends ONE `densityPartial: true` message and does what
//     app.js's pool merge does with a single slice: Float64 accumulators, the
//     second /N and the energySum/energyCount mean applied HERE (the engine
//     applies only the first /N — energy-worker.js ~2296, app.js ~7383).
//     test-census-density.mjs asserts this equals the engine's own
//     non-partial normalisation.
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { basename, dirname, join, resolve } from "path";
import * as GeoTIFF from "geotiff";
import JSZip from "jszip";

const here = dirname(fileURLToPath(import.meta.url));
const ENGINE = join(here, "..", "energy-worker.js");

// ---- engine shim: drive energy-worker.js like test-worker-pool.mjs ---------
export function loadWorker(enginePath = ENGINE) {
  const src = readFileSync(enginePath, "utf8");
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

// ---- v2 cost bundle: mirror of app.js flatEqSpeed() + readCost() ------------
// PURE MIRRORS of app.js's flatEqSpeed()/readCost() (physics inputs → kJ-based
// v2 cost bundle {aRoll, aAero, beta, climbThr, abRatio, epsOffset}), cribbed
// from test-energy-v2.mjs's deriveCost — the repo-root mirror of the same two
// originals. app.js is a browser module and can't be imported here; keep all
// three in step by hand (same rule as the test-water-raster.mjs mirrors).
// Clamps and defaults match readCost exactly (the app's UI defaults).
// G_SP — São Paulo's local gravity (IAG-USP absolute gravimetry), NOT the
// textbook 9.81. Mirrors app.js's G_SP; re-baselined in v63 (long note there).
const G_SP = 9.7864;
export function flatEqSpeed(P, m, crr, cda, rho, keff) {
  const a = crr * m * G_SP, b = 0.5 * rho * cda;
  let lo = 0, hi = 40;
  for (let k = 0; k < 60; k++) {
    const v = (lo + hi) / 2;
    const wheel = (a + b * v * v) * v;
    if (wheel < keff * P) lo = v; else hi = v;
  }
  return (lo + hi) / 2;
}
export function deriveCost(p = {}) {
  const num = (v, dflt) => (Number.isFinite(v) ? v : dflt);
  const m    = Math.max(1, num(p.mass, 75));
  const crr  = Math.max(0, num(p.crr, 0.008));
  const cda  = Math.max(0, num(p.cda, 0.45));
  const rho  = Math.max(0, num(p.rho, 1.1));    // ~750 m asl (São Paulo)
  const keff = Math.min(1, Math.max(0.1, num(p.keff, 0.97)));
  const pFlat = Math.max(1, num(p.pFlat, 80));  // W — rider power on the flat
  const vf   = flatEqSpeed(pFlat, m, crr, cda, rho, keff);  // m/s, derived
  const climbThr = Math.max(0, num(p.climbThrPct, 2)) / 100;  // % → grade
  const kSmooth = Math.min(1, Math.max(0, num(p.kSmooth, 1)));
  const g = G_SP, mg = m * g, KJ = 1000;   // local SP gravity — see G_SP above
  const aeroCoef = 0.5 * rho * cda * vf * vf;               // ½ρCdA·v_f² (J/ground-m, pre-/keff)
  return {
    aRoll: mg * crr / keff / KJ,
    aAero: aeroCoef / keff / KJ,
    beta: mg * kSmooth / keff / KJ,
    climbThr,
    abRatio: crr + aeroCoef / mg,   // un-smoothed flat-resistance grade (for ε); k_eff & kJ scale cancel
    epsOffset: 0.13,
  };
}

// ---- DEM load: port of app.js loadDemFromArrayBuffer (georef bits only) -----
// Mirrors the app's loader line for line where it affects numbers: band-0
// read (`samples: [0]` — a multi-band file would otherwise smear across the
// grid), f32-rounded GDAL_NODATA sentinel (heights are f32; an f64 parse of a
// non-f32-representable sentinel would silently not match), GeoKey-first CRS
// classification (GTModelTypeGeoKey wins over the magnitude heuristic), and
// the `simujaules:demSmoothSigmaM=` ImageDescription tag the app stamps on its
// own dem.tif exports (reported as `srcSmoothSigmaM`; the caller decides
// whether to pre-smooth — this loader never does, see mcp/lib.mjs).
export async function loadDem(demPath, label) {
  const file = readFileSync(demPath);
  const ab = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
  const tiff = await GeoTIFF.fromArrayBuffer(ab);
  const image = await tiff.getImage();
  const W = image.getWidth();
  const H = image.getHeight();
  const tiePoints = await image.getTiePoints();
  const fd = image.fileDirectory;
  const getTag = (t) => (fd.getValue ? fd.getValue(t) : fd[t]);
  const pixelScale = getTag("ModelPixelScale");
  if (!pixelScale || !tiePoints?.length) {
    throw new Error("DEM lacks geotransform metadata (ModelPixelScale / tie points).");
  }
  const dx = pixelScale[0], dy = pixelScale[1];
  const originX = tiePoints[0].x, originY = tiePoints[0].y;

  const raster = await image.readRasters({ samples: [0], interleave: true });
  const height = raster instanceof Float32Array ? raster : Float32Array.from(raster);

  const nodataRaw = getTag("GDAL_NODATA");
  const nodata = nodataRaw ? Math.fround(parseFloat(nodataRaw)) : null;
  const N = H * W;
  const mask = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const v = height[i];
    mask[i] = (Number.isFinite(v) && (nodata === null || v !== nodata)) ? 1 : 0;
  }

  let geoKeys = null;
  try { geoKeys = image.getGeoKeys ? image.getGeoKeys() : null; } catch { /* ignore */ }

  // Same CRS classification + degrees->metres flat-earth conversion as the app.
  const modelType = geoKeys && geoKeys.GTModelTypeGeoKey;
  const isGeographic =
    modelType === 2 ? true
      : modelType === 1 ? false
      : (Math.abs(originX) < 360 && Math.abs(originY) < 90 && dx < 0.01);
  const latRef = isGeographic ? originY - (H * dy) / 2 : 0;
  const dxM = isGeographic ? dx * 111320 * Math.cos((latRef * Math.PI) / 180) : dx;
  const dyM = isGeographic ? dy * 110574 : dy;

  const imgDescRaw = getTag("ImageDescription");
  const srcSmoothSigmaM = parseFloat((String(imgDescRaw || "").match(/simujaules:demSmoothSigmaM=([0-9.]+)/) || [])[1]) || 0;

  return {
    height, mask, H, W, dx, dy, dxM, dyM, originX, originY,
    isGeographic, geoKeys, nodata,
    bbox: { xmin: originX, ymin: originY - H * dy, xmax: originX + W * dx, ymax: originY },
    label: label || basename(demPath),   // the app records the File's name, never a path
    srcSmoothSigmaM,           // σ already baked into the file (app export tag), 0 = raw
    smoothSigmaM: 0,           // σ applied by this process (this loader applies none)
    smoothCumSigmaM: srcSmoothSigmaM,
  };
}

// lon/lat -> [row, col]; identical math to app.js latLngToPixel (geographic only).
export function lonLatToRC(dem, lng, lat) {
  if (!dem.isGeographic) return null;
  const col = Math.floor((lng - dem.originX) / dem.dx);
  const row = Math.floor((dem.originY - lat) / dem.dy);
  if (row < 0 || row >= dem.H || col < 0 || col >= dem.W) return null;
  return [row, col];
}

// GeoJSON Point features -> reference pixels. Drops points outside the extent
// or landing on nodata (mirrors addRefPoint's passability guard). Duplicates at
// the same cell are KEPT — they are the population weighting.
export function pointsToRefs(dem, features) {
  const refs = [];
  let outOfExtent = 0, onNodata = 0;
  for (const f of features) {
    const g = f?.geometry;
    if (!g || g.type !== "Point") continue;
    const [lng, lat] = g.coordinates;
    const rc = lonLatToRC(dem, lng, lat);
    if (!rc) { outOfExtent++; continue; }
    if (!dem.mask[rc[0] * dem.W + rc[1]]) { onNodata++; continue; }
    refs.push(rc);
  }
  return { refs, outOfExtent, onNodata };
}

// Compute the density field, reproducing app.js's pool path (densityField /
// computeDensityField, app.js:2782) with a single slice: send ONE
// `densityPartial` message and merge it into a Float64 accumulator, then apply
// the second /N. The engine's internal `density` is Float32 (energy-worker.js:
// 306); the app's exported `passes` is Float64 because the pool merges into
// one — so we must too, or the float64 passes.tif tag would be inconsistent
// with a Float32 buffer (a truncated, unreadable TIFF). Returns
// {energy: Float32Array, passes: Float64Array}, matching downloadBundle.
// `runFn` may be synchronous (the loadWorker shim) or return a Promise (the
// worker_threads runner in mcp/lib.mjs) — the result is awaited either way.
// `params.nDirs` (4|8|16|32|64|128) is forwarded when given; when omitted the
// message carries no nDirs and the engine's classic-8 default applies (the
// historical harness behaviour). `params.eMaxMode` ("leg" | "total") likewise.
export async function runDensity(dem, refs, params, runFn = loadWorker()) {
  const N = dem.H * dem.W;
  const msg = {
    kind: "run",
    H: dem.H, W: dem.W,
    dx: dem.dxM, dy: dem.dyM,                 // metres — matches app.js baseMsg
    seedR: refs[0]?.[0] ?? -1, seedC: refs[0]?.[1] ?? -1,
    goalR: -1, goalC: -1,
    mode: params.mode, densityMode: params.mode,
    cost: deriveCost(params),                 // v2 bundle, folded once like readCost
    eMax: params.eMax || 0, eMaxMode: params.eMaxMode || "leg",
    wantDensity: true,
    refPoints: refs,
    densityPartial: true,                     // raw accumulators (first /N only)
    maximize: false, maximizeLength: 0,
    height: new Float32Array(dem.height),
    mask: new Uint8Array(dem.mask),
  };
  if (params.nDirs != null) msg.nDirs = params.nDirs;
  const t0 = performance.now();
  const part = await runFn(msg);
  if (!part) throw new Error("engine returned no 'done' message");
  const passes = new Float64Array(N);
  for (let i = 0; i < N; i++) passes[i] = part.density[i] / N;   // second /N, in Float64
  const energy = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    energy[i] = part.energyCount[i] > 0 ? part.energySum[i] / part.energyCount[i] : Infinity;
  }
  return { energy, passes, elapsedMs: performance.now() - t0 };
}

// ---- bundle export: port of app.js tiffMetadataForDem / buildMetadata -------
export const SIMU_CONTEXT = {
  "@vocab": "https://telhas.pedalhidrografi.co/simujoules/vocab/simujoules.jsonld#",
  "schema": "https://schema.org/",
  "geo": "http://www.opengis.net/ont/geosparql#",
  "qudt": "http://qudt.org/schema/qudt/",
};

// Mirror of app.js tiffMetadataForDem, including its GTModelTypeGeoKey /
// GTRasterTypeGeoKey backfill (so QGIS/GDAL read our tifs as the app's).
export function tiffMetadataForDem(dem, sampleKind) {
  const { H, W, originX, originY, dx, dy, isGeographic, geoKeys } = dem;
  const bps = sampleKind === "float64" ? 64 : sampleKind === "uint8" ? 8 : 32;
  const sf = sampleKind === "uint8" ? 1 : 3;
  const md = {
    width: W, height: H,
    BitsPerSample: [bps], SampleFormat: [sf], SamplesPerPixel: [1],
    ModelTiepoint: [0, 0, 0, originX, originY, 0],
    ModelPixelScale: [Math.abs(dx), Math.abs(dy), 0],
  };
  if (geoKeys && Object.keys(geoKeys).length > 0) Object.assign(md, geoKeys);
  else if (isGeographic) md.GeographicTypeGeoKey = 4326;
  if (md.ProjectedCSTypeGeoKey && md.GTModelTypeGeoKey == null) md.GTModelTypeGeoKey = 1;
  else if (md.GeographicTypeGeoKey && md.GTModelTypeGeoKey == null) md.GTModelTypeGeoKey = 2;
  if (md.GTModelTypeGeoKey != null && md.GTRasterTypeGeoKey == null) md.GTRasterTypeGeoKey = 1;
  return md;
}

// `extraMd` is merged on top (app.js writeRasterAsGeoTIFF): the app tags
// energy.tif with GDAL_NODATA "inf" and dem.tif with GDAL_NODATA + the
// ImageDescription smoothing stamp.
export function writeRasterAsGeoTIFF(values, dem, sampleKind, extraMd) {
  const md = tiffMetadataForDem(dem, sampleKind);
  if (extraMd) Object.assign(md, extraMd);
  return GeoTIFF.writeArrayBuffer(values, md);
}
export const ENERGY_NODATA_MD = { GDAL_NODATA: "inf" };

export function buildMetadata(dem, refs, params, result) {
  return {
    "@context": SIMU_CONTEXT,
    "@type": "EnergyFieldComputation",
    "schema:dateCreated": params.timestamp ?? null,
    timestamp: params.timestamp ?? null,
    schemaVersion: 3,
    engine: "js",
    generator: "census-density.mjs",
    elapsedMs: result?.elapsedMs ?? null,
    dem: {
      label: dem.label || null,
      sourceUrl: null,
      H: dem.H, W: dem.W,
      originX: dem.originX, originY: dem.originY,
      dx: dem.dx, dy: dem.dy, dxM: dem.dxM, dyM: dem.dyM,
      isGeographic: dem.isGeographic,
    },
    params: {
      mode: params.mode,
      // v2 physics inputs, same property names app.js's buildMetadata()
      // writes so the app's bundle restore re-fills the UI knobs.
      // The cost bundle is re-derived from these on import (see deriveCost);
      // fall back to the same defaults deriveCost used for missing keys.
      mass: params.mass ?? 75, crr: params.crr ?? 0.008, cda: params.cda ?? 0.45,
      rho: params.rho ?? 1.1, keff: params.keff ?? 0.97, pFlat: params.pFlat ?? 80,
      kSmooth: params.kSmooth ?? 1, deadbandM: params.deadbandM ?? 2,
      climbThr: (params.climbThrPct ?? 2) / 100,   // bundle stores grade; CLI takes %
      eMax: params.eMax || 0,
      eMaxMode: "leg",
      src: null, dst: null,
      wantPasses: false, wantTopN: false, nRoutes: 3, penalty: 2,
      repulsionMode: "per-cell",
      wantDensity: true,
      nRefs: refs.length,
      refSource: "census",
      maximize: false, maximizeLength: 0,
      nDirs: params.nDirs ?? 8,   // what the run actually used (engine default when unset)
      // refPoints re-stamps the green markers on import.
      refPoints: refs.map(([r, c]) => [r, c]),
    },
    viz: {
      fieldColormap: "cmo_phase",
      routesColormap: "CET_R2",
      energy: { vmin: null, vmax: null, opacity: 0.85, visible: true },
      passes: {
        vmin: null, vmax: null, opacity: 0.85, visible: true,
        blend: "plus-lighter", gamma: 1, meanWindow: 1,
      },
    },
    network: { enabled: false },
    stats: { maxE: null, maxPasses: null, pathEnergy: null, pathLengthM: null },
    outputs: {
      energy: { format: "GeoTIFF", type: "Float32", shape: [dem.H, dem.W], file: "energy.tif" },
      passes: { format: "GeoTIFF", type: "Float64", shape: [dem.H, dem.W], file: "passes.tif" },
      network: null, routes: null, path: null,
    },
  };
}

// Zip entry names are the fixed ones the app's importer looks up. Optional
// `result.routesFC` / `result.pathFC` (GeoJSON FeatureCollections, see
// mcp/lib.mjs) become routes.geojson / path.geojson like downloadBundle.
// `encoded` may carry pre-encoded `energyTif` / `passesTif` Uint8Arrays so a
// caller that also writes loose tifs encodes each raster once (geotiff.js's
// encode is the slow part on big DEMs).
export async function writeBundle(outPath, dem, md, result, encoded = null) {
  const zip = new JSZip();
  zip.file("metadata.jsonld", JSON.stringify(md, null, 2));
  zip.file("energy.tif", encoded?.energyTif ?? new Uint8Array(writeRasterAsGeoTIFF(result.energy, dem, "float32", ENERGY_NODATA_MD)));
  zip.file("passes.tif", encoded?.passesTif ?? new Uint8Array(writeRasterAsGeoTIFF(result.passes, dem, "float64")));
  if (result.routesFC) zip.file("routes.geojson", JSON.stringify(result.routesFC, null, 2));
  if (result.pathFC) zip.file("path.geojson", JSON.stringify(result.pathFC, null, 2));
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  writeFileSync(outPath, buf);
  return buf.length;
}

// ---- CLI -------------------------------------------------------------------
// Cost knobs are the app's v2 PHYSICS inputs (defaults = the app's UI
// defaults); the folded {aRoll, aAero, beta, …} bundle is derived by
// deriveCost. deadbandM only rides in the metadata (the app's route
// evaluator uses it; the density engine doesn't).
function parseArgs(argv) {
  const a = {
    mode: "from",
    mass: 75, crr: 0.008, cda: 0.45, rho: 1.1, keff: 0.97, pFlat: 80,
    climbThrPct: 2, kSmooth: 1, deadbandM: 2,
    eMax: 0, out: "simujoules-census.zip",
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    switch (k) {
      case "--dem": a.dem = next(); break;
      case "--points": a.points = next(); break;
      case "--mode": a.mode = next(); break;          // from | to | round
      case "--mass": a.mass = parseFloat(next()); break;        // rider+bike kg
      case "--crr": a.crr = parseFloat(next()); break;          // rolling resistance
      case "--cda": a.cda = parseFloat(next()); break;          // drag area m²
      case "--rho": a.rho = parseFloat(next()); break;          // air density kg/m³
      case "--keff": a.keff = parseFloat(next()); break;        // drivetrain eff. 0.1–1
      case "--pflat": a.pFlat = parseFloat(next()); break;      // W on the flat
      case "--climb-thr": a.climbThrPct = parseFloat(next()); break;  // % grade
      case "--ksmooth": a.kSmooth = parseFloat(next()); break;  // 0–1 gravity smoothing
      case "--ndirs": {                                          // move directions (app default 16; CLI default 8)
        const v = parseInt(next(), 10);
        if (![4, 8, 16, 32, 64, 128].includes(v)) throw new Error("--ndirs must be one of 4, 8, 16, 32, 64, 128");
        a.nDirs = v; break;
      }
      case "--emax": a.eMax = parseFloat(next()); break;
      case "-o": case "--out": a.out = next(); break;
      case "-h": case "--help": a.help = true; break;
      case "--alpha": case "--beta": case "--eta":
        throw new Error(`${k} is gone (v1 cost model): use the physical knobs ` +
          "--mass/--crr/--cda/--rho/--keff/--pflat/--climb-thr/--ksmooth instead");
      default: throw new Error(`unknown arg: ${k}`);
    }
  }
  return a;
}

const USAGE =
  "Usage: node census-density.mjs --dem dem.tif --points points.geojson \\\n" +
  "         [--mode from] [--mass 75] [--crr 0.008] [--cda 0.45] [--rho 1.1] \\\n" +
  "         [--keff 0.97] [--pflat 80] [--climb-thr 2] [--ksmooth 1] [--ndirs 8] \\\n" +
  "         [--emax 0] [-o out.zip]\n" +
  "Cost knobs are the app's v2 physics inputs (defaults shown = app defaults);\n" +
  "the v1 --alpha/--beta/--eta flags were removed with the v2 cost model.";

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help || !a.dem || !a.points) {
    console.log(USAGE);
    process.exit(a.help ? 0 : 1);
  }
  console.error(`Loading DEM ${a.dem} ...`);
  const dem = await loadDem(resolve(a.dem));
  if (!dem.isGeographic) {
    throw new Error("DEM is not geographic (EPSG:4326). Only geographic DEMs are " +
      "supported, matching the app's coordinate conversion.");
  }
  console.error(`  ${dem.W} x ${dem.H} cells, origin ` +
    `${dem.originX.toFixed(4)}, ${dem.originY.toFixed(4)}`);

  const fc = JSON.parse(readFileSync(resolve(a.points), "utf8"));
  const { refs, outOfExtent, onNodata } = pointsToRefs(dem, fc.features || []);
  console.error(`Points: ${refs.length} kept, ${outOfExtent} outside extent, ` +
    `${onNodata} on nodata.`);
  if (!refs.length) throw new Error("No valid reference points inside the DEM extent.");

  console.error(`Computing density over ${refs.length} refs (mode=${a.mode}) ...`);
  const result = await runDensity(dem, refs, a);
  console.error(`  done in ${(result.elapsedMs / 1000).toFixed(1)}s`);

  const md = buildMetadata(dem, refs, { ...a, timestamp: new Date().toISOString() }, result);
  const bytes = await writeBundle(resolve(a.out), dem, md, result);
  console.error(`Wrote ${a.out} (${(bytes / 1e6).toFixed(1)} MB). ` +
    "Import it in the app over the SAME DEM to visualise.");
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
}
