// Land-use allocation model for a self-sustaining São Paulo — shared by the
// page (landuse/index.html, as an ES module) and the node test
// (landuse/test-landuse.mjs). Pure: no DOM, no network. Everything a number
// on the page comes from is computed here, from the baked grid layers
// (landuse/bake.mjs → landuse/data/*.png + meta.json).
//
// The model is deliberately simple and legible: it allocates whole 6″ cells
// (~3 ha) to one PRIMARY use in a fixed priority order, with SECONDARY uses as
// flags (rooftop solar on the city, floating solar on reservoirs, fertigation
// on farms, drinking-water catchment on farms). Within a cell, land-cover and
// slope fractions are combined as if independent — the bake keeps no finer
// co-location — so a cell's productive area is area × f_cover × f_slope.
//
// Priority order (the legend shows it): fixed (water, quarries) → city →
// timber → vegetables → staples → terraces → ground solar → reforestation →
// what is left (forest, floodplain parks, natural, reserve).

// ---- PNG decoding (exact; mirrors landuse/lib.mjs decodePng) ---------------
// Uses DecompressionStream("deflate") — the zlib-wrapped stream PNG's IDAT
// carries — available in every current browser and in Node ≥ 18.
export async function decodePngAsync(arrayBuffer) {
  const u8 = new Uint8Array(arrayBuffer);
  const dv = new DataView(arrayBuffer);
  let p = 8, W = 0, H = 0, bitDepth = 8, colorType = 0;
  const idat = [];
  while (p < u8.length) {
    const len = dv.getUint32(p);
    const type = String.fromCharCode(u8[p + 4], u8[p + 5], u8[p + 6], u8[p + 7]);
    if (type === "IHDR") {
      W = dv.getUint32(p + 8); H = dv.getUint32(p + 12);
      bitDepth = u8[p + 16]; colorType = u8[p + 17];
    } else if (type === "IDAT") idat.push(u8.subarray(p + 8, p + 8 + len));
    else if (type === "IEND") break;
    p += 12 + len;
  }
  const stream = new Blob(idat).stream().pipeThrough(new DecompressionStream("deflate"));
  const z = new Uint8Array(await new Response(stream).arrayBuffer());
  const nch = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  const bpp = nch * (bitDepth / 8), stride = W * bpp;
  const cur = new Uint8Array(stride), prev = new Uint8Array(stride);
  const planes = [];
  for (let k = 0; k < nch; k++) planes.push(bitDepth === 16 ? new Uint16Array(W * H) : new Uint8Array(W * H));
  const paeth = (a, b, c) => {
    const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let r = 0; r < H; r++) {
    const f = z[r * (stride + 1)], base = r * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      const pr = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c);
      cur[x] = (z[base + x] + pr) & 0xff;
    }
    for (let c = 0; c < W; c++) for (let k = 0; k < nch; k++) {
      planes[k][r * W + c] = bitDepth === 16
        ? (cur[c * bpp + 2 * k] << 8) | cur[c * bpp + 2 * k + 1]
        : cur[c * bpp + k];
    }
    prev.set(cur);
  }
  return { W, H, bitDepth, planes };
}

// ---- uses ---------------------------------------------------------------------
export const USE = {
  NONE: 0, WATER: 1, CITY: 2, RECLAIMED: 3, VEG: 4, STAPLE: 5, TERRACE: 6, PV: 7,
  TIMBER: 8, FOREST: 9, REFOREST: 10, FLOOD: 11, NATURAL: 12, RESERVE: 13, MINING: 14,
};
// group = the map-layer toggle a use belongs to (the user's list, plus nature)
export const USE_INFO = [
  { key: "NONE", label: "Outside the scenario", color: null, group: null },
  { key: "WATER", label: "Reservoirs and rivers", color: "#3b82c4", group: "water" },
  { key: "CITY", label: "City: living and circulation", color: "#c8553d", group: "human" },
  { key: "RECLAIMED", label: "Reclaimed urban land (parks)", color: "#e9a37f", group: "human" },
  { key: "VEG", label: "Green belt: vegetables", color: "#7cc242", group: "food" },
  { key: "STAPLE", label: "Staples: soy, corn, potato", color: "#e3c53a", group: "food" },
  { key: "TERRACE", label: "Terraces and agroforestry: fruit, cassava", color: "#b59a2f", group: "food" },
  { key: "PV", label: "Ground solar", color: "#8a5cc7", group: "energy" },
  { key: "TIMBER", label: "Timber plantations (building biomass)", color: "#6f7f3a", group: "extraction" },
  { key: "FOREST", label: "Forest, kept", color: "#1f6b3a", group: "nature" },
  { key: "REFOREST", label: "Reforestation corridor", color: "#4fa36a", group: "nature" },
  { key: "FLOOD", label: "Floodplain park and wetland", color: "#7fc6c0", group: "water" },
  { key: "NATURAL", label: "Grassland, wetland, rock", color: "#a8b89a", group: "nature" },
  { key: "RESERVE", label: "Cleared land, unallocated (reserve)", color: "#d9d2c3", group: "other" },
  { key: "MINING", label: "Quarries and sand pits", color: "#5b5b5b", group: "extraction" },
];
export const FLAG = { ROOF_PV: 1, FLOAT_PV: 2, IRRIGATED: 4, MANANCIAL: 8, RIPARIAN: 16 };

// Defaults = the numbers this scenario was built from in conversation.
export const DEFAULTS = {
  scenario: "AT",              // "AT" = Alto Tietê only · "ATPV" = + Paraíba Valley (SP)
  cityMode: "compact",         // "compact" = today's footprint · "redesign" = from scratch
  compaction: 0,               // share of today's urban area freed (least dense first)
  density: 12000,              // redesign: people per km² of urban land (SP today ≈ 10,800)
  centers: 8,                  // redesign: number of urban centres (polycentric city)
  // food (plant-based, 80 % staples)
  kcal: 2500, loss: 0.25, insolation: 1733,   // kWh/m²/yr (6,240 MJ/m²)
  cropEff: 0.004,              // sunlight → harvested food energy, whole diet
  terraceFactor: 0.6,          // terraces / agroforestry vs mechanized fields
  vegKgPerCap: 30, vegYieldTHa: 40,
  allowTerraces: true, allowForestClearing: false, farmFloodplains: false, protectMananciais: false,
  timberKm2PerM: 11,           // ~250 km² of eucalyptus for ~23 M people (housing deficit in CLT)
  // energy
  energyMWhPerCap: 5.1,        // car-free, electrified, no-export economy
  roofGWhPerKm2: 24,           // rooftop solar per km² of city (40–65 TWh on ~2,200 km²)
  floatCover: 0.3,             // share of reservoir surface under floating solar
  pvEff: 0.09,                 // electricity per unit of sunlight per unit of LAND (7–12 %)
  biogasMWhPerCap: 0.07, storageShare: 0.4, storageLoss: 0.08, hbGWh: 30, pshGWh: 30,
  // water and sewage
  // 180 L/person/day = homes (~120) + commerce, services, industry; 12 % losses
  waterLpcd: 180, waterLoss: 0.12, returnFrac: 0.8, collectFrac: 0.95, reuseRecovery: 0.8,
  // drought-firm supply from in-basin reservoirs, m³/s (AT: today's ~40 m³/s
  // systems derated for a 2014-15-type drought; PB: the Vale's own share —
  // the Paraíba's flow is committed downstream to Rio de Janeiro)
  firmSupply: { 1: 28, 2: 10 },
  plantCap: 2e6, plantMin: 20000, trunkMin: 30000,
  fertigate: true, irrigationKm: 15, irrigationM: 0.35,
  pLossKgHa: 0.2, runoffM: 0.45, pLimitMgL: 0.03,
  // networks and services
  recyclePop: 200000, transitPop: 750000,
  reforest: true,
};

const G_SP = 9.7864;           // São Paulo gravity (IAG-USP) — the repo's G_SP, for pumping heads
const SLOPE_MID = [0.015, 0.075, 0.21, 0.38, 0.73, 1.5];   // class mid-grades (rise/run)

// ---- prepare: derived per-cell arrays (once per data load) --------------------
export function prepare(meta, files) {
  const { W, H, west, north, step } = meta.grid;
  const N = W * H;
  const R = 6371008.8, rad = Math.PI / 180;
  const rowArea = new Float64Array(H);
  for (let r = 0; r < H; r++) {
    const latN = north - r * step, latS = latN - step;
    rowArea[r] = (R * R * step * rad * (Math.sin(latN * rad) - Math.sin(latS * rad))) / 1e6;
  }
  const P = (name, k) => files[name].planes[k];
  const elev = P("elev.png", 0), popIn = P("pop.png", 0);
  const s = [...[0, 1, 2, 3].map((k) => P("slope.png", k)), P("slope2.png", 0), P("slope2.png", 1)];
  const sunnyN = P("slope2.png", 2), sv = P("slope2.png", 3);
  const lcNames = [["lc1.png", ["urban", "forest", "natOpen", "plantation"]], ["lc2.png", ["pasture", "agri", "mosaic", "water"]], ["lc3.png", ["mining", "bare", "total"]]];
  const lcRaw = {};
  for (const [f, keys] of lcNames) keys.forEach((k, i) => (lcRaw[k] = P(f, i)));
  const dir = P("hydro.png", 0), hand = P("hydro.png", 1), basin = P("hydro.png", 2), resCatch = P("hydro.png", 3);

  const area = new Float32Array(N);
  const f = {};
  for (const k of ["urban", "forest", "natOpen", "plantation", "pasture", "agri", "mosaic", "water", "mining", "bare"]) f[k] = new Float32Array(N);
  const g = Array.from({ length: 6 }, () => new Float32Array(N));
  const sunny = new Float32Array(N), grade = new Float32Array(N);
  for (let o = 0; o < N; o++) {
    area[o] = rowArea[(o / W) | 0];
    const t = lcRaw.total[o];
    if (t) for (const k in f) f[k][o] = lcRaw[k][o] / t;
    else f.water[o] = elev[o] ? 0 : 1;
    const n = sv[o];
    if (n) {
      let gr = 0;
      for (let k = 0; k < 6; k++) { g[k][o] = s[k][o] / n; gr += g[k][o] * SLOPE_MID[k]; }
      grade[o] = gr; sunny[o] = sunnyN[o] / n;
    } else { g[0][o] = 1; grade[o] = SLOPE_MID[0]; }
  }
  // D8 topology and accumulation
  const { dr, dc } = meta.d8;
  const recv = new Int32Array(N).fill(-1);
  for (let o = 0; o < N; o++) {
    const d = dir[o];
    if (d < 8 && elev[o]) {
      const r = (o / W) | 0, c = o - r * W;
      recv[o] = (r + dr[d]) * W + c + dc[d];
    }
  }
  const indeg = new Uint8Array(N);
  for (let o = 0; o < N; o++) if (recv[o] >= 0) indeg[recv[o]]++;
  const order = new Int32Array(N);
  let head = 0, tail = 0;
  for (let o = 0; o < N; o++) if (elev[o] && indeg[o] === 0) order[tail++] = o;
  while (head < tail) {
    const o = order[head++], j = recv[o];
    if (j >= 0 && --indeg[j] === 0) order[tail++] = j;
  }
  const topo = order.subarray(0, tail);               // upstream → downstream
  const acc = new Float32Array(N);
  for (let k = 0; k < topo.length; k++) acc[topo[k]] = area[topo[k]];
  for (let k = 0; k < topo.length; k++) { const o = topo[k]; if (recv[o] >= 0) acc[recv[o]] += acc[o]; }
  // streams, riparian strips (Código Florestal art. 4 I by river width ≈ size),
  // floodplains (HAND ≤ 4 m on rivers draining ≥ 200 km²: the várzeas)
  const rip = new Float32Array(N), drainAcc = new Float32Array(N), flood = new Uint8Array(N);
  for (let k = topo.length - 1; k >= 0; k--) {
    const o = topo[k];
    drainAcc[o] = acc[o] >= 1 || recv[o] < 0 ? acc[o] : drainAcc[recv[o]];
  }
  for (let o = 0; o < N; o++) {
    if (!elev[o]) continue;
    if (acc[o] >= 1) {
      const wM = acc[o] < 50 ? 30 : acc[o] < 1000 ? 50 : acc[o] < 10000 ? 100 : 200;
      rip[o] = Math.min(1, (2 * wM) / (Math.sqrt(area[o]) * 1000));
    }
    if (hand[o] <= 4 && drainAcc[o] >= 200) flood[o] = 1;
  }
  return {
    meta, W, H, N, west, north, step, rowArea, area, f, g, sunny, grade, elev, popIn, dir, recv, topo, acc,
    hand, basin, resCatch, rip, flood, reservoirs: meta.reservoirs,
    lonOf: (o) => west + ((o % W) + 0.5) * step,
    latOf: (o) => north - (((o / W) | 0) + 0.5) * step,
    cellOf: (lat, lon) => Math.floor((north - lat) / step) * W + Math.floor((lon - west) / step),
  };
}

// ---- helpers ----------------------------------------------------------------------
class Heap {                   // min-heap of (key, int)
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const K = this.k, V = this.v; let i = K.length; K.push(key); V.push(val);
    while (i > 0) { const p = (i - 1) >> 1; if (K[p] <= key) break; K[i] = K[p]; V[i] = V[p]; i = p; }
    K[i] = key; V[i] = val;
  }
  pop() {
    const K = this.k, V = this.v, top = V[0]; this.lastKey = K[0];
    const key = K.pop(), val = V.pop(), n = K.length;
    if (n) {
      let i = 0;
      for (;;) { const l = 2 * i + 1; if (l >= n) break; const r = l + 1; const m = r < n && K[r] < K[l] ? r : l; if (K[m] >= key) break; K[i] = K[m]; V[i] = V[m]; i = m; }
      K[i] = key; V[i] = val;
    }
    return top;
  }
}
const NB = [[0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0], [-1, 1]];
function kmBetween(ctx, a, b) {
  const la = ctx.latOf(a), lb = ctx.latOf(b);
  const x = (ctx.lonOf(b) - ctx.lonOf(a)) * Math.cos(((la + lb) / 2) * Math.PI / 180), y = lb - la;
  return Math.hypot(x, y) * 111.195;
}
// A* on the grid between two cells; cost(o) = per-km multiplier of entering o
// (Infinity = blocked). Search is confined to the endpoints' bbox ± margin.
export function astar(ctx, from, to, cost, marginCells = 60) {
  const { W, H } = ctx;
  const r0 = Math.max(0, Math.min((from / W) | 0, (to / W) | 0) - marginCells);
  const r1 = Math.min(H - 1, Math.max((from / W) | 0, (to / W) | 0) + marginCells);
  const c0 = Math.max(0, Math.min(from % W, to % W) - marginCells);
  const c1 = Math.min(W - 1, Math.max(from % W, to % W) + marginCells);
  const bw = c1 - c0 + 1, bh = r1 - r0 + 1;
  const loc = (o) => (((o / W) | 0) - r0) * bw + (o % W) - c0;
  const gScore = new Float64Array(bw * bh).fill(Infinity);
  const prev = new Int32Array(bw * bh).fill(-1);
  const closed = new Uint8Array(bw * bh);
  const cellKm = Math.sqrt(ctx.area[from]);
  const heap = new Heap();
  gScore[loc(from)] = 0;
  heap.push(kmBetween(ctx, from, to), from);
  while (heap.size) {
    const o = heap.pop(), lo = loc(o);
    if (closed[lo]) continue;
    closed[lo] = 1;
    if (o === to) break;
    const r = (o / W) | 0, c = o % W;
    for (const [ddr, ddc] of NB) {
      const rr = r + ddr, cc = c + ddc;
      if (rr < r0 || rr > r1 || cc < c0 || cc > c1) continue;
      const j = rr * W + cc, lj = loc(j);
      if (closed[lj]) continue;
      const m = cost(j);
      if (!(m < Infinity)) continue;
      const ng = gScore[lo] + cellKm * (ddr && ddc ? Math.SQRT2 : 1) * m;
      if (ng < gScore[lj]) { gScore[lj] = ng; prev[lj] = o; heap.push(ng + kmBetween(ctx, j, to), j); }
    }
  }
  if (!closed[loc(to)]) return null;
  const path = [];
  for (let o = to; o !== -1; o = prev[loc(o)]) path.push(o);
  return path.reverse();
}
// Hilbert index of (x, y) on a 2^order grid — for compact population quotas
function hilbert(x, y, order = 12) {
  let d = 0;
  for (let s = 1 << (order - 1); s > 0; s >>= 1) {
    const rx = (x & s) > 0 ? 1 : 0, ry = (y & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) { if (rx === 1) { x = s - 1 - x; y = s - 1 - y; } const t = x; x = y; y = t; }
  }
  return d;
}
// Split the populated cells into groups of ~quota people along the Hilbert
// curve; each group's population-weighted centre, snapped to its nearest cell.
function quotaCentres(ctx, cells, pop, quota) {
  const keyed = cells.map((o) => [hilbert(o % ctx.W, (o / ctx.W) | 0), o]).sort((a, b) => a[0] - b[0]);
  const out = [];
  let acc = 0, sx = 0, sy = 0, grp = [];
  const flush = () => {
    if (!acc) return;
    const cx = sx / acc, cy = sy / acc;
    let best = grp[0], bd = Infinity;
    for (const o of grp) { const d = (o % ctx.W - cx) ** 2 + (((o / ctx.W) | 0) - cy) ** 2; if (d < bd) { bd = d; best = o; } }
    out.push({ cell: best, pop: acc });
    acc = 0; sx = 0; sy = 0; grp = [];
  };
  for (const [, o] of keyed) {
    const p = pop[o]; if (!(p > 0)) continue;
    acc += p; sx += p * (o % ctx.W); sy += p * ((o / ctx.W) | 0); grp.push(o);
    if (acc >= quota) flush();
  }
  if (out.length && acc < quota / 3) {        // fold a small tail into the last group
    const last = out[out.length - 1]; last.pop += acc;
  } else flush();
  return out;
}

// ---- simulate ------------------------------------------------------------------------
export function simulate(ctx, params = {}) {
  const p = { ...DEFAULTS, ...params, firmSupply: { ...DEFAULTS.firmSupply, ...(params.firmSupply || {}) } };
  const { N, W, f, g, area } = ctx;
  const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
  const inSc = new Uint8Array(N);
  for (let o = 0; o < N; o++) {
    const b = ctx.basin[o];
    inSc[o] = b === 1 || (p.scenario === "ATPV" && b === 2) ? 1 : 0;
  }
  const use = new Uint8Array(N), flags = new Uint8Array(N);
  const cityPop = new Float32Array(N);
  const reclaimed = new Uint8Array(N);
  let P = 0;
  for (let o = 0; o < N; o++) if (inSc[o]) P += ctx.popIn[o];
  const resById = Object.fromEntries(ctx.reservoirs.map((r) => [r.id, r]));

  // 1. fixed: water, quarries
  for (let o = 0; o < N; o++) {
    if (!inSc[o]) continue;
    if (f.water[o] >= 0.5) use[o] = USE.WATER;
    else if (f.mining[o] >= 0.3) use[o] = USE.MINING;
    if (ctx.rip[o] > 0) flags[o] |= FLAG.RIPARIAN;
  }

  // 2. city
  const urbanToday = [];
  let urbanTodayKm2 = 0, redesignCentres = [];
  for (let o = 0; o < N; o++) if (inSc[o] && !use[o] && f.urban[o] >= 0.5) { urbanToday.push(o); urbanTodayKm2 += area[o]; }
  if (p.cityMode === "compact") {
    // free the least-dense cells; their people move into the remaining city
    const byDensity = urbanToday.slice().sort((a, b) => ctx.popIn[a] / area[a] - ctx.popIn[b] / area[b]);
    let freed = 0, movedPop = 0;
    const target = p.compaction * urbanTodayKm2;
    const isFreed = new Uint8Array(N);
    for (const o of byDensity) {
      if (freed >= target) break;
      isFreed[o] = 1; freed += area[o]; movedPop += ctx.popIn[o];
    }
    let keptPop = 0;
    for (const o of urbanToday) if (!isFreed[o]) keptPop += ctx.popIn[o];
    const scale = keptPop > 0 ? (keptPop + movedPop) / keptPop : 1;
    for (const o of urbanToday) {
      if (isFreed[o]) { reclaimed[o] = 1; use[o] = USE.RECLAIMED; }
      else { use[o] = USE.CITY; cityPop[o] = ctx.popIn[o] * scale; }
    }
  } else {
    // redesign: everyone in a new polycentric city at the chosen density
    const need = P / p.density;                                   // km² of city
    const suit = new Float32Array(N);
    for (let o = 0; o < N; o++) {
      if (!inSc[o] || use[o]) continue;
      const usable = (g[0][o] + g[1][o] + g[2][o]) * (1 - f.water[o]) * (1 - ctx.rip[o]) * (ctx.flood[o] ? 0 : 1);
      const prime = (g[0][o] + g[1][o]) * (f.pasture[o] + f.agri[o] + f.mosaic[o]);
      const manan = ctx.resCatch[o] & 127 && resById[ctx.resCatch[o] & 127]?.manancial ? 1 : 0;
      suit[o] = Math.max(0, usable - 0.35 * prime - 0.5 * f.forest[o] - 0.25 * manan);
    }
    // centres: best smoothed suitability, ≥ 12 km apart
    const R = 12, sm = new Float32Array(N);
    const box = 8;                                                // ~1.5 km half-window
    for (let o = 0; o < N; o++) {
      if (!suit[o]) continue;
      const r = (o / W) | 0, c = o % W;
      let s = 0;
      for (let rr = r - box; rr <= r + box; rr += 2) for (let cc = c - box; cc <= c + box; cc += 2) {
        const j = rr * W + cc; if (j >= 0 && j < N) s += suit[j];
      }
      sm[o] = s;
    }
    const cand = [];
    for (let o = 0; o < N; o++) if (sm[o] > 0) cand.push(o);
    cand.sort((a, b) => sm[b] - sm[a]);
    const centres = [];
    for (const o of cand) {
      if (centres.length >= p.centers) break;
      if (centres.every((c) => kmBetween(ctx, c, o) >= R)) centres.push(o);
    }
    // grow every centre at once (Dijkstra in "badness-weighted km"), each to an
    // equal share of the city's area
    const quota = need / Math.max(1, centres.length);
    const owner = new Int16Array(N).fill(-1), got = new Float64Array(centres.length);
    const dist = new Float64Array(N).fill(Infinity);
    const heap = new Heap();
    centres.forEach((c, k) => { dist[c] = 0; heap.push(0, c * 64 + k); });
    while (heap.size) {
      const v = heap.pop(), o = Math.floor(v / 64), k = v % 64, d = heap.lastKey;
      if (owner[o] >= 0 || got[k] >= quota || d > dist[o] + 1e-9) continue;
      owner[o] = k; got[k] += area[o];
      const r = (o / W) | 0, c = o % W;
      for (const [ddr, ddc] of NB) {
        const j = (r + ddr) * W + c + ddc;
        if (j < 0 || j >= N || owner[j] >= 0 || suit[j] < 0.25) continue;
        const nd = d + (ddr && ddc ? 1.414 : 1) * (1 + 3 * (1 - suit[j]));
        if (nd < dist[j]) { dist[j] = nd; heap.push(nd, j * 64 + k); }
      }
    }
    let cityKm2 = 0;
    for (let o = 0; o < N; o++) if (owner[o] >= 0) { use[o] = USE.CITY; cityKm2 += area[o]; }
    for (let o = 0; o < N; o++) if (use[o] === USE.CITY) cityPop[o] = (P * area[o]) / cityKm2;
    for (const o of urbanToday) if (use[o] !== USE.CITY) { use[o] = USE.RECLAIMED; reclaimed[o] = 1; }
    redesignCentres = centres;
  }
  let cityKm2 = 0, cityPopSum = 0;
  for (let o = 0; o < N; o++) if (use[o] === USE.CITY) { cityKm2 += area[o]; cityPopSum += cityPop[o]; flags[o] |= FLAG.ROOF_PV; }

  // distance (km) from the city, over the scenario
  const distCity = new Float32Array(N).fill(Infinity);
  {
    const heap = new Heap();
    for (let o = 0; o < N; o++) if (use[o] === USE.CITY) { distCity[o] = 0; heap.push(0, o); }
    while (heap.size) {
      const o = heap.pop(), d = heap.lastKey;
      if (d > distCity[o]) continue;
      const r = (o / W) | 0, c = o % W, step = Math.sqrt(area[o]);
      for (const [ddr, ddc] of NB) {
        const j = (r + ddr) * W + c + ddc;
        if (j < 0 || j >= N || !inSc[j]) continue;
        const nd = d + step * (ddr && ddc ? Math.SQRT2 : 1);
        if (nd < distCity[j]) { distCity[j] = nd; heap.push(nd, j); }
      }
    }
  }

  // 3. timber: keep plantations (moderate slopes first) up to the target
  const timberTarget = (p.timberKm2PerM * P) / 1e6;
  let timberKm2 = 0;
  {
    const pl = [];
    for (let o = 0; o < N; o++) if (inSc[o] && !use[o] && f.plantation[o] >= 0.5) pl.push(o);
    pl.sort((a, b) => (g[2][b] + g[3][b]) - (g[2][a] + g[3][a]));
    for (const o of pl) {
      if (timberKm2 >= timberTarget) break;
      use[o] = USE.TIMBER; timberKm2 += area[o] * f.plantation[o];
    }
  }

  // 4–6. food. cover = land that can be farmed without clearing native vegetation
  const cover = new Float32Array(N);
  const farmOK = new Uint8Array(N);
  for (let o = 0; o < N; o++) {
    if (!inSc[o] || use[o]) continue;
    let cv = f.pasture[o] + f.agri[o] + f.mosaic[o] + f.bare[o] + f.plantation[o];
    if (reclaimed[o]) cv = 1 - f.water[o];
    if (p.allowForestClearing) cv += f.forest[o];
    cover[o] = Math.min(1, cv);
    const manan = (ctx.resCatch[o] & 127) && resById[ctx.resCatch[o] & 127]?.manancial;
    farmOK[o] = cover[o] >= 0.5 && (p.farmFloodplains || !ctx.flood[o]) && !(p.protectMananciais && manan) ? 1 : 0;
  }
  const effGentle = (o) => area[o] * cover[o] * (g[0][o] + g[1][o]) * (1 - ctx.rip[o]);
  const effTerrace = (o) => area[o] * cover[o] * g[2][o] * (1 - ctx.rip[o]);
  const kcalPerKm2 = p.insolation * 1e6 * 860.42;                     // kWh/m² → kcal per km²
  const harvestKcal = (P * p.kcal * 365) / (1 - p.loss);
  const foodKm2Need = harvestKcal / (p.cropEff * kcalPerKm2);         // effective field km²
  const vegKm2Need = (P * p.vegKgPerCap) / (p.vegYieldTHa * 1000) / 100;   // ha → km²
  let vegKm2 = 0, stapleKm2 = 0, terraceKm2 = 0;
  {
    const cand = [];
    for (let o = 0; o < N; o++) if (farmOK[o] && use[o] === 0) cand.push(o);
    // vegetables: nearest the city
    cand.sort((a, b) => distCity[a] - distCity[b]);
    for (const o of cand) {
      if (vegKm2 >= vegKm2Need) break;
      const e = effGentle(o);
      if (e < area[o] * 0.25) continue;
      use[o] = USE.VEG; vegKm2 += e;
    }
    // staples: flattest first, mild preference for proximity
    const score = (o) => (g[0][o] + g[1][o]) * cover[o] - 0.002 * Math.min(distCity[o], 150);
    const rest = cand.filter((o) => use[o] === 0).sort((a, b) => score(b) - score(a));
    for (const o of rest) {
      if (stapleKm2 >= foodKm2Need) break;
      const e = effGentle(o);
      if (e < area[o] * 0.2) continue;
      use[o] = USE.STAPLE; stapleKm2 += e;
    }
  }

  // 7. energy and ground solar
  let floatKm2 = 0;
  const resInSc = ctx.reservoirs.filter((r) => {
    const o = ctx.cellOf(r.lat, r.lon); return inSc[o] || ctx.basin[o] === 1 || (p.scenario === "ATPV" && ctx.basin[o] === 2);
  });
  for (let o = 0; o < N; o++) if (use[o] === USE.WATER && (ctx.resCatch[o] & 128) && p.floatCover > 0) {
    flags[o] |= FLAG.FLOAT_PV; floatKm2 += area[o] * f.water[o] * p.floatCover;
  }
  const pvGWhPerKm2 = p.insolation * p.pvEff;                          // GWh per km² of land
  // water first: reuse pumping + treatment energy enters the demand
  const water = waterBalance(ctx, p, use, cityPop, inSc);
  const sewage = sewageNetwork(ctx, p, use, cityPop, inSc);
  const reuse = reuseMains(ctx, p, sewage, water, inSc, use);
  const demandTWh = (P * p.energyMWhPerCap) / 1e6 + water.energyTWh;
  const roofTWh = (cityKm2 * p.roofGWhPerKm2) / 1000;
  const floatTWh = (floatKm2 * pvGWhPerKm2) / 1000;
  const biogasTWh = (P * p.biogasMWhPerCap) / 1e6;
  const gapTWh = Math.max(0, demandTWh * (1 + p.storageLoss) - roofTWh - floatTWh - biogasTWh);
  const pvKm2Need = (gapTWh * 1000) / pvGWhPerKm2;
  let pvKm2 = 0;
  {
    const cand = [];
    for (let o = 0; o < N; o++) {
      if (!inSc[o] || use[o] && use[o] !== USE.RECLAIMED) continue;
      if (ctx.flood[o]) continue;
      const cv = reclaimed[o] ? 1 - f.water[o] : cover[o];
      if (cv < 0.5 || g[0][o] + g[1][o] + g[2][o] < 0.5) continue;
      cand.push(o);
    }
    const sc = (o) => ctx.sunny[o] + 0.6 * reclaimed[o] + 0.4 * g[2][o] - 0.25 * (g[0][o] + g[1][o]) - 0.004 * Math.min(distCity[o], 100);
    cand.sort((a, b) => sc(b) - sc(a));
    for (const o of cand) {
      if (pvKm2 >= pvKm2Need) break;
      const cv = reclaimed[o] ? 1 - f.water[o] : cover[o];
      use[o] = USE.PV; pvKm2 += area[o] * cv * (g[0][o] + g[1][o] + g[2][o]) * (1 - ctx.rip[o]);
    }
  }
  const groundTWh = (pvKm2 * pvGWhPerKm2) / 1000;

  // 7b. terraces and agroforestry on the moderate slopes solar did not take —
  // the lowest-yield food, so it comes after the far more land-efficient solar
  if (p.allowTerraces && stapleKm2 < foodKm2Need) {
    const ter = [];
    for (let o = 0; o < N; o++) if (farmOK[o] && use[o] === 0 && g[2][o] >= 0.3) ter.push(o);
    ter.sort((a, b) => effTerrace(b) / area[b] - effTerrace(a) / area[a]);
    for (const o of ter) {
      if (stapleKm2 + terraceKm2 * p.terraceFactor >= foodKm2Need) break;
      use[o] = USE.TERRACE; terraceKm2 += effTerrace(o);
    }
  }
  const foodShare = Math.min(1, (stapleKm2 + terraceKm2 * p.terraceFactor) / foodKm2Need);

  // 8. reforestation, then what is left
  let reforestKm2 = 0;
  for (let o = 0; o < N; o++) {
    if (!inSc[o] || use[o] && use[o] !== USE.RECLAIMED) continue;
    if (use[o] === USE.RECLAIMED) continue;          // parks stay parks
    const steep = g[3][o] + g[4][o] + g[5][o];
    const cleared = f.pasture[o] + f.agri[o] + f.mosaic[o] + f.plantation[o] + f.bare[o];
    if (p.reforest && cleared >= 0.5 && steep >= 0.4) { use[o] = USE.REFOREST; reforestKm2 += area[o] * cleared; continue; }
    if (ctx.flood[o]) { use[o] = USE.FLOOD; continue; }
    if (f.forest[o] >= Math.max(cleared, f.natOpen[o])) use[o] = USE.FOREST;
    else if (f.natOpen[o] >= cleared) use[o] = USE.NATURAL;
    else use[o] = USE.RESERVE;
  }
  for (let o = 0; o < N; o++) {
    if ((use[o] === USE.STAPLE || use[o] === USE.VEG || use[o] === USE.TERRACE)) {
      const id = ctx.resCatch[o] & 127;
      if (id && resById[id]?.manancial) flags[o] |= FLAG.MANANCIAL;
    }
  }

  // 9. networks
  const irrigation = irrigationNet(ctx, p, sewage, use, flags, reuse);
  const transitCentres = quotaCentres(ctx, (() => { const a = []; for (let o = 0; o < N; o++) if (use[o] === USE.CITY) a.push(o); return a; })(), cityPop, p.transitPop);
  const recycling = quotaCentres(ctx, (() => { const a = []; for (let o = 0; o < N; o++) if (use[o] === USE.CITY) a.push(o); return a; })(), cityPop, p.recyclePop);
  const corridors = transitNet(ctx, transitCentres, use, inSc);
  const mains = waterMains(ctx, transitCentres, use, inSc, p);
  const extraction = extractionSites(ctx, use, inSc, p);
  const storage = storagePlan(ctx, p, demandTWh, inSc);
  const phosphorus = phosphorusCheck(ctx, p, use);

  // 10. stats
  const byUse = USE_INFO.map(() => ({ 1: 0, 2: 0 }));
  for (let o = 0; o < N; o++) if (inSc[o]) byUse[use[o]][ctx.basin[o]] += area[o];
  const ms = (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0;
  return {
    params: p, use, flags, cityPop,
    networks: { sewers: sewage.trunks, plants: sewage.plants, reuse: reuse.lines, irrigation: irrigation.lines, corridors, mains },
    points: { recycling, transit: transitCentres, extraction, storage: storage.sites, redesignCentres },
    stats: {
      ms: Math.round(ms), P, cityKm2, cityPop: cityPopSum, density: cityPopSum / cityKm2, urbanTodayKm2,
      byUse,
      food: { needKm2: foodKm2Need, stapleKm2, terraceKm2, share: foodShare, vegNeedKm2: vegKm2Need, vegKm2, vegShare: Math.min(1, vegKm2 / vegKm2Need) },
      energy: { demandTWh, roofTWh, floatTWh, biogasTWh, groundTWh, gapTWh, pvKm2Need, pvKm2, floatKm2, closes: groundTWh >= gapTWh * 0.999, ...storage.summary },
      water, sewage: sewage.summary, reuse: reuse.summary, irrigation: irrigation.summary,
      timber: { targetKm2: timberTarget, km2: timberKm2 },
      reforestKm2, phosphorus,
      materials: { recyclingCentres: recycling.length, extractionSites: extraction.length },
      transit: { centres: transitCentres.length, km: corridors.reduce((s, c) => s + c.km, 0) },
    },
  };
}

// ---- water ----------------------------------------------------------------------------
function waterBalance(ctx, p, use, cityPop, inSc) {
  const out = { basins: {}, energyTWh: 0 };
  for (const b of [1, 2]) {
    let pop = 0;
    for (let o = 0; o < ctx.N; o++) if (inSc[o] && ctx.basin[o] === b) pop += use[o] === USE.CITY ? cityPop[o] : (use[o] === USE.RECLAIMED ? 0 : ctx.popIn[o] * (p.cityMode === "redesign" ? 0 : 1));
    if (!pop) continue;
    const perS = 1 / 86400 / 1000;
    const demand = (pop * p.waterLpcd) / (1 - p.waterLoss) * perS;          // m³/s at the plant
    const sewage = pop * p.waterLpcd * p.returnFrac * p.collectFrac * perS;
    const reusable = sewage * p.reuseRecovery;
    const firm = p.firmSupply[b] ?? 0;
    const reuseNeed = Math.max(0, demand - firm);
    out.basins[b] = { pop, demand, sewage, reusable, firm, reuseNeed, reuse: Math.min(reusable, reuseNeed), closes: reusable + firm >= demand };
  }
  return out;
}

// Sewers follow the D8 drainage (gravity). Population accumulates downstream;
// a treatment plant is sited where the unassigned load reaches the plant cap,
// where a trunk leaves the city with a meaningful load, or at the basin edge.
function sewageNetwork(ctx, p, use, cityPop, inSc) {
  const { N, topo, recv } = ctx;
  const u = new Float64Array(N);
  const plantAt = new Int32Array(N).fill(-1);
  const plants = [];
  let local = 0;
  const trunks = [];
  for (let k = 0; k < topo.length; k++) {
    const o = topo[k];
    if (!inSc[o]) continue;
    if (use[o] === USE.CITY) u[o] += cityPop[o];
    if (u[o] <= 0) continue;
    const j = recv[o];
    const leavesScenario = j < 0 || !inSc[j];
    const leavesCity = use[o] === USE.CITY && j >= 0 && use[j] !== USE.CITY;
    const atWater = j >= 0 && use[j] === USE.WATER && (ctx.resCatch[j] & 128);
    let place = u[o] >= p.plantCap || leavesScenario || atWater;
    if (!place && leavesCity && u[o] >= p.plantMin) {
      // only if the trunk stays out of the city for the next ~3 km
      let x = j, steps = 0, reenters = false;
      while (x >= 0 && steps < 18) { if (use[x] === USE.CITY) { reenters = true; break; } x = recv[x]; steps++; }
      place = !reenters;
    }
    if (place && u[o] < p.plantMin) {
      // too small for a plant: a decentralized system (biodigester / compact
      // package plant) where the trunk leaves the city
      if (leavesCity || leavesScenario || atWater) { local += u[o]; continue; }
    }
    if (u[o] >= p.trunkMin && j >= 0 && inSc[j]) trunks.push([o, j, u[o]]);
    if (place && u[o] >= p.plantMin) {
      const flow = (u[o] * p.waterLpcd * p.returnFrac * p.collectFrac) / 86400 / 1000;
      plantAt[o] = plants.length;
      plants.push({ cell: o, pop: u[o], flow, basin: ctx.basin[o], elev: ctx.elev[o] });
      continue;                                  // effluent goes to the river, not on
    }
    if (j >= 0 && inSc[j]) u[j] += u[o];
  }
  const served = plants.reduce((s, x) => s + x.pop, 0);
  return { plants, trunks, summary: { plants: plants.length, served, local, flowM3s: plants.reduce((s, x) => s + x.flow, 0) } };
}

// Recycled water (indirect potable reuse) goes from each plant back up to the
// nearest drinking-water reservoir of its basin. Pumping energy from the DEM
// head with São Paulo gravity; treatment at ~1 kWh/m³ (MF/RO/UV-AOP).
function reuseMains(ctx, p, sewage, water, inSc, use) {
  const lines = [];
  const mananciais = ctx.reservoirs.filter((r) => r.manancial);
  let energyKWhYr = 0, reusedM3s = 0;
  for (const b of [1, 2]) {
    const wb = water.basins[b];
    if (!wb || !wb.reuseNeed) continue;
    const plants = sewage.plants.filter((x) => x.basin === b);
    const total = plants.reduce((s, x) => s + x.flow, 0);
    if (!total) continue;
    const share = Math.min(1, wb.reuse / (total * p.reuseRecovery));
    const res = mananciais.filter((r) => ctx.basin[ctx.cellOf(r.lat, r.lon)] === b);
    for (const pl of plants) {
      const q = pl.flow * p.reuseRecovery * share;
      if (q < 0.05 || !res.length) continue;
      let best = res[0], bd = Infinity;
      for (const r of res) { const d = kmBetween(ctx, pl.cell, ctx.cellOf(r.lat, r.lon)); if (d < bd) { bd = d; best = r; } }
      const target = nearestWaterCell(ctx, ctx.cellOf(best.lat, best.lon), pl.cell, use);
      const path = astar(ctx, pl.cell, target, (o) => inSc[o] ? 1 + 3 * ctx.grade[o] : 4, 40) || [pl.cell, target];
      const head = Math.max(0, best.levelM - pl.elev);
      // static head + ~1 m/km of friction in a large main; pumps at η 0.75;
      // + ~1 kWh/m³ of advanced treatment (MF/RO/UV-AOP)
      const kWhPerM3 = (G_SP * (head + 1.0 * pathKm(ctx, path))) / 3600 / 0.75 + 1.0;
      energyKWhYr += q * 31.557e6 * kWhPerM3;
      reusedM3s += q;
      lines.push({ path, flow: q, to: best.name, headM: Math.round(head), kWhPerM3 });
    }
  }
  water.energyTWh = energyKWhYr / 1e9;
  return { lines, summary: { reusedM3s, energyTWh: energyKWhYr / 1e9 } };
}
function pathKm(ctx, path) {
  let s = 0; for (let k = 1; k < path.length; k++) s += kmBetween(ctx, path[k - 1], path[k]); return s;
}
function nearestWaterCell(ctx, around, toward, use) {
  // the reservoir cell closest to `toward`, searched in a window around the centroid
  const { W } = ctx;
  const r0 = (around / W) | 0, c0 = around % W;
  let best = around, bd = Infinity;
  for (let r = r0 - 60; r <= r0 + 60; r += 1) for (let c = c0 - 60; c <= c0 + 60; c += 1) {
    const o = r * W + c;
    if (o < 0 || o >= ctx.N || use[o] !== USE.WATER || !(ctx.resCatch[o] & 128)) continue;
    const d = kmBetween(ctx, o, toward);
    if (d < bd) { bd = d; best = o; }
  }
  return best;
}

// Fertigation: farms within reach of a plant (and at most ~60 m above it)
// take the effluent not sent back for drinking — nutrients included.
function irrigationNet(ctx, p, sewage, use, flags, reuse) {
  const lines = [];
  let km2 = 0, needM3s = 0;
  if (!p.fertigate) return { lines, summary: { km2, needM3s, availM3s: 0 } };
  const reusedFromPlant = new Map();
  for (const l of reuse.lines) reusedFromPlant.set(l.path[0], (reusedFromPlant.get(l.path[0]) || 0) + l.flow);
  let avail = 0;
  for (const pl of sewage.plants) avail += Math.max(0, pl.flow - (reusedFromPlant.get(pl.cell) || 0));
  const { W, N } = ctx;
  for (const pl of sewage.plants) {
    const spare = Math.max(0, pl.flow - (reusedFromPlant.get(pl.cell) || 0));
    if (spare < 0.02) continue;
    const r0 = (pl.cell / W) | 0, c0 = pl.cell % W;
    const rad = Math.ceil(p.irrigationKm / Math.sqrt(ctx.area[pl.cell]));
    let sx = 0, sy = 0, n = 0, myKm2 = 0;
    const capKm2 = (spare * 31.557e6) / (p.irrigationM * 1e6);      // what this plant's spare water can wet
    const cells = [];
    for (let r = r0 - rad; r <= r0 + rad; r++) for (let c = c0 - rad; c <= c0 + rad; c++) {
      const o = r * W + c;
      if (o < 0 || o >= N || (flags[o] & FLAG.IRRIGATED)) continue;
      if (use[o] !== USE.VEG && use[o] !== USE.STAPLE && use[o] !== USE.TERRACE) continue;
      if (ctx.elev[o] > pl.elev + 60) continue;
      const d = kmBetween(ctx, o, pl.cell);
      if (d <= p.irrigationKm) cells.push([d, o]);
    }
    cells.sort((a, b) => a[0] - b[0]);
    for (const [, o] of cells) {
      if (myKm2 >= capKm2) break;
      flags[o] |= FLAG.IRRIGATED; myKm2 += ctx.area[o];
      sx += o % W; sy += (o / W) | 0; n++;
    }
    if (n) {
      km2 += myKm2;
      needM3s += (myKm2 * 1e6 * p.irrigationM) / 31.557e6;
      const cen = Math.round(sy / n) * W + Math.round(sx / n);
      lines.push({ path: [pl.cell, cen], km2: myKm2 });
    }
  }
  return { lines, summary: { km2, needM3s, availM3s: avail } };
}

// Rail / bus / e-bike trunk corridors between population centres: a minimum
// spanning tree plus each centre's second-nearest link (loops), routed by A*
// with a grade penalty above 3 % (rail-friendly) and a toll for crossing water.
function transitNet(ctx, centres, use, inSc) {
  const n = centres.length;
  if (n < 2) return [];
  const D = (a, b) => kmBetween(ctx, centres[a].cell, centres[b].cell);
  const inTree = new Uint8Array(n), best = new Float64Array(n).fill(Infinity), parent = new Int32Array(n).fill(-1);
  best[0] = 0;
  const edges = [];
  for (let it = 0; it < n; it++) {
    let u = -1;
    for (let v = 0; v < n; v++) if (!inTree[v] && (u < 0 || best[v] < best[u])) u = v;
    inTree[u] = 1;
    if (parent[u] >= 0) edges.push([parent[u], u]);
    for (let v = 0; v < n; v++) if (!inTree[v] && D(u, v) < best[v]) { best[v] = D(u, v); parent[v] = u; }
  }
  const key = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);
  const have = new Set(edges.map(([a, b]) => key(a, b)));
  for (let a = 0; a < n; a++) {
    const near = [...Array(n).keys()].filter((b) => b !== a).sort((x, y) => D(a, x) - D(a, y));
    const b = near[1];
    if (b !== undefined && D(a, b) < 25 && !have.has(key(a, b))) { have.add(key(a, b)); edges.push([a, b]); }
  }
  const cost = (o) => {
    if (!inSc[o]) return 6;
    const gr = ctx.grade[o];
    return 1 + 25 * Math.max(0, gr - 0.03) + (use[o] === USE.WATER ? 3 : 0) + (use[o] === USE.FOREST ? 0.5 : 0);
  };
  return edges.map(([a, b]) => {
    const path = astar(ctx, centres[a].cell, centres[b].cell, cost, 40) || [centres[a].cell, centres[b].cell];
    return { path, km: pathKm(ctx, path), from: a, to: b };
  });
}

// Treated-water trunk mains: each population centre from its nearest
// drinking-water reservoir, routed by A* (gentle ground preferred).
function waterMains(ctx, centres, use, inSc, p) {
  const res = ctx.reservoirs.filter((r) => r.manancial && inSc[ctx.cellOf(r.lat, r.lon)]);
  if (!res.length) return [];
  const out = [];
  for (const c of centres) {
    let best = null, bd = Infinity;
    for (const r of res) { const d = kmBetween(ctx, c.cell, ctx.cellOf(r.lat, r.lon)); if (d < bd) { bd = d; best = r; } }
    const from = nearestWaterCell(ctx, ctx.cellOf(best.lat, best.lon), c.cell, use);
    const path = astar(ctx, from, c.cell, (o) => (inSc[o] ? 1 + 4 * ctx.grade[o] : 5), 30) || [from, c.cell];
    out.push({ path, from: best.name, pop: c.pop });
  }
  return out;
}

// Extraction: today's quarries and sand pits (MapBiomas mining), clustered,
// plus the point-like outside sources agreed for the bulk-materials loop.
export const FIXED_SITES = [
  { name: "Cajamar limestone (lime, cement)", lat: -23.355, lon: -46.877, kind: "limestone" },
  { name: "Sorocaba–Votorantim limestone, ~100 km west (off-map)", lat: -23.52, lon: -47.22, kind: "limestone", offMap: true },
  { name: "Sea-salt intake → soda ash, sodium-ion batteries (Cubatão estuary)", lat: -23.90, lon: -46.40, kind: "salt", offMap: true },
];
function extractionSites(ctx, use, inSc, p) {
  const { N, W } = ctx;
  const seen = new Uint8Array(N), sites = [];
  for (let s = 0; s < N; s++) {
    if (seen[s] || use[s] !== USE.MINING) continue;
    const q = [s]; seen[s] = 1;
    let A = 0, sx = 0, sy = 0;
    for (let h = 0; h < q.length; h++) {
      const o = q[h], r = (o / W) | 0, c = o % W;
      A += ctx.area[o]; sx += c; sy += r;
      for (const [ddr, ddc] of NB) {
        const j = (r + ddr) * W + c + ddc;
        if (j >= 0 && j < N && !seen[j] && use[j] === USE.MINING) { seen[j] = 1; q.push(j); }
      }
    }
    const cell = Math.round(sy / q.length) * W + Math.round(sx / q.length);
    const onFloodplain = ctx.flood[cell] === 1;
    sites.push({ cell, km2: A, kind: onFloodplain ? "sand" : "aggregate", name: onFloodplain ? "Floodplain sand pit" : "Quarry (crushed stone, aggregate)" });
  }
  for (const s of FIXED_SITES) sites.push({ ...s, cell: ctx.cellOf(s.lat, s.lon), km2: 0 });
  return sites;
}

// Storage: Henry Borden as a reversible water battery (both scenarios) and,
// with the Paraíba Valley, the best pumped-storage head on the Mantiqueira
// escarpment (both reservoirs inside the region).
function storagePlan(ctx, p, demandTWh, inSc) {
  const needGWhDay = (demandTWh * 1000 * p.storageShare) / 365;
  const sites = [{ name: "Henry Borden, made reversible (Billings → Cubatão, ~720 m head)", lat: -23.855, lon: -46.475, gwh: p.hbGWh, kind: "psh" }];
  if (p.scenario === "ATPV") {
    const { N, W } = ctx;
    // upper reservoir: a gentle hollow above 1,200 m; lower: the valley floor
    // (HAND ≤ 10 m, gentle); 1.5–8 km apart with L/H ≤ 8; the highest head
    // within 600–1,000 m, the range built pumped-storage plants work at
    const g = ctx.g;
    const gentle = (o) => g[0][o] + g[1][o] >= 0.3;
    let best = null;
    for (let o = 0; o < N; o++) {
      if (ctx.basin[o] !== 2 || ctx.elev[o] < 1200 || !gentle(o)) continue;
      const r0 = (o / W) | 0, c0 = o % W;
      for (let r = r0 - 46; r <= r0 + 46; r += 2) for (let c = c0 - 46; c <= c0 + 46; c += 2) {
        const j = r * W + c;
        if (j < 0 || j >= N || ctx.basin[j] !== 2 || ctx.hand[j] > 10 || !gentle(j) || ctx.elev[j] >= 800) continue;
        const head = ctx.elev[o] - ctx.elev[j];
        if (head < 600 || head > 1000 || (best && head <= best.head)) continue;
        const km = kmBetween(ctx, o, j);
        if (km < 1.5 || km > 8 || km * 1000 > 8 * head) continue;
        best = { up: o, low: j, head, km };
      }
    }
    if (best) sites.push({ name: `Mantiqueira pumped storage candidate (${Math.round(best.head)} m head over ${best.km.toFixed(1)} km)`,
      lat: ctx.latOf(best.up), lon: ctx.lonOf(best.up), lowLat: ctx.latOf(best.low), lowLon: ctx.lonOf(best.low), gwh: p.pshGWh, kind: "psh", head: best.head });
  }
  const pumped = sites.reduce((s, x) => s + x.gwh, 0);
  return { sites, summary: { storageNeedGWhDay: needGWhDay, pumpedGWh: pumped, batteryGWh: Math.max(0, needGWhDay - pumped) } };
}

// Phosphorus reaching each drinking-water reservoir from the farms in its
// incremental catchment, as a mean concentration in that catchment's runoff
// (CONAMA 357/2005 class 2, lentic: 0.030 mg/L total P).
function phosphorusCheck(ctx, p, use) {
  const rows = [];
  for (const r of ctx.reservoirs) {
    if (!r.manancial) continue;
    let farm = 0;
    for (let o = 0; o < ctx.N; o++) {
      if ((ctx.resCatch[o] & 127) !== r.id) continue;
      if (use[o] === USE.STAPLE || use[o] === USE.VEG || use[o] === USE.TERRACE) farm += ctx.area[o];
    }
    const loadKg = farm * 100 * p.pLossKgHa;
    const runoffM3 = r.catchKm2 * 1e6 * p.runoffM;
    const mgL = runoffM3 > 0 ? (loadKg * 1e6) / (runoffM3 * 1000) : 0;
    rows.push({ name: r.name, catchKm2: r.catchKm2, farmKm2: farm, mgL, ok: mgL <= p.pLimitMgL });
  }
  return rows;
}
