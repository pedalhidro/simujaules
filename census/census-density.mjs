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
//   - exported GeoTIFFs use NATIVE dx/dy + originX/originY (degrees) for
//     georeferencing (tiffMetadataForDem, ~app.js:4361);
//   - a single non-partial density message returns {energy, passes} with both
//     /N normalisations already applied by the engine (energy-worker.js:1292).
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join, resolve } from "path";
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

// ---- DEM load: port of app.js loadDemFromArrayBuffer (georef bits only) -----
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

  const raster = await image.readRasters({ interleave: true });
  const height = raster instanceof Float32Array ? raster : Float32Array.from(raster);

  const nodataRaw = getTag("GDAL_NODATA");
  const nodata = nodataRaw ? parseFloat(nodataRaw) : null;
  const N = H * W;
  const mask = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const v = height[i];
    mask[i] = (Number.isFinite(v) && (nodata === null || v !== nodata)) ? 1 : 0;
  }

  // Same geographic heuristic + degrees->metres flat-earth conversion as the app.
  const isGeographic = Math.abs(originX) < 360 && Math.abs(originY) < 90 && dx < 0.01;
  const latRef = isGeographic ? originY - (H * dy) / 2 : 0;
  const dxM = isGeographic ? dx * 111320 * Math.cos((latRef * Math.PI) / 180) : dx;
  const dyM = isGeographic ? dy * 110574 : dy;

  let geoKeys = null;
  try { geoKeys = image.getGeoKeys ? image.getGeoKeys() : null; } catch { /* ignore */ }

  return {
    height, mask, H, W, dx, dy, dxM, dyM, originX, originY,
    isGeographic, geoKeys,
    bbox: { xmin: originX, ymin: originY - H * dy, xmax: originX + W * dx, ymax: originY },
    label: label || demPath,
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
export function runDensity(dem, refs, params, runFn = loadWorker()) {
  const N = dem.H * dem.W;
  const msg = {
    kind: "run",
    H: dem.H, W: dem.W,
    dx: dem.dxM, dy: dem.dyM,                 // metres — matches app.js baseMsg
    seedR: refs[0]?.[0] ?? -1, seedC: refs[0]?.[1] ?? -1,
    goalR: -1, goalC: -1,
    mode: params.mode, densityMode: params.mode,
    alpha: params.alpha, beta: params.beta, eta: params.eta,
    eMax: params.eMax || 0, eMaxMode: "leg",
    wantDensity: true,
    refPoints: refs,
    densityPartial: true,                     // raw accumulators (first /N only)
    maximize: false, maximizeLength: 0,
    height: new Float32Array(dem.height),
    mask: new Uint8Array(dem.mask),
  };
  const t0 = performance.now();
  const part = runFn(msg);
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
const SIMU_CONTEXT = {
  "@vocab": "https://telhas.pedalhidrografi.co/simujoules/vocab/simujoules.jsonld#",
  "schema": "https://schema.org/",
  "geo": "http://www.opengis.net/ont/geosparql#",
  "qudt": "http://qudt.org/schema/qudt/",
};

function tiffMetadataForDem(dem, sampleKind) {
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
  return md;
}

function writeRasterAsGeoTIFF(values, dem, sampleKind) {
  return GeoTIFF.writeArrayBuffer(values, tiffMetadataForDem(dem, sampleKind));
}

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
      alpha: params.alpha, beta: params.beta, eta: params.eta,
      eMax: params.eMax || 0,
      src: null, dst: null,
      wantPasses: false, wantTopN: false, nRoutes: 3, penalty: 2,
      repulsionMode: "per-cell",
      wantDensity: true,
      nRefs: refs.length,
      refSource: "census",
      maximize: false, maximizeLength: 0,
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

export async function writeBundle(outPath, dem, md, result) {
  const zip = new JSZip();
  zip.file("metadata.jsonld", JSON.stringify(md, null, 2));
  zip.file("energy.tif", new Uint8Array(writeRasterAsGeoTIFF(result.energy, dem, "float32")));
  zip.file("passes.tif", new Uint8Array(writeRasterAsGeoTIFF(result.passes, dem, "float64")));
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  writeFileSync(outPath, buf);
  return buf.length;
}

// ---- CLI -------------------------------------------------------------------
function parseArgs(argv) {
  const a = { mode: "from", alpha: 1, beta: 30, eta: 0.3, eMax: 0, out: "simujoules-census.zip" };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    switch (k) {
      case "--dem": a.dem = next(); break;
      case "--points": a.points = next(); break;
      case "--mode": a.mode = next(); break;          // from | to | round
      case "--alpha": a.alpha = parseFloat(next()); break;
      case "--beta": a.beta = parseFloat(next()); break;
      case "--eta": a.eta = parseFloat(next()); break;
      case "--emax": a.eMax = parseFloat(next()); break;
      case "-o": case "--out": a.out = next(); break;
      case "-h": case "--help": a.help = true; break;
      default: throw new Error(`unknown arg: ${k}`);
    }
  }
  return a;
}

const USAGE =
  "Usage: node census-density.mjs --dem dem.tif --points points.geojson \\\n" +
  "         [--mode from] [--alpha 1] [--beta 30] [--eta 0.3] [--emax 0] [-o out.zip]";

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
  const result = runDensity(dem, refs, a);
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
