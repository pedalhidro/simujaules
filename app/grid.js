// The compute grid: mask GeoTIFF read/resample, bridge corridors,
// buildComputeGrid(), buildPortals(), deck pass stamping.
import "./geotiff.js"; // evaluation order — see ../app.js
import { t } from "./i18n.js";
import { state } from "./state.js";
import { llToCell } from "./bridges.js";
import { overlayCanvasDims } from "./render.js";

// ===================== Impassable mask + bridge corridors =====================
// An optional binary raster ("water") marks cells impassable. It is resampled
// onto the DEM grid by AREA-COVERAGE MAJORITY (a DEM cell is impassable iff
// ≥50% of its footprint is impassable in the source). The loaded vector network
// can OPTIONALLY carve passable "bridge" corridors across the mask: each
// corridor cell is levelled to a smooth profile — land elevation at each shore
// entrance, a linear ramp up to (+/-offset) at the bridge centre, then back
// down. Everything is composed in buildComputeGrid() *before* the grid reaches
// the worker/backend, so the engines are unchanged AND a run with no/all-zero
// mask is byte-identical to before (see buildComputeGrid).

function geoKeysToEpsg(gk) {
  if (!gk) return null;
  return gk.ProjectedCSTypeGeoKey || gk.ProjectedCRSGeoKey ||
         gk.GeographicTypeGeoKey || gk.GeodeticCRSGeoKey || null;
}

// Resolve a proj4 source key for an EPSG code, registering WGS84/UTM defs
// formulaically (proj4 only ships 4326 + a handful). Returns "EPSG:4326" for
// geographic codes, a registered "EPSG:<code>" for WGS84/UTM, or null if the
// code is projected-but-unknown (caller then assumes DEM-aligned coords).
function proj4DefForEpsg(code) {
  if (!code || code === 4326 || code === 4269 || code === 4979) return "EPSG:4326";
  const key = `EPSG:${code}`;
  try { if (proj4.defs(key)) return key; } catch {}
  if (code >= 32601 && code <= 32660) {
    proj4.defs(key, `+proj=utm +zone=${code - 32600} +datum=WGS84 +units=m +no_defs`);
    return key;
  }
  if (code >= 32701 && code <= 32760) {
    proj4.defs(key, `+proj=utm +zone=${code - 32700} +south +datum=WGS84 +units=m +no_defs`);
    return key;
  }
  return null;
}

// Parse an uploaded mask GeoTIFF → { width, height, data, dx, dy, originX,
// originY, epsg }. dx/dy are positive (pixel size); originX/Y is the top-left.
export async function readMaskGeoTIFF(arrayBuffer) {
  const tiff = await GeoTIFF.fromArrayBuffer(arrayBuffer);
  const image = await tiff.getImage();
  const width = image.getWidth();
  const height = image.getHeight();
  const tiePoints = await image.getTiePoints();
  const scale = image.fileDirectory.getValue("ModelPixelScale");
  if (!scale || !tiePoints?.length) {
    throw new Error(t("status.mask_no_geotransform"));
  }
  // samples: [0] selects band 0 explicitly — without it, a multi-band mask
  // GeoTIFF would be read pixel-interleaved and misread the same way a
  // multi-band DEM would (see loadDemFromArrayBuffer).
  const data = await image.readRasters({ samples: [0], interleave: true });
  let geoKeys = null;
  try { geoKeys = image.getGeoKeys ? image.getGeoKeys() : null; } catch {}
  return {
    width, height, data,
    dx: Math.abs(scale[0]), dy: Math.abs(scale[1]),
    originX: tiePoints[0].x, originY: tiePoints[0].y,
    epsg: geoKeysToEpsg(geoKeys),
  };
}

// Resample a parsed mask raster onto the DEM grid → Uint8Array (1=impassable),
// area-coverage majority (≥50%) via adaptive S×S sub-sampling of each DEM cell.
// Sub-points outside the source extent count as PASSABLE (the "missing = passable"
// rule). Only meaningful for geographic DEMs (the rest of the app is gated the
// same way). `invert` flips the source convention (uploaded raster marks passable).
export function resampleMaskToDem(raster, dem, opts = {}) {
  const invert = !!opts.invert;
  const { H, W, originX, originY, dx, dy, isGeographic } = dem;
  const out = new Uint8Array(W * H); // 0 = passable
  // Nearest-pixel sub-point sampler: value>0 (xor invert) → impassable.
  const sample = (mx, my) => {
    const mc = Math.floor((mx - raster.originX) / raster.dx);
    const mr = Math.floor((raster.originY - my) / raster.dy);
    if (mc < 0 || mc >= raster.width || mr < 0 || mr >= raster.height) return 0; // missing = passable
    const v = raster.data[mr * raster.width + mc] > 0;
    return (v !== invert) ? 1 : 0;
  };
  // CRS: DEM is lon/lat (4326) when geographic. Reproject DEM sub-points into
  // the mask CRS only when it differs and we can build a def; otherwise assume
  // the mask shares the DEM's coordinate space (fail-safe: surfaces as a 0-cell
  // result in imp-meta if it doesn't).
  const demKey = isGeographic ? "EPSG:4326" : proj4DefForEpsg(geoKeysToEpsg(dem.geoKeys));
  const maskKey = proj4DefForEpsg(raster.epsg);
  const reproject = (demKey && maskKey && demKey !== maskKey)
    ? (x, y) => proj4(demKey, maskKey, [x, y]) : null;
  // Sub-samples per axis ≈ source pixels spanned by a DEM cell, capped at 8.
  // A finer source is area-averaged; an equal/coarser source collapses to S=1
  // (a single centre sample — correct, one source pixel spans the DEM cell).
  const S = reproject ? 4 : Math.max(1, Math.min(8, Math.ceil(dx / raster.dx)));
  const S2 = S * S;
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      let hit = 0;
      for (let j = 0; j < S; j++) {
        const y = originY - (r + (j + 0.5) / S) * dy;
        for (let i = 0; i < S; i++) {
          const x = originX + (c + (i + 0.5) / S) * dx;
          if (reproject) { const p = reproject(x, y); hit += sample(p[0], p[1]); }
          else hit += sample(x, y);
        }
      }
      out[r * W + c] = (hit * 2 >= S2) ? 1 : 0; // ≥50% coverage → impassable
    }
  }
  return out;
}

// The corridor elevation offset, clamped to the supported bridge range.
export function corridorOffsetMetres() {
  const v = parseFloat(document.getElementById("imp-offset")?.value);
  if (!Number.isFinite(v)) return 0;
  return Math.max(-5, Math.min(15, v));
}

// Local-graph Dijkstra (binary heap) from a set of seed nodes; edge weights in
// metres. Returns a Float64Array of geodesic distances (Infinity if unreached —
// e.g. cells in a different corridor component). m = node count.
function dijkstraLocal(seeds, nbr, nbrLen, m) {
  const dist = new Float64Array(m).fill(Infinity);
  const heap = []; // [dist, node]
  const push = (d, n) => {
    heap.push([d, n]); let i = heap.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last; let i = 0;
      for (;;) {
        let l = 2 * i + 1, rr = 2 * i + 2, s = i;
        if (l < heap.length && heap[l][0] < heap[s][0]) s = l;
        if (rr < heap.length && heap[rr][0] < heap[s][0]) s = rr;
        if (s === i) break;
        [heap[s], heap[i]] = [heap[i], heap[s]]; i = s;
      }
    }
    return top;
  };
  for (const s of seeds) if (dist[s] !== 0) { dist[s] = 0; push(0, s); }
  while (heap.length) {
    const [d, u] = pop();
    if (d > dist[u]) continue;
    const ns = nbr[u], ls = nbrLen[u];
    for (let k = 0; k < ns.length; k++) {
      const v = ns[k], nd = d + ls[k];
      if (nd < dist[v]) { dist[v] = nd; push(nd, v); }
    }
  }
  return dist;
}

// Recompute the cached bridge corridors (network ∩ impassable cells, reopened
// and levelled). Runs only on mask/network/corridor-toggle change — cheap, and
// keeps buildComputeGrid() a pure apply. Per connected corridor component:
//   • shore "entrances" = corridor cells touching a valid land-network cell,
//     grouped into clusters (the two bridge ends);
//   • base elevation = linear interpolation between the two ends (t along the
//     bridge); 1 end → flat; ≥3 ends → inverse-distance blend (rare junctions);
//   • ramp = geodesic distance to the nearest entrance ÷ its component max
//     (0 at the entrances, 1 at the centre) — the offset is scaled by this, so
//     height = base + offset·ramp gives a smooth ramp up to the bridge centre.
// Components with no land entrance are left blocked (can't bridge to nowhere).
export function recomputeCorridors() {
  state.corridorCells = null; state.corridorBase = null; state.corridorRamp = null;
  state.corridorSet = null;
  const dem = state.dem, imp = state.impassable, net = state.networkMask;
  const on = !!document.getElementById("imp-corridor")?.checked;
  if (!dem || !imp || !net || !on) return;
  const { H, W, dxM, dyM, height, mask: dmask } = dem;
  const N = H * W;
  // 1) corridor cells (network ∩ impassable) + global→local index map.
  const cells = []; const local = new Map();
  for (let i = 0; i < N; i++) if (net[i] && imp[i]) { local.set(i, cells.length); cells.push(i); }
  const m = cells.length;
  if (!m) return;
  const drs = [-1, -1, -1, 0, 0, 1, 1, 1], dcs = [-1, 0, 1, -1, 1, -1, 0, 1];
  const diag = Math.hypot(dxM, dyM);
  const stepLen = [diag, dyM, diag, dxM, dxM, diag, dyM, diag];
  // 2) local adjacency among corridor cells + summed adjacent land elevations.
  const nbr = new Array(m), nbrLen = new Array(m);
  const entElev = new Float64Array(m), entCnt = new Int32Array(m);
  for (let li = 0; li < m; li++) {
    const i = cells[li]; const r = (i / W) | 0, c = i - r * W;
    const ns = [], ls = [];
    for (let k = 0; k < 8; k++) {
      const nr = r + drs[k], nc = c + dcs[k];
      if (nr < 0 || nr >= H || nc < 0 || nc >= W) continue;
      const j = nr * W + nc;
      const lj = local.get(j);
      if (lj !== undefined) { ns.push(lj); ls.push(stepLen[k]); }
      else if (net[j] && !imp[j] && dmask[j]) { entElev[li] += height[j]; entCnt[li]++; }
    }
    nbr[li] = ns; nbrLen[li] = ls;
  }
  // 3) connected components over the corridor graph.
  const comp = new Int32Array(m).fill(-1); let nComp = 0;
  for (let li = 0; li < m; li++) {
    if (comp[li] >= 0) continue;
    const cid = nComp++; const q = [li]; comp[li] = cid;
    while (q.length) { const x = q.pop(); for (const y of nbr[x]) if (comp[y] < 0) { comp[y] = cid; q.push(y); } }
  }
  // 4) entrance clusters (8-connected entrance cells) — naturally per-component.
  const isEnt = new Uint8Array(m);
  for (let li = 0; li < m; li++) if (entCnt[li] > 0) isEnt[li] = 1;
  const clusterId = new Int32Array(m).fill(-1);
  const clusters = []; const clustersByComp = Array.from({ length: nComp }, () => []);
  for (let li = 0; li < m; li++) {
    if (!isEnt[li] || clusterId[li] >= 0) continue;
    const cid = clusters.length; const q = [li]; clusterId[li] = cid;
    const cc = []; let esum = 0, ecnt = 0;
    while (q.length) {
      const x = q.pop(); cc.push(x); esum += entElev[x]; ecnt += entCnt[x];
      for (const y of nbr[x]) if (isEnt[y] && clusterId[y] < 0) { clusterId[y] = cid; q.push(y); }
    }
    clusters.push({ cells: cc, elev: ecnt ? esum / ecnt : 0, comp: comp[li] });
    clustersByComp[comp[li]].push(cid);
  }
  // 5) per-cluster geodesic distance + nearest-entrance distance for the ramp.
  const distOf = clusters.map((cl) => dijkstraLocal(cl.cells, nbr, nbrLen, m));
  const dNear = new Float64Array(m).fill(Infinity);
  for (const d of distOf) for (let li = 0; li < m; li++) if (d[li] < dNear[li]) dNear[li] = d[li];
  const compMaxNear = new Float64Array(nComp);
  for (let li = 0; li < m; li++) { const cm = comp[li]; if (Number.isFinite(dNear[li]) && dNear[li] > compMaxNear[cm]) compMaxNear[cm] = dNear[li]; }
  // 6) base + ramp per corridor cell; drop cells whose component has no shore.
  const outCells = [], outBase = [], outRamp = [];
  for (let li = 0; li < m; li++) {
    const cl = clustersByComp[comp[li]];
    if (!cl.length) continue; // no entrance reachable → leave blocked
    let base;
    if (cl.length === 2) {
      const dA = distOf[cl[0]][li], dB = distOf[cl[1]][li];
      const t = (dA + dB) > 0 ? dA / (dA + dB) : 0.5;
      base = (1 - t) * clusters[cl[0]].elev + t * clusters[cl[1]].elev;
    } else if (cl.length === 1) {
      base = clusters[cl[0]].elev;
    } else {
      let num = 0, den = 0;
      for (const ci of cl) {
        const d = distOf[ci][li];
        if (d <= 1e-9) { num = clusters[ci].elev; den = 1; break; }
        const w = 1 / d; num += w * clusters[ci].elev; den += w;
      }
      base = den ? num / den : clusters[cl[0]].elev;
    }
    const mx = compMaxNear[comp[li]];
    outCells.push(cells[li]);
    outBase.push(base);
    outRamp.push(mx > 0 && Number.isFinite(dNear[li]) ? dNear[li] / mx : 0);
  }
  if (!outCells.length) return;
  state.corridorCells = Int32Array.from(outCells);
  state.corridorBase = Float32Array.from(outBase);
  state.corridorRamp = Float32Array.from(outRamp);
  state.corridorSet = new Set(outCells);
}

// Per-feature "apply to compute" master toggles (1c/1d). When off, the data
// stays loaded (and its overlay can still be shown) but it does NOT affect the
// compute. Default true when the control is absent.
export function impassableEnabled() { return document.getElementById("imp-enabled")?.checked ?? true; }
export function bridgesEnabled() { return document.getElementById("bridge-enabled")?.checked ?? true; }

// True if a cell is traversable in the EFFECTIVE compute grid (raw DEM mask AND
// not impassable-unless-reopened-as-a-corridor). Used to validate point picks so
// clicks/refs can't land on blocked water that the compute would silently drop.
export function effectivePassableAt(idx) {
  if (!state.dem || !state.dem.mask[idx]) return false;
  // Drawn geometry: a passable corridor wins; a barrier blocks (mirrors buildComputeGrid).
  if (state.drawnPassableMask && state.drawnPassableMask[idx]) return true;
  if (state.drawnImpassableMask && state.drawnImpassableMask[idx]) return false;
  if (state.impassable && impassableEnabled() && state.impassable[idx]) {
    return !!(state.corridorSet && state.corridorSet.has(idx));
  }
  return true;
}

// THE single source of truth for the compute grid. Returns fresh, transferable
// height+mask with the impassable mask blocked and bridge corridors reopened +
// levelled. When state.impassable is null OR has no impassable cells (so
// recomputeCorridors produced no corridors), this returns byte-identical copies
// of state.dem.height/mask — guaranteeing prior results are reproduced exactly.
// Must be used by EVERY compute serialization site (worker, density pool,
// backend Blob, compare-secondary, graph build, probe) — there is no single
// dispatch choke point.
export function buildComputeGrid(opts = {}) {
  const maskOnly = !!opts.maskOnly; // for the IDW interp DOMAIN (no height needed)
  const dem = state.dem;
  const height = maskOnly ? null : new Float32Array(dem.height);
  const mask = new Uint8Array(dem.mask);
  const imp = impassableEnabled() ? state.impassable : null; // 1c master toggle
  if (imp) {
    const N = mask.length;
    for (let i = 0; i < N; i++) if (imp[i] && mask[i]) mask[i] = 0; // block water on valid land
    const cells = state.corridorCells;
    if (cells && cells.length) {
      const off = maskOnly ? 0 : corridorOffsetMetres();
      const base = state.corridorBase, ramp = state.corridorRamp;
      for (let k = 0; k < cells.length; k++) {
        const i = cells[k];
        mask[i] = 1;                                  // reopen the corridor (even over nodata water)
        if (!maskOnly) height[i] = base[k] + off * ramp[k]; // smooth bridge profile
      }
    }
  }
  // Drawn geometry (1C): barriers block valid cells; passable corridors reopen
  // them (override). Applied AFTER the file/OSM mask so a drawn corridor wins.
  const dImp = state.drawnImpassableMask, dPass = state.drawnPassableMask;
  if (dImp || dPass) {
    const N = mask.length;
    for (let i = 0; i < N; i++) {
      if (!dem.mask[i]) continue;                     // never touch true nodata
      if (dImp && dImp[i]) mask[i] = 0;
      if (dPass && dPass[i]) mask[i] = 1;
    }
  }
  return maskOnly
    ? { mask, transfer: [mask.buffer] }
    : { height, mask, transfer: [height.buffer, mask.buffer] };
}

// Pack the loaded OSM bridges into portal-edge arrays for the engine: end-cell
// indices (u, v) and the deck length in metres. The worker/backend compute the
// directed deck cost from these + the (composed) height array, so JS and Rust
// derive identical costs (parity). Returns null when no bridges are loaded — in
// which case the compute is byte-identical to before (no-op invariant).
export function buildPortals() {
  const brs = state.bridges;
  if (!brs || !brs.length || !bridgesEnabled()) return null; // 1d master toggle
  const n = brs.length;
  const u = new Int32Array(n), v = new Int32Array(n), lenM = new Float64Array(n);
  // Deck-END elevations from OSM `ele` (NaN = unmapped → the engine falls back to
  // the DEM at the abutment cell). hu/hv pair with endA/endB.
  const hu = new Float64Array(n), hv = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    u[i] = brs[i].endA; v[i] = brs[i].endB; lenM[i] = brs[i].deckLenM;
    hu[i] = (brs[i].eleA != null) ? brs[i].eleA : NaN;
    hv[i] = (brs[i].eleB != null) ? brs[i].eleB : NaN;
  }
  return { u, v, lenM, hu, hv, n };
}

// Grid cells a bridge's deck geometry passes through (Bresenham along its
// polyline), clipped to the DEM. Used to paint deck passes/density.
function bridgeDeckCells(br) {
  const { W, H } = state.dem;
  const pts = br.latlngs.map(([lat, lng]) => llToCell(lat, lng));
  const cells = [];
  for (let i = 1; i < pts.length; i++) {
    let r = pts[i - 1][0], c = pts[i - 1][1];
    const r1 = pts[i][0], c1 = pts[i][1];
    const dr = Math.abs(r1 - r), dc = Math.abs(c1 - c), sr = r < r1 ? 1 : -1, sc = c < c1 ? 1 : -1;
    let err = dc - dr;
    for (;;) {
      if (r >= 0 && r < H && c >= 0 && c < W) cells.push(r * W + c);
      if (r === r1 && c === c1) break;
      const e2 = 2 * err;
      if (e2 > -dr) { err -= dr; c += sc; }
      if (e2 < dc) { err += dc; r += sr; }
    }
  }
  return cells;
}

// A bridge portal jumps abutment→abutment, so the deck's interior cells aren't
// in the path tree and carry no passes. Paint them with the flow crossing the
// bridge so the deck shows up: flow = min(passes[endA], passes[endB]) — which is
// exactly the portal's tree-edge flow (the downstream abutment's subtree) for a
// single source, and a tight estimate for round/density. max() so a deck cell
// with heavier ground traffic underneath isn't lowered. Raster modes only —
// graph mode already routes the (flattened) deck edges, so they carry passes.
export function stampBridgeDeckPasses(passes) {
  if (!passes || !state.bridges || !state.dem || !bridgesEnabled()) return;
  const { W, H } = state.dem;
  // The deck is a 1-cell-wide Bresenham line over water (mask=0, unreached by the
  // compute), so it reads faint — and on a big DEM the passes overlay downsamples
  // by `stride`, dropping a 1-cell line between samples → a GAP along the bridge.
  // Dilate the stamp by the render stride (≥1) so the deck always lands on a
  // sampled cell and reads as a continuous line.
  const rad = Math.max(1, overlayCanvasDims(W, H).stride);
  for (const br of state.bridges) {
    const a = passes[br.endA], b = passes[br.endB];
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const flow = Math.min(a, b);
    if (!(flow > 0)) continue;
    for (const cell of bridgeDeckCells(br)) {
      const cr = (cell / W) | 0, cc = cell - cr * W;
      for (let dr = -rad; dr <= rad; dr++) {
        const rr = cr + dr; if (rr < 0 || rr >= H) continue;
        const rowOff = rr * W;
        for (let dc = -rad; dc <= rad; dc++) {
          const ccc = cc + dc; if (ccc < 0 || ccc >= W) continue;
          const idx = rowOff + ccc;
          if (flow > passes[idx]) passes[idx] = flow; // max() — don't lower heavier ground traffic
        }
      }
    }
  }
}
