// Self-contained test for the Simujaules MCP server. No DEM file needed: it
// synthesises small GeoTIFFs (like census/test-census-density.mjs), then
// asserts three layers, each against the SAME engine driven directly:
//   1. lib.mjs: the DEM load reproduces the app's pre-smoothing byte for byte
//      (raw load + smoothHeightsInPlace mirror ≡ loadDemSmoothed, tag guard,
//      explicit override), and the worker-thread runner is bit-identical to
//      the synchronous shim;
//   2. the server over real stdio: tools list, load_dem, energy_field,
//      energy_at, route (+ top-N, modes, budgets), density, error paths,
//      progress, one-compute-at-a-time, cancellation, projected / tagged /
//      coarse-geographic DEMs, --dem preload, argv validation, shutdown on
//      client disconnect — numbers compared to direct engine runs (energies
//      exact, since both are the same f32/f64 values of the same computation);
//   3. outputs on disk: the bundle opens, energy.tif is bit-identical to the
//      field, metadata carries src/dst and dem georeferencing, no viz block.
// Run: node test-mcp.mjs   (needs `npm install` in census/ AND mcp/)
import { writeFileSync, mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import * as GeoTIFF from "geotiff";
import JSZip from "jszip";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  loadDemSmoothed, loadDemInThread, buildRunMessage, runEngine, runDensity, cellCentre, loadWorker, fieldStats, fcForWire,
} from "./lib.mjs";
import { loadDem as loadDemRaw } from "../census/census-density.mjs";
import { smoothHeightsInPlace } from "../test-dem-smoothing.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SERVER = join(here, "server.mjs");
let failures = 0;
function assert(cond, label) {
  console.log(`  ${cond ? "✓" : "✗ FAIL:"} ${label}`);
  if (!cond) failures++;
}
const tmp = mkdtempSync(join(tmpdir(), "simujaules-mcp-"));

// --- fixtures ----------------------------------------------------------------------
const W = 64, H = 48;
const originX = -46.70, originY = -23.50;
const dx = 0.001, dy = 0.001;                  // ~100 m cells → geographic
const NODATA = -9999;
const height = new Float32Array(W * H);
for (let r = 0; r < H; r++)
  for (let c = 0; c < W; c++)
    height[r * W + c] = 800 + 40 * Math.sin(r * 0.2) * Math.cos(c * 0.18) + 15 * Math.sin(c * 0.05 + r * 0.03);
for (let i = 7; i < W * H; i += 521) height[i] = NODATA;
for (let r = 20; r < 28; r++) height[r * W + 33] = NODATA;   // a short wall to make routes bend
// geotiff's writeArrayBuffer consumes width/height from the object → factory.
const demMd = (extra = {}) => ({
  width: W, height: H,
  BitsPerSample: [32], SampleFormat: [3], SamplesPerPixel: [1],
  ModelTiepoint: [0, 0, 0, originX, originY, 0],
  ModelPixelScale: [dx, dy, 0],
  GeographicTypeGeoKey: 4326,
  GDAL_NODATA: String(NODATA),
  ...extra,
});
const writeTif = (name, values, md) => { const p = join(tmp, name); writeFileSync(p, Buffer.from(GeoTIFF.writeArrayBuffer(values, md))); return p; };
const demPath = writeTif("synthetic.tif", height, demMd());
// An app dem.tif export: same raster, tagged as already smoothed (decimal σ exercises the [0-9.]+ parse).
const taggedPath = writeTif("tagged.tif", height, demMd({ ImageDescription: "simujaules:demSmoothSigmaM=30.5" }));
// A projected DEM (SIRGAS 2000 / UTM 23S), 30 m cells, declared via GTModelTypeGeoKey = 1.
const projPath = writeTif("projected.tif", height, {
  width: W, height: H, BitsPerSample: [32], SampleFormat: [3], SamplesPerPixel: [1],
  ModelTiepoint: [0, 0, 0, 330000, 7400000, 0], ModelPixelScale: [30, 30, 0],
  ProjectedCSTypeGeoKey: 31983, GTModelTypeGeoKey: 1, GTRasterTypeGeoKey: 1, GDAL_NODATA: String(NODATA),
});
// A COARSE geographic DEM (0.05° cells — the magnitude heuristic would say projected) declared geographic.
const coarsePath = writeTif("coarse.tif", height, demMd({ ModelPixelScale: [0.05, 0.05, 0], GTModelTypeGeoKey: 2 }));
// A bigger grid for the long-compute tests (busy flag, cancel, disconnect).
const BW = 448, BH = 448;
const bigHeight = new Float32Array(BW * BH);
for (let r = 0; r < BH; r++)
  for (let c = 0; c < BW; c++)
    bigHeight[r * BW + c] = 700 + 60 * Math.sin(r * 0.05) * Math.cos(c * 0.04) + 25 * Math.sin(c * 0.11 + r * 0.07);
const bigPath = writeTif("big.tif", bigHeight, {
  width: BW, height: BH, BitsPerSample: [32], SampleFormat: [3], SamplesPerPixel: [1],
  ModelTiepoint: [0, 0, 0, originX, originY, 0], ModelPixelScale: [0.0002, 0.0002, 0],   // ~20 m cells
  GeographicTypeGeoKey: 4326,
});
const bigCentre = { lon: originX + 224.5 * 0.0002, lat: originY - 224.5 * 0.0002 };

const centre = (r, c) => { const [lon, lat] = cellCentre({ originX, originY, dx, dy }, r, c); return { lon, lat }; };
const countDiff = (a, b) => { let n = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && !(Number.isNaN(a[i]) && Number.isNaN(b[i]))) n++; return n; };

const SRC = [8, 10], DST = [30, 50];
const REFS = [[8, 10], [30, 50], [40, 5], [8, 10]];   // one duplicate = weight 2

// --- server helpers ----------------------------------------------------------------------
async function spawnServer(args = []) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER, ...args], stderr: "pipe" });
  const stderr = [];
  transport.stderr.on("data", (d) => stderr.push(String(d)));
  const client = new Client({ name: "simujaules-mcp-test", version: "0.0.1" });
  await client.connect(transport);
  const call = (name, args = {}, opts = {}) => client.callTool({ name, arguments: args }, undefined, { timeout: 120000, ...opts });
  return { client, transport, stderr, call };
}
const structured = (r) => r.structuredContent ?? JSON.parse(r.content[0].text.split("\n").pop());
const text = (r) => r.content[0].text;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const main = async () => {
  console.log("lib: DEM load + app pre-smoothing");
  const dem = await loadDemSmoothed(demPath, { label: "synthetic" });
  assert(dem.W === W && dem.H === H && dem.isGeographic, "dims + geographic");
  assert(dem.smoothSigmaM === 30 && dem.smoothCumSigmaM === 30, "auto rule applied σ 30 m on a raw file");
  {
    const raw = await loadDemRaw(demPath);
    smoothHeightsInPlace(raw.height, raw.mask, raw.H, raw.W, raw.dxM, raw.dyM, 30);
    assert(countDiff(raw.height, dem.height) === 0, "smoothed heights ≡ raw load + smoothHeightsInPlace mirror (0 mismatches)");
    const raw0 = await loadDemSmoothed(demPath, { smooth: 0 });
    const rawRef = await loadDemRaw(demPath);
    assert(countDiff(raw0.height, rawRef.height) === 0 && raw0.smoothSigmaM === 0, "smooth: 0 keeps the raw heights");
    assert(rawRef.label === "synthetic.tif", "default label is the file name, not the path");
    let nodataCells = 0; for (let i = 0; i < W * H; i++) if (!dem.mask[i]) nodataCells++;
    assert(nodataCells > 0 && Math.fround(NODATA) === dem.nodata, `nodata mask (${nodataCells} cells), sentinel f32-rounded`);
    // tag guard: an app export is not smoothed again under auto; an explicit σ overrides, cumulative in quadrature
    const tg = await loadDemSmoothed(taggedPath);
    assert(tg.smoothSigmaM === 0 && tg.srcSmoothSigmaM === 30.5 && tg.smoothCumSigmaM === 30.5 && countDiff(tg.height, rawRef.height) === 0,
      "auto rule skips an already-smoothed export (tag), heights untouched");
    const tg30 = await loadDemSmoothed(taggedPath, { smooth: 30 });
    assert(tg30.smoothSigmaM === 30 && Math.abs(tg30.smoothCumSigmaM - Math.hypot(30.5, 30)) < 1e-12 && countDiff(tg30.height, dem.height) === 0,
      "explicit σ overrides the tag guard (re-smooths), cumulative σ in quadrature");
    // thread loader ≡ in-process loader
    const stages = [];
    const td = await loadDemInThread(demPath, { label: "synthetic" }, { onStage: (s) => stages.push(s) });
    assert(countDiff(td.height, dem.height) === 0 && td.dxM === dem.dxM && td.smoothSigmaM === 30 && td.label === "synthetic",
      "DEM loaded in a worker thread ≡ in-process load");
    assert(JSON.stringify(stages) === JSON.stringify(["decode", "smooth"]), `thread load reports stages ${stages.join(",")}`);
  }

  console.log("lib: worker-thread runner ≡ synchronous shim");
  const shim = loadWorker();
  const runOpts = { mode: "from", seed: SRC, goal: DST, topN: 3, nDirs: 16 };
  const direct = shim(buildRunMessage(dem, runOpts));
  const threaded = await runEngine(buildRunMessage(dem, runOpts));
  assert(countDiff(direct.energy, threaded.energy) === 0, "energy bit-identical");
  assert(countDiff(direct.passes, threaded.passes) === 0, "passes bit-identical");
  assert(JSON.stringify(direct.path) === JSON.stringify(threaded.path) && direct.pathEnergy === threaded.pathEnergy,
    `path identical (${direct.path?.length} cells, ${direct.pathEnergy?.toFixed(3)} kJ)`);
  assert(direct.routes.length === threaded.routes.length &&
    direct.routes.every((r, i) => r.energy === threaded.routes[i].energy && JSON.stringify(r.path) === JSON.stringify(threaded.routes[i].path)),
    `top-N routes identical (${direct.routes.length})`);
  {
    const ac = new AbortController();
    const p = runEngine(buildRunMessage(dem, { mode: "round", seed: SRC }), { signal: ac.signal });
    ac.abort();
    let cancelled = false;
    try { await p; } catch (e) { cancelled = /cancel/.test(e.message); }
    assert(cancelled, "abort signal rejects the run");
    // wire thinning keeps endpoints and rounds coordinates; files are untouched
    const fc = { type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "LineString", coordinates: direct.path.map((i) => { const r = (i / W) | 0; return cellCentre(dem, r, i - r * W); }) }, properties: {} }] };
    const w = fcForWire(fc, { maxVertices: 10, decimals: 6 });
    const c = w.fc.features[0].geometry.coordinates;
    assert(w.decimated && w.step === Math.ceil(direct.path.length / 10) && c.length <= 10 + 1 && w.totalVertices === direct.path.length,
      `fcForWire thins ${w.totalVertices} → ${w.vertices} vertices (step ${w.step})`);
    const f0 = fc.features[0].geometry.coordinates, l = f0.length - 1;
    assert(c[0][0] === Number(f0[0][0].toFixed(6)) && c[c.length - 1][1] === Number(f0[l][1].toFixed(6)), "thinned line keeps first and last vertex, rounded to 6 decimals");
    assert(fc.features[0].geometry.coordinates.length === direct.path.length, "source FeatureCollection not mutated");
  }

  console.log("server over stdio");
  const { client, transport, stderr: stderrChunks, call } = await spawnServer();

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert(JSON.stringify(names) === JSON.stringify(["dem_info", "density", "energy_at", "energy_field", "load_dem", "route"]),
    `tools: ${names.join(", ")}`);
  const routeTool = tools.find((t) => t.name === "route");
  assert(routeTool.inputSchema.properties.nDirs?.default === 16 && routeTool.inputSchema.properties.mass?.default === 75 &&
    routeTool.inputSchema.properties.maxVertices?.default === 1500,
    "schema defaults match the app (nDirs 16, mass 75) + maxVertices 1500");

  let r = await call("energy_field", { point: centre(...SRC) });
  assert(r.isError === true && /load_dem/.test(text(r)), "compute before load_dem → isError");
  r = await call("dem_info");
  assert(structured(r).loaded === false, "dem_info before load → loaded:false");

  r = await call("load_dem", { path: demPath, label: "synthetic" });
  assert(!r.isError, "load_dem ok");
  const info = structured(r);
  assert(info.W === W && info.H === H && info.smoothing.appliedSigmaM === 30, `load_dem: ${info.W}x${info.H}, σ ${info.smoothing.appliedSigmaM}`);
  assert(Math.abs(info.cellSizeM.dx - dem.dxM) < 1e-9, "cell size in metres matches lib");
  assert(!text(r).includes("\n  "), "reply text is compact (no pretty-printed JSON)");

  // energy_field + energy_at vs a direct run with identical params.
  r = await call("energy_field", { point: centre(...SRC), mode: "from" });
  assert(!r.isError, "energy_field ok");
  const ef = structured(r);
  const directField = shim(buildRunMessage(dem, { mode: "from", seed: SRC, nDirs: 16 }));
  const directStats = fieldStats(directField.energy, directField.passes, dem.mask);
  assert(ef.stats.reachableCells === directStats.reachableCells && ef.stats.energyKJ.max === directStats.energyKJ.max,
    `field stats equal a direct run (${ef.stats.reachableCells} reachable, max ${ef.stats.energyKJ.max.toFixed(3)} kJ)`);
  assert(ef.files === null && /point→cell/.test(ef.direction), "no files without outDir; field-specific direction label");

  const probe = [[8, 10], [30, 50], [40, 5], [0, 0]];
  r = await call("energy_at", { points: probe.map(([rr, cc]) => centre(rr, cc)).concat([{ row: 12, col: 12 }, { lon: 0, lat: 0 }]) });
  assert(!r.isError, "energy_at ok");
  const ea = structured(r);
  assert(ea.samples[0].energyKJ === 0 && ea.samples[0].row === 8 && ea.samples[0].col === 10, "energy at the source is 0");
  assert(probe.every(([rr, cc], i) => {
    const s = ea.samples[i]; const e = directField.energy[rr * W + cc];
    return (Number.isFinite(e) ? s.energyKJ === e : s.energyKJ === null) && s.passes === directField.passes[rr * W + cc];
  }), "energy_at samples ≡ direct field values (energy + passes)");
  assert(ea.samples[4].row === 12 && ea.samples[4].col === 12, "row/col point form accepted");
  assert(typeof ea.samples[5].error === "string" && /outside/.test(ea.samples[5].error), "out-of-extent point reports an error, others still sampled");
  assert(ea.samples[0].elevationM === dem.height[8 * W + 10], "elevation is the smoothed DEM height");

  // round-trip budgets: leg vs total (energy_field), vs direct
  {
    const leg = structured(await call("energy_field", { point: centre(...SRC), mode: "round", eMax: 60 }));
    const tot = structured(await call("energy_field", { point: centre(...SRC), mode: "round", eMax: 60, eMaxMode: "total" }));
    assert(tot.stats.energyKJ.max <= 60 && leg.stats.energyKJ.max > 60 && tot.stats.reachableCells < leg.stats.reachableCells,
      "eMaxMode total caps the round-trip SUM, leg caps each leg (sums reach 2·eMax)");
    const dTot = shim(buildRunMessage(dem, { mode: "round", seed: SRC, eMax: 60, eMaxMode: "total", nDirs: 16 }));
    const dLeg = shim(buildRunMessage(dem, { mode: "round", seed: SRC, eMax: 60, eMaxMode: "leg", nDirs: 16 }));
    assert(tot.stats.reachableCells === fieldStats(dTot.energy, dTot.passes, dem.mask).reachableCells &&
      leg.stats.reachableCells === fieldStats(dLeg.energy, dLeg.passes, dem.mask).reachableCells, "both budget modes ≡ direct");
  }

  // route vs direct (same params: topN 3, defaults otherwise), with progress notifications.
  const outDir = join(tmp, "out");
  const progressEvents = [];
  r = await call("route", { from: centre(...SRC), to: centre(...DST), topN: 3, outDir, name: "test-route" }, { onprogress: (p) => progressEvents.push(p) });
  assert(!r.isError, "route ok");
  assert(progressEvents.length > 0 && progressEvents.every((p) => p.progress >= 0 && p.progress <= 1), `progress notifications received (${progressEvents.length})`);
  const rt = structured(r);
  assert(rt.reachable && rt.path.energyKJ === direct.pathEnergy && rt.path.lengthM === direct.pathLengthM,
    `route energy/length ≡ direct (${rt.path.energyKJ.toFixed(3)} kJ, ${rt.path.lengthM.toFixed(1)} m)`);
  assert(rt.routes.length === direct.routes.length && rt.routes.every((x, i) => x.energyKJ === direct.routes[i].energy && x.lengthM === direct.routes[i].length),
    `top-N energies ≡ direct (${rt.routes.length} routes)`);
  assert(rt.geojson?.type === "FeatureCollection" && rt.geojson.features.length === direct.routes.length &&
    rt.geojson.features[0].geometry.coordinates.length === direct.routes[0].path.length && rt.geometry.decimated === false,
    "GeoJSON routes: one LineString per route, one vertex per cell (within the vertex budget)");
  {
    const [lon0, lat0] = rt.geojson.features[0].geometry.coordinates[0];
    const c0 = cellCentre(dem, SRC[0], SRC[1]);
    assert(lon0 === Number(c0[0].toFixed(6)) && lat0 === Number(c0[1].toFixed(6)), "first vertex is the source cell CENTRE (6 decimals on the wire)");
  }
  assert(rt.files && existsSync(rt.files.bundle) && existsSync(rt.files.geojson) && existsSync(rt.files.energyTif),
    "route wrote bundle + geojson + energy tif");
  // wire budget: thinned inline, full in files
  r = await call("route", { from: centre(...SRC), to: centre(...DST), topN: 3, maxVertices: 10 });
  const rThin = structured(r);
  // every k-th vertex + the last one per line → at most budget + 2 per feature
  assert(!r.isError && rThin.geometry.decimated && rThin.geometry.vertices <= 10 + 2 * 3 && rThin.geometry.vertices < rThin.geometry.totalVertices / 4 &&
    rThin.geometry.totalVertices === rt.geometry.totalVertices && /thinned/.test(text(r)),
    `maxVertices thins the inline GeoJSON (${rThin.geometry.vertices} of ${rThin.geometry.totalVertices})`);
  // mode "to" + string pull, round, unreachable, bad inputs
  r = await call("route", { from: centre(...SRC), to: centre(...DST), mode: "to", stringPull: true, includeGeometry: false });
  const rTo = structured(r);
  assert(!r.isError && /destination→source/.test(rTo.direction) && rTo.geojson === undefined, "mode 'to': direction label, geometry omitted on request");
  const directTo = shim(buildRunMessage(dem, { mode: "to", seed: SRC, goal: DST, stringPull: true, nDirs: 16 }));
  assert(rTo.path.energyKJ === directTo.pathEnergy && rTo.path.stringPulled === !!directTo.stringPulled,
    `mode 'to' energy ≡ direct (${rTo.path.energyKJ.toFixed(3)} kJ, pulled=${rTo.path.stringPulled})`);
  r = await call("route", { from: centre(...SRC), to: centre(...DST), mode: "round", topN: 2, eMax: 1e9 });
  const rRound = structured(r);
  const directRound = shim(buildRunMessage(dem, { mode: "round", seed: SRC, goal: DST, topN: 2, eMax: 1e9, nDirs: 16 }));
  assert(!r.isError && rRound.path.energyKJ === directRound.pathEnergy && /round trip/.test(rRound.path.note) && /outbound/.test(rRound.routesNote),
    `round: energy ≡ direct (${rRound.path.energyKJ.toFixed(3)} kJ), path + routes notes present`);
  r = await call("route", { from: centre(...SRC), to: centre(...DST), eMax: 0.001 });
  assert(!r.isError && structured(r).reachable === false && structured(r).path === null, "tiny eMax → unreachable, not an error");
  r = await call("route", { from: { lon: 0, lat: 0 }, to: centre(...DST) });
  assert(r.isError === true && /outside the DEM extent/.test(text(r)), "point outside extent → isError with extent");
  r = await call("route", { from: centre(...SRC), to: centre(...DST), nDirs: 7 });
  assert(r.isError === true, "nDirs not in {4,8,16,32,64,128} → schema error");
  r = await call("route", { from: { row: 20, col: 33 }, to: centre(...DST) });
  assert(r.isError === true && /nodata/.test(text(r)), "point on nodata → isError");
  r = await call("route", { from: centre(...SRC), to: { lon: centre(...SRC).lon + dx * 0.2, lat: centre(...SRC).lat } });
  assert(r.isError === true && /same cell/.test(text(r)), "from/to collapsing into one cell → isError");

  // density vs direct harness.
  r = await call("density", { refs: REFS.map(([rr, cc]) => centre(rr, cc)).concat([{ lon: 0, lat: 0 }]), mode: "from", outDir, name: "test-density" });
  assert(!r.isError, "density ok");
  const dn = structured(r);
  const directDensity = await runDensity(dem, REFS, { mode: "from", nDirs: 16 });
  const dStats = fieldStats(directDensity.energy, directDensity.passes, dem.mask);
  assert(dn.nRefs === 4 && dn.droppedRefs === 1, "4 refs kept (duplicate counted), 1 dropped");
  assert(dn.stats.passesMax === dStats.passesMax && dn.stats.energyKJ.max === dStats.energyKJ.max,
    `density stats ≡ direct harness (max density ${dn.stats.passesMax.toExponential(3)})`);
  r = await call("energy_at", { points: [centre(8, 10), centre(30, 50)] });
  const eaD = structured(r);
  assert(eaD.field.tool === "density" && eaD.samples[0].passes === directDensity.passes[8 * W + 10] &&
    eaD.samples[1].energyKJ === directDensity.energy[30 * W + 50], "energy_at now samples the density field");
  assert(/density \d\.\d{3}e-\d+/.test(text(r)) && !/passes 0[,\n]/.test(text(r)) && /normalised density/.test(eaD.field.passesMeaning),
    "energy_at prints density values in exponent form, labelled as density");
  {
    const dnT = structured(await call("density", { refs: REFS.map(([rr, cc]) => centre(rr, cc)), mode: "round", eMax: 60, eMaxMode: "total" }));
    const directTot = await runDensity(dem, REFS, { mode: "round", eMax: 60, eMaxMode: "total", nDirs: 16 });
    const sT = fieldStats(directTot.energy, directTot.passes, dem.mask);
    assert(dnT.stats.energyKJ.max <= 60 && dnT.stats.reachableCells === sT.reachableCells && dnT.stats.energyKJ.max === sT.energyKJ.max,
      "density forwards eMaxMode total ≡ harness (census runDensity no longer hard-codes leg)");
  }

  // one compute at a time: a concurrent second call is refused, and the flag is released afterwards.
  {
    const [a, b] = await Promise.all([
      call("energy_field", { point: centre(...SRC), mode: "round", nDirs: 32 }),
      call("energy_field", { point: centre(...SRC) }),
    ]);
    const refused = [a, b].filter((x) => x.isError && /already running/.test(text(x)));
    assert(refused.length === 1 && [a, b].some((x) => !x.isError), "concurrent second compute refused (busy), first completes");
    r = await call("energy_field", { point: centre(...SRC) });
    assert(!r.isError, "compute works again after the refused call");
  }

  console.log("outputs on disk");
  {
    const zip = await JSZip.loadAsync(readFileSync(rt.files.bundle));
    const entries = Object.keys(zip.files).sort();
    assert(JSON.stringify(entries) === JSON.stringify(["energy.tif", "metadata.jsonld", "passes.tif", "path.geojson", "routes.geojson"]),
      `route bundle entries: ${entries.join(", ")}`);
    const md = JSON.parse(await zip.file("metadata.jsonld").async("string"));
    assert(md.dem.H === H && md.dem.W === W && md.dem.dx === dx && md.dem.originX === originX && md.dem.originY === originY && md.dem.label === "synthetic",
      "metadata.dem carries native georeferencing (bundleDemMatch inputs) + label");
    assert(JSON.stringify(md.params.src) === JSON.stringify(SRC) && JSON.stringify(md.params.dst) === JSON.stringify(DST) &&
      md.params.mode === "from" && md.params.nDirs === 16 && md.params.demSmooth === "auto" && md.params.demSmoothAppliedSigmaM === 30 && md.params.climbThr === 0.02,
      "metadata.params: src/dst [row, col], mode, nDirs, smoothing, climbThr as grade");
    assert(md.stats.pathEnergy === direct.pathEnergy && md.stats.pathLengthM === direct.pathLengthM, "metadata.stats path energy/length");
    assert(md.outputs.routes?.file === "routes.geojson" && md.outputs.path?.file === "path.geojson", "outputs descriptors");
    assert(md.viz === undefined && md.config === undefined, "headless bundle carries no viz/config block (import must not re-style the UI)");
    const readTif = async (buf, Kind) => {
      const t = await GeoTIFF.fromArrayBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
      const img = await t.getImage();
      const vals = await img.readRasters({ interleave: true });
      return { vals: vals instanceof Kind ? vals : Kind.from(vals), img };
    };
    const e = await readTif(await zip.file("energy.tif").async("nodebuffer"), Float32Array);
    const p = await readTif(await zip.file("passes.tif").async("nodebuffer"), Float64Array);
    assert(countDiff(e.vals, direct.energy) === 0, "energy.tif bit-identical to the field");
    assert(countDiff(p.vals, direct.passes) === 0, "passes.tif bit-identical (Float64)");
    const fd = e.img.fileDirectory;
    assert(String(fd.getValue("GDAL_NODATA")).startsWith("inf"), "energy.tif tagged GDAL_NODATA inf");
    const keys = e.img.getGeoKeys();
    assert(keys.GeographicTypeGeoKey === 4326 && keys.GTModelTypeGeoKey === 2 && keys.GTRasterTypeGeoKey === 1, "GeoKeys with the app's backfill");
    const loose = await readTif(readFileSync(rt.files.energyTif), Float32Array);
    assert(countDiff(loose.vals, direct.energy) === 0 && loose.img.getGeoKeys().GTModelTypeGeoKey === 2, "loose .energy.tif ≡ bundle raster, same georeferencing");
    const routesFC = JSON.parse(await zip.file("routes.geojson").async("string"));
    assert(routesFC.features[0].properties.energy === direct.routes[0].energy && routesFC.features[0].properties.rank === 1 &&
      routesFC.features[0].geometry.coordinates.length === direct.routes[0].path.length &&
      routesFC.features[0].geometry.coordinates[0][0] === cellCentre(dem, SRC[0], SRC[1])[0],
      "routes.geojson: properties, every vertex, full precision (never thinned)");
    const looseFC = JSON.parse(readFileSync(rt.files.geojson, "utf8"));
    assert(looseFC.features.length === direct.routes.length, "loose .geojson is the routes collection");
    const dz = await JSZip.loadAsync(readFileSync(dn.files.bundle));
    const dmd = JSON.parse(await dz.file("metadata.jsonld").async("string"));
    assert(dmd.params.wantDensity === true && dmd.params.refPoints.length === 4 && dmd.params.src === null, "density bundle metadata (refPoints, no src)");
  }

  console.log("other DEMs through the same server");
  {
    r = await call("load_dem", { path: taggedPath });
    const ti = structured(r);
    assert(!r.isError && ti.smoothing.appliedSigmaM === 0 && ti.smoothing.sourceSigmaM === 30.5 && ti.smoothing.cumulativeSigmaM === 30.5,
      "load_dem: tagged app export is not smoothed again (auto rule)");
    r = await call("load_dem", { path: demPath, smooth: 15 });
    assert(!r.isError && structured(r).smoothing.appliedSigmaM === 15 && structured(r).smoothing.selection === "15", "load_dem: explicit σ 15");
    r = await call("energy_field", { point: centre(...SRC), outDir, name: "sigma15" });
    const z15 = await JSZip.loadAsync(readFileSync(structured(r).files.bundle));
    const md15 = JSON.parse(await z15.file("metadata.jsonld").async("string"));
    assert(md15.params.demSmooth === null && md15.params.demSmoothAppliedSigmaM === 15,
      "off-menu σ → params.demSmooth null (won't blank the app's select), applied σ still recorded");
    r = await call("load_dem", { path: projPath });
    const pi = structured(r);
    assert(!r.isError && pi.isGeographic === false && pi.cellSizeM.dx === 30 && pi.cellSizeM.dy === 30 && /projected/.test(pi.crsUnits),
      "projected DEM: GTModelTypeGeoKey=1 wins, cell size = native metres");
    r = await call("route", { from: { lon: 330000 + 30 * 10.5, lat: 7400000 - 30 * 8.5 }, to: { row: 30, col: 50 }, outDir, name: "proj" });
    const pr = structured(r);
    assert(!r.isError && pr.from.row === 8 && pr.from.col === 10 && pr.reachable, "native-unit point resolves to the expected cell on a projected DEM");
    const projDem = await loadDemSmoothed(projPath);
    const projDirect = shim(buildRunMessage(projDem, { mode: "from", seed: [8, 10], goal: [30, 50], nDirs: 16 }));
    assert(pr.path.energyKJ === projDirect.pathEnergy && pr.geojson.features[0].geometry.coordinates[0][0] === Number((330000 + 30 * 10.5).toFixed(2)),
      "projected route ≡ direct; wire coordinates in metres (2 decimals)");
    const pz = await JSZip.loadAsync(readFileSync(pr.files.bundle));
    const pe = await GeoTIFF.fromArrayBuffer((await pz.file("energy.tif").async("nodebuffer")).buffer.slice(0));
    const pk = (await pe.getImage()).getGeoKeys();
    assert(pk.ProjectedCSTypeGeoKey === 31983 && pk.GTModelTypeGeoKey === 1 && pk.GTRasterTypeGeoKey === 1, "projected energy.tif keeps the projected GeoKeys");
    r = await call("load_dem", { path: coarsePath });
    const ci = structured(r);
    assert(!r.isError && ci.isGeographic === true && Math.abs(ci.cellSizeM.dy - 0.05 * 110574) < 1e-6,
      "declared GTModelTypeGeoKey=2 beats the magnitude heuristic on a coarse geographic DEM");
  }

  console.log("long computes: cancellation and disconnect");
  {
    r = await call("load_dem", { path: bigPath });
    assert(!r.isError && structured(r).W === BW, "big fixture loaded");
    const ac = new AbortController();
    const t0 = Date.now();
    const p = call("energy_field", { point: bigCentre, mode: "round", nDirs: 128 }, { signal: ac.signal });
    await sleep(300);
    ac.abort();
    let aborted = false;
    try { await p; } catch { aborted = true; }
    assert(aborted && Date.now() - t0 < 3000, "client abort rejects the call promptly");
    const t1 = Date.now();
    r = await call("energy_field", { point: bigCentre, nDirs: 8 });
    assert(!r.isError && Date.now() - t1 < 10000, "server free again after cancel (worker terminated, busy released)");
    // Disconnect while a compute runs: the server must exit on its own (stdin EOF), well inside the SDK's 2 s SIGTERM fallback.
    const p2 = call("energy_field", { point: bigCentre, mode: "round", nDirs: 128 });
    p2.catch(() => {});
    await sleep(300);
    const t2 = Date.now();
    await client.close();
    const closeMs = Date.now() - t2;
    assert(closeMs < 1500, `server exited on client disconnect mid-compute (${closeMs} ms, no SIGTERM needed)`);
    void transport;
  }
  const stderrText = stderrChunks.join("");
  assert(!/fatal|Unhandled|TypeError|ReferenceError|EPIPE/.test(stderrText), "server stderr has no crashes" + (stderrText ? ` (got: ${stderrText.slice(0, 200)})` : ""));

  console.log("startup: --dem preload and argv validation");
  {
    const s2 = await spawnServer(["--dem", demPath, "--smooth", "10"]);
    let di;
    for (let i = 0; i < 50; i++) { di = structured(await s2.call("dem_info")); if (di.loaded) break; await sleep(100); }
    assert(di.loaded === true && di.dem.W === W && di.dem.smoothing.appliedSigmaM === 10 && di.dem.smoothing.selection === "10", "--dem preloads, --smooth 10 applied");
    await s2.client.close();
    const s3 = await spawnServer(["--dem", join(tmp, "missing.tif")]);
    let di3;
    for (let i = 0; i < 30 && !s3.stderr.join("").includes("could not preload"); i++) await sleep(100);
    di3 = structured(await s3.call("dem_info"));
    assert(di3.loaded === false && /could not preload/.test(s3.stderr.join("")), "missing --dem: loud stderr line, server still answers");
    await s3.client.close();
    const bad = spawnSync(process.execPath, [SERVER, "--smooth", "abc"], { encoding: "utf8" });
    assert(bad.status === 1 && /--smooth/.test(bad.stderr), "--smooth abc → exit 1 with a message (never silently raw)");
    const dangling = spawnSync(process.execPath, [SERVER, "--dem"], { encoding: "utf8" });
    assert(dangling.status === 1 && /needs a value/.test(dangling.stderr), "dangling --dem → exit 1");
  }

  rmSync(tmp, { recursive: true, force: true });
  console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
};

main().catch((e) => { console.error("ERROR:", e); rmSync(tmp, { recursive: true, force: true }); process.exit(1); });
