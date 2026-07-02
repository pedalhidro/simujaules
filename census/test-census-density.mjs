// Self-contained end-to-end test for census-density.mjs. No IBGE data, no DEM
// file: it synthesises a tiny geographic GeoTIFF, hand-makes a points.geojson,
// runs the harness, and asserts:
//   1. lon/lat -> pixel conversion + extent/nodata filtering;
//   2. the harness's single-call density equals the app.js pooled-partial
//      merge of the SAME engine (the documented normalisation);
//   3. the exported bundle round-trips: zip opens, metadata.dem.H/W match
//      (the import-validation requirement), and energy/passes GeoTIFFs read
//      back bit-identical to the computed arrays.
// Run: node test-census-density.mjs   (needs `npm install` in census/ first)
import { writeFileSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as GeoTIFF from "geotiff";
import JSZip from "jszip";
import {
  loadDem, lonLatToRC, pointsToRefs, runDensity, loadWorker,
  buildMetadata, writeBundle, deriveCost,
} from "./census-density.mjs";

let failures = 0;
function assert(cond, label) {
  console.log(`  ${cond ? "✓" : "✗ FAIL:"} ${label}`);
  if (!cond) failures++;
}

const tmp = mkdtempSync(join(tmpdir(), "census-test-"));

// --- synthesise a tiny geographic DEM (São Paulo-ish origin) ----------------
const W = 64, H = 48;
const originX = -46.70, originY = -23.50;     // lon, lat of NW corner
const dx = 0.001, dy = 0.001;                 // ~100 m cells → isGeographic
const NODATA = -9999;
const height = new Float32Array(W * H);
for (let r = 0; r < H; r++)
  for (let c = 0; c < W; c++)
    height[r * W + c] =
      800 + 40 * Math.sin(r * 0.2) * Math.cos(c * 0.18) + 15 * Math.sin(c * 0.05 + r * 0.03);
for (let i = 7; i < W * H; i += 521) height[i] = NODATA;   // a few nodata holes

const demTiff = GeoTIFF.writeArrayBuffer(height, {
  width: W, height: H,
  BitsPerSample: [32], SampleFormat: [3], SamplesPerPixel: [1],
  ModelTiepoint: [0, 0, 0, originX, originY, 0],
  ModelPixelScale: [dx, dy, 0],
  GeographicTypeGeoKey: 4326,
  GDAL_NODATA: String(NODATA),
});
const demPath = join(tmp, "synthetic.tif");
writeFileSync(demPath, Buffer.from(demTiff));

// --- hand-made points: several inside, one well outside the extent ----------
// Place points at CELL CENTRES ((c+0.5)·dx) so floor() lands unambiguously in
// the intended cell, free of float-boundary effects (the same effect lives in
// app.js latLngToPixel; real census points never sit exactly on a cell edge).
const cell = (c, r) => [originX + (c + 0.5) * dx, originY - (r + 0.5) * dy];
const insideCells = [[10, 8], [30, 20], [50, 5], [5, 40], [45, 30], [20, 35]];
const inside = insideCells.map(([c, r]) => cell(c, r));
const outside = [originX + 500 * dx, originY - 500 * dy];     // far beyond extent
const fc = {
  type: "FeatureCollection",
  features: [...inside, outside].map(([lng, lat]) => ({
    type: "Feature", geometry: { type: "Point", coordinates: [lng, lat] }, properties: {},
  })),
};

const main = async () => {
  console.log("load DEM + georeference");
  const dem = await loadDem(demPath, "synthetic.tif");
  assert(dem.W === W && dem.H === H, `dims ${dem.W}x${dem.H}`);
  assert(dem.isGeographic === true, "detected geographic");
  assert(Math.abs(dem.dxM - dx * 111320 * Math.cos((originY - H * dy / 2) * Math.PI / 180)) < 1e-6,
    "dxM matches app flat-earth conversion");
  let nodataCount = 0;
  for (let i = 0; i < W * H; i++) if (!dem.mask[i]) nodataCount++;
  assert(nodataCount > 0, `nodata mask populated (${nodataCount} cells)`);

  console.log("lon/lat -> pixel conversion");
  assert(JSON.stringify(lonLatToRC(dem, ...cell(10, 8))) === "[8,10]",
    "interior cell-centre maps to [row=8, col=10]");
  assert(lonLatToRC(dem, ...outside) === null, "outside point returns null");

  console.log("points -> refs (extent + nodata filtering)");
  const { refs, outOfExtent, onNodata } = pointsToRefs(dem, fc.features);
  assert(outOfExtent === 1, `1 point dropped as out-of-extent (got ${outOfExtent})`);
  assert(refs.length === inside.length - onNodata, `kept ${refs.length} refs (${onNodata} on nodata)`);
  assert(refs.every(([r, c]) => dem.mask[r * dem.W + c] === 1), "all kept refs are passable");

  console.log("harness density matches the engine across code paths");
  // Non-default physics knobs so the comparison also proves the params flow
  // through deriveCost (the readCost mirror) rather than being ignored.
  const params = { mode: "from", mass: 80, pFlat: 100, eMax: 0 };
  const result = runDensity(dem, refs, params);   // partial-merge → Float64 passes
  assert(result.passes instanceof Float64Array && result.energy instanceof Float32Array,
    "returns Float64 passes + Float32 energy (matches downloadBundle's float64 passes.tif)");
  const run = loadWorker();
  const N = W * H;
  const baseMsg = {
    kind: "run", H, W, dx: dem.dxM, dy: dem.dyM,
    seedR: -1, seedC: -1, goalR: -1, goalC: -1,
    mode: "from", densityMode: "from", cost: deriveCost(params), eMax: 0, eMaxMode: "leg",
    wantDensity: true, maximize: false, maximizeLength: 0,
  };

  // (a) The worker's own non-partial path (Float32 passes, /N twice in f32) —
  //     a DIFFERENT code path from the harness. Agreement validates the
  //     normalisation, not just that the harness equals itself.
  const single = run({
    ...baseMsg, densityPartial: false, refPoints: refs,
    height: new Float32Array(dem.height), mask: new Uint8Array(dem.mask),
  });
  // (b) app.js's multi-worker pool: 3 partial slices merged in Float64, then /N.
  const density = new Float64Array(N), energySum = new Float64Array(N), energyCount = new Int32Array(N);
  const slices = 3;
  for (let p = 0; p < slices; p++) {
    const lo = Math.floor(p * refs.length / slices), hi = Math.floor((p + 1) * refs.length / slices);
    if (hi <= lo) continue;
    const part = run({
      ...baseMsg, densityPartial: true, refPoints: refs.slice(lo, hi),
      height: new Float32Array(dem.height), mask: new Uint8Array(dem.mask),
    });
    for (let i = 0; i < N; i++) { density[i] += part.density[i]; energySum[i] += part.energySum[i]; energyCount[i] += part.energyCount[i]; }
  }
  for (let i = 0; i < N; i++) density[i] /= N;

  let maxSingle = 0, maxPool = 0, maxE = 0;
  for (let i = 0; i < N; i++) {
    maxSingle = Math.max(maxSingle, Math.abs(result.passes[i] - single.passes[i]));
    maxPool = Math.max(maxPool, Math.abs(result.passes[i] - density[i]));
    const e = energyCount[i] > 0 ? energySum[i] / energyCount[i] : Infinity;
    if (Number.isFinite(e) !== Number.isFinite(result.energy[i])) maxE = Infinity;
    else if (Number.isFinite(e)) maxE = Math.max(maxE, Math.abs(e - result.energy[i]));
  }
  // f32 internal accumulation makes these differ by ~1e-11 at most (documented
  // in energy-worker.js:297), invisible under the gamma/percentile density render.
  assert(maxSingle < 1e-9, `passes match worker non-partial path (max|Δ| = ${maxSingle.toExponential(1)})`);
  assert(maxPool < 1e-9, `passes match 3-worker pool merge (max|Δ| = ${maxPool.toExponential(1)})`);
  assert(maxE < 1e-3, `energy matches pooled merge (max|Δ| = ${maxE.toExponential(1)})`);
  let posPasses = 0, negE = 0;
  for (let i = 0; i < N; i++) {
    if (result.passes[i] > 0) posPasses++;
    if (Number.isFinite(result.energy[i]) && result.energy[i] < 0) negE++;
  }
  assert(posPasses > 0, "density field is non-trivial");
  assert(negE === 0, "energies non-negative");

  console.log("bundle export round-trip");
  const md = buildMetadata(dem, refs, { ...params, timestamp: "2026-06-18T00:00:00.000Z" }, result);
  assert(md.dem.H === H && md.dem.W === W, "metadata.dem dims = DEM dims (import requires exact match)");
  assert(md.schemaVersion === 3 && md.params.wantDensity === true, "v3 density metadata");
  assert(md.params.mass === 80 && md.params.pFlat === 100 && md.params.crr === 0.008
    && md.params.climbThr === 0.02 && !("alpha" in md.params) && !("eta" in md.params),
    "v2 physics params recorded (app.js property names, no v1 alpha/eta)");
  assert(md.params.refPoints.length === refs.length, "refPoints persisted");
  const outPath = join(tmp, "out.zip");
  await writeBundle(outPath, dem, md, result);

  const zip = await JSZip.loadAsync(await (await import("fs/promises")).readFile(outPath));
  assert(!!zip.file("metadata.jsonld") && !!zip.file("energy.tif") && !!zip.file("passes.tif"),
    "zip has metadata + energy.tif + passes.tif");
  const md2 = JSON.parse(await zip.file("metadata.jsonld").async("string"));
  assert(md2.dem.H === H && md2.dem.W === W, "round-tripped metadata dims intact");

  const readTif = async (name, Kind) => {
    const ab = (await zip.file(name).async("nodebuffer")).buffer;
    const img = await (await GeoTIFF.fromArrayBuffer(ab)).getImage();
    assert(img.getWidth() === W && img.getHeight() === H, `${name} dims ${img.getWidth()}x${img.getHeight()}`);
    const tp = await img.getTiePoints();
    assert(Math.abs(tp[0].x - originX) < 1e-9 && Math.abs(tp[0].y - originY) < 1e-9,
      `${name} georeferenced to DEM origin`);
    const data = await img.readRasters({ interleave: true });
    return data instanceof Kind ? data : Kind.from(data);
  };
  const e2 = await readTif("energy.tif", Float32Array);
  const p2 = await readTif("passes.tif", Float64Array);
  let eExact = 0, pExact = 0;
  for (let i = 0; i < N; i++) {
    if (Number.isFinite(result.energy[i]) ? e2[i] !== result.energy[i] : Number.isFinite(e2[i])) eExact++;
    if (p2[i] !== result.passes[i]) pExact++;
  }
  assert(eExact === 0, `energy.tif bit-identical to computed field (${eExact} mismatches)`);
  assert(pExact === 0, `passes.tif bit-identical to computed field (${pExact} mismatches)`);

  console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
};

main().catch((e) => { console.error("ERROR:", e); process.exit(1); });
