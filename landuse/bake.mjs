#!/usr/bin/env node
// Land-use simulation bake: FABDEM + MapBiomas + IBGE census → compact grid
// layers for landuse/index.html. Dev tooling (like census/ and mcp/), never
// deployed with the app. See landuse/README.md.
//
//   node bake.mjs tiles       download the FABDEM 1°×1° tiles of the study
//                             area into cache/fabdem/ (~420 MB, once)
//   node bake.mjs dem         FABDEM mosaic → σ30 smoothing (the app's auto
//                             rule) → full-res slope classes and north-facing
//                             counts aggregated to the 6″ output grid
//   node bake.mjs landcover   MapBiomas Col. 9 (2023) grouped fractions
//   node bake.mjs hydro       walls + forced lake outlet (Billings) →
//                             priority-flood/D8 → accumulation → HAND →
//                             watersheds at the Rasgão and Volta Redonda outlets
//   node bake.mjs census      IBGE 2022 setores → population + state codes
//   node bake.mjs export      basins (Paraíba clipped to SP) + reservoirs and
//                             their catchments → PNG layers in landuse/data/
//   node bake.mjs report      the gentle-land table (km² by cover × slope)
//   node bake.mjs all         every stage in order
//
// Stages cache their arrays in landuse/cache/ (gitignored), so later stages
// re-run without re-downloading; MapBiomas and the census FGB are read over
// HTTP Range. landuse/data/ is the page's input and is gitignored too —
// re-bake it, or take it from the published page.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join, resolve } from "path";
import * as GeoTIFF from "geotiff";
import { smoothHeightsInPlace } from "../test-dem-smoothing.mjs";
import {
  makeGrid, priorityFloodD8, topoOrder, receiverOf, encodePng, NO_DIR, R_EARTH_M, D8_DR, D8_DC,
} from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const CACHE = join(here, "cache");
const DATA = join(here, "data");
const FABDEM_DIR = join(CACHE, "fabdem");

// ---- study area -------------------------------------------------------------
// Alto Tietê (UGRHI-6) + the São Paulo part of the Paraíba do Sul (UGRHI-2),
// with margin. East reaches past Volta Redonda (RJ) so the Paraíba watershed
// can be delineated at an outlet below the Bananal confluence and then clipped
// to São Paulo state, which is how UGRHI-2 is defined.
export const BBOX = { west: -47.25, east: -43.90, south: -24.00, north: -22.25 };
export const FULL_STEP = 1 / 3600;    // FABDEM native, 1″
export const AGG = 6;                 // 6×6 full-res cells per output cell
export const OUT_STEP = AGG / 3600;   // 6″ ≈ 170 × 185 m

// DEM pre-smoothing: the app's "auto" rule since v64 (σ 30 m on every source,
// FABDEM included), applied with the same mask-normalized Gaussian the app
// uses (test-dem-smoothing.mjs is the byte-identical mirror). FABDEM's
// per-pixel noise biases slope STEEP, so the gentle shares reported here are
// conservative; σ30 removes most of that noise without flattening hillsides.
const SMOOTH_SIGMA_M = 30;

// Slope class edges, percent rise:
//   <3 flat/floodplain · 3–12 mechanizable · 12–30 moderate (urban limit,
//   Lei 6.766/79 art. 3) · 30–46.6 steep · 46.6–100 = 25–45° (Código
//   Florestal art. 11, restricted use) · >100 = >45° (art. 4 V, APP).
export const SLOPE_EDGES = [3, 12, 30, 100 * Math.tan(25 * Math.PI / 180), 100];

// Outlets (approximate; snapped to the max-accumulation cell within SNAP_KM).
// Alto Tietê ends at the Rasgão dam below Pirapora do Bom Jesus (UGRHI-6);
// the Paraíba is cut below Volta Redonda (RJ) and clipped to SP afterwards.
export const OUTLETS = [
  { id: 1, name: "Alto Tietê (Rasgão)", lat: -23.385, lon: -47.035, snapKm: 4 },
  { id: 2, name: "Paraíba do Sul (Volta Redonda)", lat: -22.505, lon: -44.06, snapKm: 6 },
];
export const PUBLISHED_KM2 = { 1: 5868, 2: 14444 };   // UGRHI-6, UGRHI-2

// Hydrological carves applied to the 6″ surface before the flood. Billings
// is dammed on every side; on the DEM its lowest rim is the Serra do Mar side
// (Summit Control → Rio das Pedras → Cubatão), so without a carve the whole
// Billings catchment drains to the sea and leaves UGRHI-6. Its natural outlet
// is north through Pedreira into the Jurubatuba canal / Pinheiros — the path
// the Pinheiros reversal pumps against — so we breach that dam on the grid.
export const CARVES = [
  { name: "Pedreira (Billings → Jurubatuba/Pinheiros)", from: [-23.712, -46.668], to: [-23.655, -46.712] },
];
// …and the Summit Control dam that separates Billings from the Rio das Pedras
// reservoir (both ~728–735 m on FABDEM) is a narrow crest that σ30 + 6″
// averaging erase, leaving the two lakes connected. Located from the D8
// trace (the step where Billings' arm drops onto the Rio das Pedras level);
// restored as a wall so Billings spills north through the Pedreira carve.
// A thick (3-cell) line across the arm, so D8 can't slip diagonally past it.
export const WALLS = [
  { name: "Summit Control (Billings | Rio das Pedras)", from: [-23.842, -46.502], to: [-23.818, -46.478], halfWidth: 1, z: 780 },
];

const MAPBIOMAS_URL =
  "https://storage.googleapis.com/mapbiomas-public/initiatives/brasil/collection_9/lclu/coverage/brasil_coverage_2023.tif";
const CENSUS_FGB_URL = "https://storage.googleapis.com/simujaules/census/setores_br_pop.fgb";

// ---- small cache helpers ----------------------------------------------------
function saveArrays(name, meta, arrays) {
  mkdirSync(CACHE, { recursive: true });
  const index = {};
  let off = 0;
  const parts = [];
  for (const [k, a] of Object.entries(arrays)) {
    const b = Buffer.from(a.buffer, a.byteOffset, a.byteLength);
    index[k] = { type: a.constructor.name, offset: off, length: a.length };
    parts.push(b); off += b.length;
    const pad = (8 - (off % 8)) % 8;
    if (pad) { parts.push(Buffer.alloc(pad)); off += pad; }
  }
  writeFileSync(join(CACHE, name + ".bin"), Buffer.concat(parts));
  writeFileSync(join(CACHE, name + ".json"), JSON.stringify({ meta, index }, null, 1));
}
export function loadArrays(name, dir = CACHE) {
  const { meta, index } = JSON.parse(readFileSync(join(dir, name + ".json"), "utf8"));
  const buf = readFileSync(join(dir, name + ".bin"));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const ctors = { Float32Array, Float64Array, Uint8Array, Uint16Array, Int32Array, Uint32Array };
  const arrays = {};
  for (const [k, { type, offset, length }] of Object.entries(index)) {
    arrays[k] = new ctors[type](ab, offset, length);
  }
  return { meta, arrays };
}
const outGrid = () => makeGrid({ ...BBOX, step: OUT_STEP });
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

// 8-connected raster line between two [lat, lon] points (Bresenham)
function lineCells(g, [lat0, lon0], [lat1, lon1]) {
  let r0 = g.rowOf(lat0), c0 = g.colOf(lon0);
  const r1 = g.rowOf(lat1), c1 = g.colOf(lon1);
  const dr = Math.abs(r1 - r0), dc = Math.abs(c1 - c0);
  const sr = r0 < r1 ? 1 : -1, sc = c0 < c1 ? 1 : -1;
  let err = dc - dr;
  const out = [];
  for (;;) {
    out.push(r0 * g.W + c0);
    if (r0 === r1 && c0 === c1) break;
    const e2 = 2 * err;
    if (e2 > -dr) { err -= dr; c0 += sc; }
    if (e2 < dc) { err += dc; r0 += sr; }
  }
  return out;
}

// ---- stage 1: DEM -------------------------------------------------------
async function stageDem() {
  const full = makeGrid({ ...BBOX, step: FULL_STEP });
  const { W, H } = full;
  log(`full-res mosaic ${W}×${H} = ${(W * H / 1e6).toFixed(1)} M cells`);
  const h = new Float32Array(W * H).fill(NaN);
  for (let lat = Math.floor(BBOX.south); lat < Math.ceil(BBOX.north); lat++) {
    for (let lon = Math.floor(BBOX.west); lon < Math.ceil(BBOX.east); lon++) {
      const ns = lat < 0 ? "S" : "N", ew = lon < 0 ? "W" : "E";
      const name = `${ns}${String(Math.abs(lat)).padStart(2, "0")}${ew}${String(Math.abs(lon)).padStart(3, "0")}_FABDEM_V1-2.tif`;
      const path = join(FABDEM_DIR, name);
      if (!existsSync(path)) { log(`missing tile ${name} (ocean?) — skipped`); continue; }
      const tif = await GeoTIFF.fromFile(path);
      const img = await tif.getImage();
      const ndRaw = img.fileDirectory.getValue?.("GDAL_NODATA");
      const nodata = ndRaw ? Math.fround(parseFloat(ndRaw)) : null;
      const [oX, oY] = img.getOrigin();
      const [rX, rY] = img.getResolution();
      const iw = Math.max(BBOX.west, lon), ie = Math.min(BBOX.east, lon + 1);
      const is = Math.max(BBOX.south, lat), inn = Math.min(BBOX.north, lat + 1);
      if (ie <= iw || inn <= is) continue;
      const wnd = [
        Math.round((iw - oX) / rX), Math.round((inn - oY) / rY),
        Math.round((ie - oX) / rX), Math.round((is - oY) / rY),
      ];
      const ras = await img.readRasters({ window: wnd, samples: [0], interleave: true });
      const rw = wnd[2] - wnd[0], rh = wnd[3] - wnd[1];
      const c0 = Math.round((iw - BBOX.west) * 3600), r0 = Math.round((BBOX.north - inn) * 3600);
      for (let r = 0; r < rh; r++) for (let c = 0; c < rw; c++) {
        const v = ras[r * rw + c];
        if (Number.isFinite(v) && v !== nodata && v > -100) h[(r0 + r) * W + c0 + c] = v;
      }
      log(`tile ${name}: ${rw}×${rh} placed (nodata=${nodata})`);
    }
  }
  const mask = new Uint8Array(W * H);
  for (let i = 0; i < mask.length; i++) mask[i] = Number.isFinite(h[i]) ? 1 : 0;

  // σ30 smoothing at the mosaic's centre-latitude metric, exactly as the app
  // applies it on DEM load (dxM/dyM of the DEM's centre).
  const rad = Math.PI / 180, latC = (BBOX.south + BBOX.north) / 2;
  const dyFull = FULL_STEP * rad * R_EARTH_M;
  const dxC = dyFull * Math.cos(latC * rad);
  smoothHeightsInPlace(h, mask, H, W, dxC, dyFull, SMOOTH_SIGMA_M);
  log(`smoothed (σ ${SMOOTH_SIGMA_M} m, dx ${dxC.toFixed(2)} m, dy ${dyFull.toFixed(2)} m)`);

  // Full-res slope (central differences, per-row dx) → class counts per
  // output cell; plus north-facing ("sunny") counts among 3–46.6 % slopes
  // (southern hemisphere: north-facing slopes get the most sun — PV siting).
  const og = outGrid();
  const oN = og.W * og.H;
  const nClass = SLOPE_EDGES.length + 1;
  const cls = Array.from({ length: nClass }, () => new Uint8Array(oN));
  const sunny = new Uint8Array(oN);
  const validFull = new Uint8Array(oN);
  const elevSum = new Float64Array(oN);
  const COT60 = 1 / Math.tan(60 * rad);
  for (let r = 0; r < H; r++) {
    const lat = BBOX.north - (r + 0.5) * FULL_STEP;
    const dx = dyFull * Math.cos(lat * rad);
    const orow = (r / AGG) | 0;
    for (let c = 0; c < W; c++) {
      const i = r * W + c;
      if (!mask[i]) continue;
      const o = orow * og.W + ((c / AGG) | 0);
      validFull[o]++;
      elevSum[o] += h[i];
      if (r === 0 || c === 0 || r === H - 1 || c === W - 1) continue;
      const e = h[i + 1], w = h[i - 1], n = h[i - W], s = h[i + W];
      if (!(mask[i + 1] && mask[i - 1] && mask[i - W] && mask[i + W])) continue;
      const dzde = (e - w) / (2 * dx), dzdn = (n - s) / (2 * dyFull);
      const pct = 100 * Math.hypot(dzde, dzdn);
      let k = 0;
      while (k < SLOPE_EDGES.length && pct >= SLOPE_EDGES[k]) k++;
      cls[k][o]++;
      // downslope vector (-dzde, -dzdn) within ±60° of north
      if (pct >= 3 && pct < SLOPE_EDGES[3] && -dzdn > 0 && Math.abs(dzde) * COT60 <= -dzdn) sunny[o]++;
    }
  }
  const half = (AGG * AGG) / 2;
  const elev = new Float32Array(oN).fill(NaN);
  const valid = new Uint8Array(oN);
  for (let o = 0; o < oN; o++) {
    if (validFull[o] >= half) { valid[o] = 1; elev[o] = elevSum[o] / validFull[o]; }
  }
  log(`aggregated to ${og.W}×${og.H} (6″)`);

  saveArrays("dem", { grid: { ...BBOX, step: OUT_STEP, W: og.W, H: og.H }, smoothSigmaM: SMOOTH_SIGMA_M, slopeEdges: SLOPE_EDGES }, {
    elev, valid, validFull, sunny, ...Object.fromEntries(cls.map((a, k) => [`s${k}`, a])),
  });
  log("dem cached");
}

// ---- stage 2: land cover (MapBiomas Collection 9, 2023) ----------------------
// Legend codes verified by histogramming known places (bake log of the first
// run: São Paulo centre 24 = 100 %; Billings 33 river/lake; Taubaté 15
// pasture 76 %; Salesópolis 9 forest plantation 27 %; Cantareira 3 forest
// formation 72 %). Grouped into the classes the allocation reasons about.
export const LC_GROUPS = [
  { key: "urban",      codes: [24] },
  { key: "forest",     codes: [3, 4, 5, 6, 49] },
  { key: "natOpen",    codes: [10, 11, 12, 13, 29, 32, 50] },   // wetland, grassland, rock
  { key: "plantation", codes: [9] },                             // eucalyptus / pine
  { key: "pasture",    codes: [15] },
  { key: "agri",       codes: [14, 18, 19, 20, 35, 36, 39, 40, 41, 46, 47, 48, 62] },
  { key: "mosaic",     codes: [21] },                            // mosaic of uses
  { key: "water",      codes: [26, 31, 33] },
  { key: "mining",     codes: [30] },
  { key: "bare",       codes: [22, 23, 25] },
];
async function stageLandcover() {
  const og = outGrid();
  const oN = og.W * og.H;
  const lut = new Int8Array(256).fill(-1);
  LC_GROUPS.forEach((g, k) => g.codes.forEach((c) => (lut[c] = k)));
  const counts = LC_GROUPS.map(() => new Uint8Array(oN));
  const total = new Uint8Array(oN);
  const tif = await GeoTIFF.fromUrl(MAPBIOMAS_URL);
  const img = await tif.getImage();
  const [x0, , , y1] = img.getBoundingBox();
  const [res] = img.getResolution();
  const px0 = Math.floor((BBOX.west - x0) / res), px1 = Math.ceil((BBOX.east - x0) / res);
  const py0 = Math.floor((y1 - BBOX.north) / res), py1 = Math.ceil((y1 - BBOX.south) / res);
  const colMap = new Int32Array(px1 - px0);
  for (let x = px0; x < px1; x++) {
    const c = og.colOf(x0 + (x + 0.5) * res);
    colMap[x - px0] = c >= 0 && c < og.W ? c : -1;
  }
  const STRIP = 1024, wpx = px1 - px0;
  log(`MapBiomas window ${wpx}×${py1 - py0} px (res ${(res * 3600).toFixed(3)}″)`);
  for (let y = py0; y < py1; y += STRIP) {
    const y2 = Math.min(py1, y + STRIP);
    const ras = (await img.readRasters({ window: [px0, y, px1, y2], samples: [0] }))[0];
    for (let yy = y; yy < y2; yy++) {
      const r = og.rowOf(y1 - (yy + 0.5) * res);
      if (r < 0 || r >= og.H) continue;
      const base = (yy - y) * wpx, obase = r * og.W;
      for (let x = 0; x < wpx; x++) {
        const c = colMap[x];
        if (c < 0) continue;
        const k = lut[ras[base + x]];
        if (k < 0) continue;
        counts[k][obase + c]++;
        total[obase + c]++;
      }
    }
    log(`MapBiomas rows ${y - py0}–${y2 - py0} of ${py1 - py0}`);
  }
  saveArrays("landcover", { groups: LC_GROUPS.map((g) => g.key), source: MAPBIOMAS_URL },
    { total, ...Object.fromEntries(LC_GROUPS.map((g, k) => [g.key, counts[k]])) });
  log("landcover cached");
}

// ---- stage 3: hydrology on the 6″ grid --------------------------------------
// Lakes with a forced outlet: every cell of the lake (4-connected MapBiomas
// water ≥ minWater from the seed, walls excluded) drains along a BFS tree to
// the lake cell nearest the carve's start, then down the carve line. Burning
// the lake surface instead would put it below the Serra do Mar escarpment
// next to it and make the leak worse; overriding the D8 tree does not.
export const LAKES = [
  { name: "Billings", seed: [-23.77, -46.58], minWater: 0.35, carve: 0 },
];
function dirTo(i, j, W) {
  const ri = (i / W) | 0, ci = i - ri * W, rj = (j / W) | 0, cj = j - rj * W;
  for (let d = 0; d < 8; d++) if (ri + D8_DR[d] === rj && ci + D8_DC[d] === cj) return d;
  throw new Error(`dirTo: ${i}→${j} not adjacent`);
}
async function stageHydro() {
  const { meta: dm, arrays: dem } = loadArrays("dem");
  const { arrays: lc } = loadArrays("landcover");
  const og = outGrid();
  const oN = og.W * og.H;
  const { elev, valid } = dem;
  const rad = Math.PI / 180;
  const dyOut = OUT_STEP * rad * R_EARTH_M;
  const dxRow = new Float64Array(og.H);
  for (let r = 0; r < og.H; r++) dxRow[r] = dyOut * Math.cos(og.latOf(r) * rad);
  const elevH = Float32Array.from(elev);                    // hydrological surface
  const wall = new Uint8Array(oN);
  for (const wl of WALLS) {
    let n = 0;
    for (const o0 of lineCells(og, wl.from, wl.to)) {
      const r0 = (o0 / og.W) | 0, c0 = o0 - r0 * og.W;
      for (let r = r0 - wl.halfWidth; r <= r0 + wl.halfWidth; r++)
        for (let c = c0 - wl.halfWidth; c <= c0 + wl.halfWidth; c++) {
          const o = r * og.W + c;
          wall[o] = 1;
          if (valid[o] && elevH[o] < wl.z) { elevH[o] = wl.z; n++; }
        }
    }
    log(`wall ${wl.name}: ${n} cells raised to ${wl.z} m`);
  }
  const { filled, dir } = priorityFloodD8(elevH, valid, og.W, og.H, dxRow, dyOut);
  // lakes with forced outlets
  const lake = new Uint8Array(oN);
  for (const lk of LAKES) {
    const cv = CARVES[lk.carve];
    const isWater = (o) => valid[o] && !wall[o] && lc.total[o] > 0 && lc.water[o] / lc.total[o] >= lk.minWater;
    // snap the seed to the wettest cell within ~2.5 km
    const sr0 = og.rowOf(lk.seed[0]), sc0 = og.colOf(lk.seed[1]);
    let seed = -1, bestW = -1;
    for (let r = sr0 - 15; r <= sr0 + 15; r++) for (let c = sc0 - 15; c <= sc0 + 15; c++) {
      const o = r * og.W + c;
      const wf = lc.total[o] ? lc.water[o] / lc.total[o] : 0;
      if (isWater(o) && wf > bestW) { bestW = wf; seed = o; }
    }
    if (seed < 0) throw new Error(`lake ${lk.name}: no water near the seed`);
    const cells = [seed]; lake[seed] = 1;
    for (let h = 0; h < cells.length; h++) {
      const i = cells[h], r = (i / og.W) | 0, c = i - r * og.W;
      for (const [dr, dc] of [[0, 1], [1, 0], [0, -1], [-1, 0]]) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= og.H || cc >= og.W) continue;
        const j = rr * og.W + cc;
        if (!lake[j] && isWater(j)) { lake[j] = 1; cells.push(j); }
      }
    }
    let lakeKm2 = 0;
    for (const i of cells) lakeKm2 += og.rowArea[(i / og.W) | 0] * lc.water[i] / lc.total[i];
    // outlet: lake cell nearest the carve start; channel = carve line from it
    const fr = og.rowOf(cv.from[0]), fc = og.colOf(cv.from[1]);
    let outC = -1, bestD = Infinity;
    for (const i of cells) {
      const r = (i / og.W) | 0, c = i - r * og.W;
      const d = Math.hypot(r - fr, c - fc);
      if (d < bestD) { bestD = d; outC = i; }
    }
    const or = (outC / og.W) | 0, oc = outC - or * og.W;
    const line = lineCells(og, [og.latOf(or), og.lonOf(oc)], cv.to);
    let kL = 0;
    for (let k = 0; k < line.length; k++) if (lake[line[k]]) kL = k;
    const root = line[kL];                       // last lake cell on the carve
    const channel = line.slice(kL);              // root, then land cells to the end
    // BFS tree inside the lake, rooted at the outlet cell
    const seen = new Uint8Array(oN); seen[root] = 1;
    const q = [root];
    for (let h = 0; h < q.length; h++) {
      const i = q[h], r = (i / og.W) | 0, c = i - r * og.W;
      for (let d = 0; d < 8; d++) {
        const rr = r + D8_DR[d], cc = c + D8_DC[d];
        const j = rr * og.W + cc;
        if (rr < 0 || cc < 0 || rr >= og.H || cc >= og.W || seen[j] || !lake[j]) continue;
        seen[j] = 1; dir[j] = (d + 4) % 8; q.push(j);       // j → i
      }
    }
    for (let k = 0; k < channel.length - 1; k++) dir[channel[k]] = dirTo(channel[k], channel[k + 1], og.W);
    const tail = channel[channel.length - 1];
    const tr = receiverOf(tail, dir, og.W);
    if (tr >= 0 && (lake[tr] || channel.includes(tr))) throw new Error(`lake ${lk.name}: carve end drains back`);
    log(`lake ${lk.name}: ${cells.length} cells, ~${lakeKm2.toFixed(0)} km² of water, outlet → ${cv.name} (${channel.length} channel cells)`);
  }
  const order = topoOrder(dir, valid, og.W, og.H);           // upstream → downstream
  let nValid = 0; for (let o = 0; o < oN; o++) nValid += valid[o];
  if (order.length !== nValid) throw new Error(`D8 has cycles: ${nValid - order.length} cells unordered`);
  const acc = new Float64Array(oN);                       // km²
  for (let o = 0; o < oN; o++) if (valid[o]) acc[o] = og.rowArea[(o / og.W) | 0];
  for (let k = 0; k < order.length; k++) {
    const i = order[k], j = receiverOf(i, dir, og.W);
    if (j >= 0) acc[j] += acc[i];
  }
  // HAND: height above the nearest drainage cell downstream (stream ≥ 1 km²)
  const STREAM_KM2 = 1;
  const drainH = new Float64Array(oN);
  const hand = new Float32Array(oN);
  for (let k = order.length - 1; k >= 0; k--) {
    const i = order[k];
    const j = receiverOf(i, dir, og.W);
    drainH[i] = acc[i] >= STREAM_KM2 || j < 0 ? filled[i] : drainH[j];
    hand[i] = Math.max(0, filled[i] - drainH[i]);
  }
  // Outlets → watershed labels (downstream-first order)
  const ws = new Uint8Array(oN);
  const outletInfo = [];
  for (const ot of OUTLETS) {
    const r0 = og.rowOf(ot.lat), c0 = og.colOf(ot.lon);
    const rr = Math.ceil(ot.snapKm / (dyOut / 1000)) + 1;
    let best = -1, bestA = -1;
    for (let r = r0 - rr; r <= r0 + rr; r++) for (let c = c0 - rr; c <= c0 + rr; c++) {
      if (r < 0 || c < 0 || r >= og.H || c >= og.W) continue;
      const dkm = Math.hypot((r - r0) * dyOut, (c - c0) * dxRow[r]) / 1000;
      const o = r * og.W + c;
      if (dkm <= ot.snapKm && acc[o] > bestA) { bestA = acc[o]; best = o; }
    }
    ws[best] = ot.id;
    const br = (best / og.W) | 0, bc = best - br * og.W;
    outletInfo.push({ ...ot, cell: best, snappedLat: og.latOf(br), snappedLon: og.lonOf(bc), accKm2: bestA });
    log(`outlet ${ot.name}: snapped to (${og.latOf(br).toFixed(4)}, ${og.lonOf(bc).toFixed(4)}), drainage ${bestA.toFixed(0)} km²`);
  }
  for (let k = order.length - 1; k >= 0; k--) {
    const i = order[k];
    if (ws[i]) continue;
    const j = receiverOf(i, dir, og.W);
    if (j >= 0) ws[i] = ws[j];
  }
  const area = { 1: 0, 2: 0 };
  for (let o = 0; o < oN; o++) if (ws[o]) area[ws[o]] += og.rowArea[(o / og.W) | 0];
  log(`watershed areas: Alto Tietê ${area[1].toFixed(0)} km² (published UGRHI-6 ${PUBLISHED_KM2[1]}), ` +
      `Paraíba at Volta Redonda ${area[2].toFixed(0)} km² (incl. RJ/MG; clipped to SP in export)`);

  saveArrays("hydro", { outlets: outletInfo, streamKm2: STREAM_KM2, lakes: LAKES, carves: CARVES, walls: WALLS },
    { dir, acc: new Float32Array(acc), hand, ws, lake });
  log("hydro cached");
}

// ---- stage 4: census (IBGE 2022 setores) → population + state ---------------
// Scanline even-odd fill at the 6″ cell centres; a setor's population is
// spread evenly over the cells whose centres it contains (a setor smaller
// than a cell lands whole on the cell holding its bbox centre). The first two
// digits of cd_setor are the IBGE state code (35 = São Paulo), which gives
// the SP mask UGRHI-2 is clipped with.
async function stageCensus() {
  const { deserialize } = await import("flatgeobuf/lib/mjs/geojson.js");
  const og = outGrid();
  const oN = og.W * og.H;
  const pop = new Float64Array(oN);
  const uf = new Uint8Array(oN);
  let nFeat = 0, popTotal = 0, tiny = 0;
  const xs = [];
  for await (const f of deserialize(CENSUS_FGB_URL, { minX: BBOX.west, minY: BBOX.south, maxX: BBOX.east, maxY: BBOX.north })) {
    nFeat++;
    const p = +f.properties.pop || 0;
    const code = +String(f.properties.cd_setor).slice(0, 2);
    const g = f.geometry;
    const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
    const edges = [];
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const poly of polys) for (const ring of poly) {
      for (let k = 0; k < ring.length; k++) {
        const a = ring[k], b = ring[(k + 1) % ring.length];
        edges.push(a[0], a[1], b[0], b[1]);
        if (a[0] < minX) minX = a[0]; if (a[0] > maxX) maxX = a[0];
        if (a[1] < minY) minY = a[1]; if (a[1] > maxY) maxY = a[1];
      }
    }
    const r0 = Math.max(0, og.rowOf(maxY)), r1 = Math.min(og.H - 1, og.rowOf(minY));
    const cells = [];
    for (let r = r0; r <= r1; r++) {
      const y = og.latOf(r);
      xs.length = 0;
      for (let e = 0; e < edges.length; e += 4) {
        const y1 = edges[e + 1], y2 = edges[e + 3];
        if ((y1 > y) !== (y2 > y)) xs.push(edges[e] + (y - y1) * (edges[e + 2] - edges[e]) / (y2 - y1));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const c0 = Math.max(0, Math.ceil((xs[k] - og.west) / og.step - 0.5));
        const c1 = Math.min(og.W - 1, Math.floor((xs[k + 1] - og.west) / og.step - 0.5));
        for (let c = c0; c <= c1; c++) cells.push(r * og.W + c);
      }
    }
    if (cells.length) {
      const share = p / cells.length;
      for (const o of cells) { pop[o] += share; uf[o] = code; }
    } else {
      const r = og.rowOf((minY + maxY) / 2), c = og.colOf((minX + maxX) / 2);
      if (r >= 0 && c >= 0 && r < og.H && c < og.W) { pop[r * og.W + c] += p; if (!uf[r * og.W + c]) uf[r * og.W + c] = code; }
      tiny++;
    }
    popTotal += p;
    if (nFeat % 20000 === 0) log(`census: ${nFeat} setores…`);
  }
  log(`census: ${nFeat} setores, ${(popTotal / 1e6).toFixed(2)} M people in the bbox (${tiny} smaller than a cell)`);
  saveArrays("census", { source: CENSUS_FGB_URL, setores: nFeat }, { pop: new Float32Array(pop), uf });
  log("census cached");
}

// ---- shared: basin labels ------------------------------------------------------
// 1 = Alto Tietê (UGRHI-6), 2 = Paraíba do Sul ∩ São Paulo (UGRHI-2),
// 3 = the Paraíba watershed outside SP (context only, never allocated).
export function basinLabels(hy, ce) {
  const b = new Uint8Array(hy.ws.length);
  for (let o = 0; o < b.length; o++) {
    if (hy.ws[o] === 1) b[o] = 1;
    else if (hy.ws[o] === 2) b[o] = ce.uf[o] === 35 ? 2 : 3;
  }
  return b;
}

// ---- stage 5: export → landuse/data/ -----------------------------------------
// Reservoirs: 4-connected MapBiomas water (≥ 50 % of the cell) components of
// ≥ 2 km² inside the basins, named by their area-weighted centroid (nearest
// known reservoir within 5 km). The names were assigned from the bake's own
// component listing (area, centroid, upstream area), not guessed in advance.
// Every one except Funil (RJ, context) is a drinking-water source
// (manancial); `catch` labels each cell with the nearest reservoir
// downstream of it (incremental catchment), for the phosphorus check.
export const RESERVOIRS = [
  { name: "Paraibuna/Paraitinga", lat: -23.431, lon: -45.535, system: "Paraíba (regulation, RJ supply)" },
  { name: "Billings", lat: -23.790, lon: -46.576, system: "Billings / Rio Grande" },
  { name: "Jaguari", lat: -23.198, lon: -46.086, system: "Paraíba → Cantareira transfer" },
  { name: "Funil (RJ)", lat: -22.549, lon: -44.612, system: "Paraíba (RJ)", context: true },
  { name: "Guarapiranga", lat: -23.723, lon: -46.740, system: "Guarapiranga" },
  { name: "Ponte Nova", lat: -23.579, lon: -45.929, system: "Alto Tietê" },
  { name: "Taiaçupeba", lat: -23.594, lon: -46.275, system: "Alto Tietê" },
  { name: "Jundiaí (Mogi)", lat: -23.641, lon: -46.176, system: "Alto Tietê" },
  { name: "Santa Branca", lat: -23.349, lon: -45.826, system: "Paraíba (regulation)" },
  { name: "Biritiba", lat: -23.625, lon: -46.088, system: "Alto Tietê" },
  { name: "Paraitinga (Salesópolis)", lat: -23.521, lon: -45.910, system: "Alto Tietê" },
  { name: "Paiva Castro", lat: -23.331, lon: -46.641, system: "Cantareira (terminus)" },
  { name: "Cachoeira da Graça", lat: -23.727, lon: -46.962, system: "Alto Cotia" },
];
async function stageExport() {
  const og = outGrid();
  const N = og.W * og.H;
  const { meta: dm, arrays: dem } = loadArrays("dem");
  const { meta: lm, arrays: lc } = loadArrays("landcover");
  const { meta: hm, arrays: hy } = loadArrays("hydro");
  const { arrays: ce } = loadArrays("census");
  // fill cells no setor covers (large water bodies) with the nearest state code
  const uf = Uint8Array.from(ce.uf);
  {
    const q = [];
    for (let o = 0; o < N; o++) if (uf[o]) q.push(o);
    for (let h = 0; h < q.length; h++) {
      const i = q[h], r = (i / og.W) | 0, c = i - r * og.W;
      for (const [dr, dc] of [[0, 1], [1, 0], [0, -1], [-1, 0]]) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= og.H || cc >= og.W) continue;
        const j = rr * og.W + cc;
        if (!uf[j]) { uf[j] = uf[i]; q.push(j); }
      }
    }
  }
  const basin = basinLabels(hy, { uf });
  // reservoirs
  const wet = (o) => basin[o] && lc.total[o] && lc.water[o] / lc.total[o] >= 0.5;
  const comp = new Int32Array(N).fill(-1);
  const resCell = new Uint8Array(N);
  const resInfo = [];
  for (let s0 = 0; s0 < N; s0++) {
    if (comp[s0] >= 0 || !wet(s0)) continue;
    const q = [s0]; comp[s0] = s0;
    let A = 0, sr = 0, sc = 0, el = 0;
    for (let h = 0; h < q.length; h++) {
      const i = q[h], r = (i / og.W) | 0, c = i - r * og.W;
      const a = og.rowArea[r] * lc.water[i] / lc.total[i];
      A += a; sr += r * a; sc += c * a; el += dem.elev[i] * a;
      for (const [dr, dc] of [[0, 1], [1, 0], [0, -1], [-1, 0]]) {
        const j = (r + dr) * og.W + c + dc;
        if (comp[j] < 0 && wet(j)) { comp[j] = s0; q.push(j); }
      }
    }
    if (A < 2) continue;
    const lat = og.latOf(sr / A), lon = og.lonOf(sc / A);
    let best = null, bd = 5;
    for (const k of RESERVOIRS) {
      const d = Math.hypot((k.lat - lat) * 111.2, (k.lon - lon) * 111.2 * Math.cos(lat * Math.PI / 180));
      if (d < bd) { bd = d; best = k; }
    }
    const id = resInfo.length + 1;
    for (const i of q) resCell[i] = id;
    resInfo.push({ id, name: best ? best.name : `Reservoir ${id}`, system: best?.system ?? "", context: !!best?.context,
      manancial: !best?.context, waterKm2: +A.toFixed(1), lat: +lat.toFixed(4), lon: +lon.toFixed(4), levelM: Math.round(el / A) });
    log(`reservoir ${id}: ${resInfo[id - 1].name} ${A.toFixed(1)} km² @ (${lat.toFixed(3)}, ${lon.toFixed(3)})`);
  }
  // incremental catchments (downstream-first propagation)
  const order = topoOrder(hy.dir, dem.valid, og.W, og.H);
  const catchId = new Uint8Array(N);
  for (let k = order.length - 1; k >= 0; k--) {
    const i = order[k];
    if (resCell[i]) { catchId[i] = resCell[i]; continue; }
    const j = receiverOf(i, hy.dir, og.W);
    if (j >= 0) catchId[i] = catchId[j];
  }
  for (const r of resInfo) {
    let A = 0;
    for (let o = 0; o < N; o++) if (catchId[o] === r.id && basin[o]) A += og.rowArea[(o / og.W) | 0];
    r.catchKm2 = Math.round(A);
  }
  // pack layers
  mkdirSync(DATA, { recursive: true });
  const u16 = (f) => { const a = new Uint16Array(N); for (let o = 0; o < N; o++) a[o] = f(o); return a; };
  const u8 = (f) => { const a = new Uint8Array(N); for (let o = 0; o < N; o++) a[o] = f(o); return a; };
  let popMax = 0;
  for (let o = 0; o < N; o++) popMax = Math.max(popMax, ce.pop[o]);
  if (popMax > 65535) throw new Error(`pop per cell ${popMax} overflows u16`);
  const sv = u8((o) => dem.s0[o] + dem.s1[o] + dem.s2[o] + dem.s3[o] + dem.s4[o] + dem.s5[o]);
  const files = {
    "elev.png": [[u16((o) => dem.valid[o] ? Math.max(1, Math.round(dem.elev[o])) : 0)], 16],
    "pop.png": [[u16((o) => Math.round(ce.pop[o]))], 16],
    "slope.png": [[dem.s0, dem.s1, dem.s2, dem.s3], 8],
    "slope2.png": [[dem.s4, dem.s5, dem.sunny, sv], 8],
    "lc1.png": [[lc.urban, lc.forest, lc.natOpen, lc.plantation], 8],
    "lc2.png": [[lc.pasture, lc.agri, lc.mosaic, lc.water], 8],
    "lc3.png": [[lc.mining, lc.bare, lc.total], 8],
    "hydro.png": [[hy.dir, u8((o) => dem.valid[o] ? Math.min(254, Math.round(hy.hand[o])) : 255), basin,
      u8((o) => (resCell[o] ? 128 : 0) | catchId[o])], 8],
  };
  const sizes = {};
  for (const [name, [planes, depth]] of Object.entries(files)) {
    const png = encodePng(planes, og.W, og.H, depth);
    writeFileSync(join(DATA, name), png);
    sizes[name] = png.length;
  }
  // per-basin summary for the page header
  const basins = {};
  for (const b of [1, 2, 3]) {
    let A = 0, P = 0;
    for (let o = 0; o < N; o++) if (basin[o] === b) { A += og.rowArea[(o / og.W) | 0]; P += ce.pop[o]; }
    basins[b] = { areaKm2: Math.round(A), pop: Math.round(P) };
  }
  const meta = {
    generated: new Date().toISOString().slice(0, 10),
    grid: { west: og.west, north: og.north, step: og.step, W: og.W, H: og.H },
    files: Object.keys(files),
    layers: {
      "elev.png": ["elevation m (0 = nodata)"], "pop.png": ["persons (IBGE 2022)"],
      "slope.png": ["n<3%", "n3–12%", "n12–30%", "n30–46.6%"], "slope2.png": ["n46.6–100%", "n>100%", "north-facing 3–46.6%", "n valid"],
      "lc1.png": ["urban", "forest", "natOpen", "plantation"], "lc2.png": ["pasture", "agri", "mosaic", "water"],
      "lc3.png": ["mining", "bare", "total"], "hydro.png": ["D8 dir (8 = none)", "HAND m (255 nodata)", "basin", "reservoir flag (128) | catchment id"],
    },
    slopeEdgesPct: SLOPE_EDGES, d8: { dr: D8_DR, dc: D8_DC }, smoothSigmaM: dm.smoothSigmaM,
    basins, published: { 1: { name: "Alto Tietê (UGRHI-6)", areaKm2: 5868 }, 2: { name: "Paraíba do Sul, SP part (UGRHI-2)", areaKm2: 14444 } },
    outlets: hm.outlets.map(({ name, snappedLat, snappedLon, accKm2 }) => ({ name, lat: snappedLat, lon: snappedLon, accKm2: Math.round(accKm2) })),
    reservoirs: resInfo, hydroFixes: { carves: hm.carves, walls: hm.walls, lakes: hm.lakes },
    sources: {
      dem: "FABDEM V1-2 (Hawker et al. 2022), 1″, via fabdem.pedalhidrografi.co; σ 30 m Gaussian (Simujaules' auto rule)",
      landcover: "MapBiomas Brasil Collection 9, 2023 coverage (" + lm.source + ")",
      census: "IBGE Censo 2022 setores (pop = v0001), simujaules census FGB",
    },
    sizes,
  };
  writeFileSync(join(DATA, "meta.json"), JSON.stringify(meta, null, 1));
  log(`exported ${Object.keys(files).length} layers (${(Object.values(sizes).reduce((a, b) => a + b, 0) / 1e6).toFixed(1)} MB) + meta.json; ` +
      `basins: AT ${basins[1].areaKm2} km² / ${(basins[1].pop / 1e6).toFixed(2)} M, PB-SP ${basins[2].areaKm2} km² / ${(basins[2].pop / 1e6).toFixed(2)} M`);
}

// ---- stage 6: report — the gentle-land table ----------------------------------
// km² by land-cover group × slope band per basin. Within a 6″ cell the cover
// and slope fractions are combined as if independent (no finer co-location is
// kept), so a cell's contribution is area × f_cover × f_slope.
async function stageReport() {
  const og = outGrid();
  const { arrays: dem } = loadArrays("dem");
  const { arrays: lc } = loadArrays("landcover");
  const { arrays: hy } = loadArrays("hydro");
  const { arrays: ce } = loadArrays("census");
  const basin = basinLabels(hy, ce);
  const bands = [
    { key: "<3% flat", cls: [0] }, { key: "3–12% gentle", cls: [1] },
    { key: "12–30% moderate", cls: [2] }, { key: "≥30% steep", cls: [3, 4, 5] },
  ];
  const groups = LC_GROUPS.map((g) => g.key);
  for (const b of [1, 2]) {
    const T = groups.map(() => bands.map(() => 0));
    let area = 0, popB = 0, flood = 0;
    for (let o = 0; o < basin.length; o++) {
      if (basin[o] !== b) continue;
      const a = og.rowArea[(o / og.W) | 0];
      area += a; popB += ce.pop[o];
      const tot = lc.total[o], sv = dem.s0[o] + dem.s1[o] + dem.s2[o] + dem.s3[o] + dem.s4[o] + dem.s5[o];
      if (!tot || !sv) continue;
      if (hy.hand[o] < 5) flood += a;
      groups.forEach((g, gi) => {
        const fc = lc[g][o] / tot;
        if (!fc) return;
        bands.forEach((bd, bi) => {
          let n = 0; for (const k of bd.cls) n += dem[`s${k}`][o];
          T[gi][bi] += a * fc * n / sv;
        });
      });
    }
    console.log(`\n### ${b === 1 ? "Alto Tietê" : "Paraíba do Sul (SP)"} — ${area.toFixed(0)} km², ${(popB / 1e6).toFixed(2)} M people, ${flood.toFixed(0)} km² with HAND < 5 m\n`);
    console.log(`| cover | ${bands.map((x) => x.key).join(" | ")} | total |`);
    console.log(`|---|${bands.map(() => "---:").join("|")}|---:|`);
    groups.forEach((g, gi) => {
      const row = T[gi];
      console.log(`| ${g} | ${row.map((v) => v.toFixed(0)).join(" | ")} | ${row.reduce((x, y) => x + y, 0).toFixed(0)} |`);
    });
    const cleared = ["pasture", "agri", "mosaic"].map((g) => groups.indexOf(g));
    const sumB = (gis, bis) => gis.reduce((s, gi) => s + bis.reduce((t, bi) => t + T[gi][bi], 0), 0);
    console.log(`\ncleared (pasture+agri+mosaic) <12 %: ${sumB(cleared, [0, 1]).toFixed(0)} km²; ` +
      `+ plantation <12 %: ${sumB([groups.indexOf("plantation")], [0, 1]).toFixed(0)} km²; ` +
      `+ forest <12 %: ${sumB([groups.indexOf("forest")], [0, 1]).toFixed(0)} km²`);
  }
}

// ---- stage 0: FABDEM tiles -------------------------------------------------------
const FABDEM_BASE_URL = "https://fabdem.pedalhidrografi.co/";   // app.js FABDEM_BASE_URL
async function stageTiles() {
  mkdirSync(FABDEM_DIR, { recursive: true });
  for (let lat = Math.floor(BBOX.south); lat < Math.ceil(BBOX.north); lat++) {
    for (let lon = Math.floor(BBOX.west); lon < Math.ceil(BBOX.east); lon++) {
      const ns = lat < 0 ? "S" : "N", ew = lon < 0 ? "W" : "E";
      const name = `${ns}${String(Math.abs(lat)).padStart(2, "0")}${ew}${String(Math.abs(lon)).padStart(3, "0")}_FABDEM_V1-2.tif`;
      const path = join(FABDEM_DIR, name);
      if (existsSync(path)) { log(`tile ${name}: cached`); continue; }
      const res = await fetch(FABDEM_BASE_URL + name);
      if (res.status === 404) { log(`tile ${name}: not in FABDEM (ocean) — skipped`); continue; }
      if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
      writeFileSync(path, Buffer.from(await res.arrayBuffer()));
      log(`tile ${name}: downloaded`);
    }
  }
}

// ---- CLI ---------------------------------------------------------------------
const STAGES = { tiles: stageTiles, dem: stageDem, landcover: stageLandcover, hydro: stageHydro, census: stageCensus, export: stageExport, report: stageReport };
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  const which = process.argv[2] || "all";
  const run = which === "all" ? Object.keys(STAGES) : [which];
  for (const s of run) {
    if (!STAGES[s]) { console.error(`unknown stage ${s}; one of ${Object.keys(STAGES).join(", ")}, all`); process.exit(2); }
    await STAGES[s]();
  }
}
