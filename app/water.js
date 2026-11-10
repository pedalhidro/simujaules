// Impassable mask: the OSM / FlatGeobuf water pulls (group 1C), mask files,
// corridor availability.
import "./draw.js"; // evaluation order — see ../app.js
import { assembleRings, rasterPolylineSupercover } from "../lib/water-raster.js";
import { t } from "./i18n.js";
import { setGroupOpen, syncLoadedHighlights } from "./panel.js";
import { escapeHtml, state } from "./state.js";
import { cancelActiveCompute } from "./compute-source.js";
import { progress, progressBar, status } from "./dom.js";
import {
  FGB_PULL_MAX_DEG2, OVERPASS_URL, WATER_AREAS_FGB_URL, WATER_RIVERS_FGB_URL, fgbStream,
  readFileWithProgress,
} from "./network.js";
import { kpiInvalidate } from "./points.js";
import { applyImpassableOverlay } from "./render.js";
import { estimateRunTime, startCalibrationProbe } from "./estimate.js";
import { readMaskGeoTIFF, recomputeCorridors, resampleMaskToDem } from "./grid.js";

// ---- Optional impassable mask (water bodies, etc.) ------------------------
// Upload a binary GeoTIFF (1=impassable); it's resampled onto the DEM grid by
// area-coverage majority. The loaded vector network can carve bridge corridors
// across it, optionally with a smooth elevation offset. All composition happens
// in buildComputeGrid() — engines unchanged.

// Invalidate everything a loaded mask affects. reprobe re-runs the compute-time
// calibration (only on geometry changes — not on every offset keystroke).
export function markImpassableDirty(reprobe = false) {
  cancelActiveCompute();      // an in-flight run used the previous grid
  state.lastResult = null;    // stale render
  kpiInvalidate();            // grid changes void the accessibility matrix
  state.impassableToken++;    // rebuild the cached network graph (heights/validity changed)
  state.networkGraph = null; state.networkGraphToken = null;
  applyImpassableOverlay();
  if (reprobe && state.dem) {
    state.calibration = null;
    state.calibrationGen++;
    state.calibrationFailed = false;
    if (state.probeWorker) { state.probeWorker.terminate(); state.probeWorker = null; }
    startCalibrationProbe();
  }
  estimateRunTime();
  syncLoadedHighlights(); // 1C status (loaded/applied) may have changed
}

// ---- OSM water → impassable mask (group 1c) ------------------------------
// Pull water from OSM and rasterise it onto the DEM grid as an impassable mask,
// reusing the uploaded-mask pipeline (applyImpassableRaster → Invert, corridors,
// overlay, bundle — the synthetic raster matches the DEM grid so resampling is
// identity). Impassable = water AREAS (natural=water / waterway=riverbank /
// landuse=reservoir, ways + multipolygon relations) and NON-tunnelled
// waterway=river LINES. Streams (never queried) and tunnelled/culverted rivers
// (filtered client-side) stay passable. OSM coords are lon/lat → geographic DEM
// only (mirrors the OSM bridge/network guards).

// Fractional grid coords [gx, gy] for a lat/lng (cell centres at integer+0.5,
// matching resampleMaskToDem's identity sampling on a grid-matched raster).
export function llToGridFrac(lat, lng) {
  const { originX, originY, dx, dy } = state.dem;
  return [(lng - originX) / dx, (originY - lat) / dy];
}

// The pure rasterisers (fillRingsEvenOdd, rasterPolylineSupercover,
// assembleRings, fillSeaFromCoastlines) live in lib/water-raster.js (shared
// with test-water-raster.mjs).

// Async, chunked re-implementations of fillRingsEvenOdd/fillSeaFromCoastlines
// for the main-thread caller (rebuildOsmWaterMask): SAME per-row/per-sweep math
// as the pure functions in lib/water-raster.js, just batched with a TIME-based
// yield so a single huge body (a reservoir ring with tens of thousands of
// vertices) or the coastline sweep doesn't block the tab end-to-end. The pure
// functions themselves are left untouched — test-water-raster.mjs tests them
// directly (the …Chunked copies here are NOT under test, so keep their math in
// step with lib/water-raster.js by hand) — and still used directly by
// rasterizeRingsToMask (drawn-shape masks, small and synchronous)
// and the rivers loop below. A fixed item count (e.g. "every 25 bodies") would
// miss the actual cost concentration — a 10-vertex pond and a 30,000-vertex
// reservoir ring differ by orders of magnitude — so the yield cadence here is
// wall-clock based instead.
const WATER_MASK_YIELD_MS = 50;

async function fillRingsEvenOddChunked(rings, out, W, H) {
  let yMin = Infinity, yMax = -Infinity;
  for (const r of rings) for (const p of r) { if (p[1] < yMin) yMin = p[1]; if (p[1] > yMax) yMax = p[1]; }
  if (!Number.isFinite(yMin)) return;
  const r0 = Math.max(0, Math.floor(yMin)), r1 = Math.min(H - 1, Math.floor(yMax));
  const xs = [];
  let lastYield = performance.now();
  for (let ry = r0; ry <= r1; ry++) {
    const yc = ry + 0.5;
    xs.length = 0;
    for (const ring of rings) {
      const n = ring.length;
      if (n < 3) continue;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const yi = ring[i][1], yj = ring[j][1];
        if ((yi > yc) !== (yj > yc)) xs.push(ring[i][0] + (yc - yi) / (yj - yi) * (ring[j][0] - ring[i][0]));
      }
    }
    if (xs.length >= 2) {
      xs.sort((a, b) => a - b);
      const base = ry * W;
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const cA = Math.max(0, Math.ceil(xs[k] - 0.5));
        const cB = Math.min(W - 1, Math.floor(xs[k + 1] - 0.5));
        for (let c = cA; c <= cB; c++) out[base + c] = 1;
      }
    }
    if (performance.now() - lastYield > WATER_MASK_YIELD_MS) {
      await new Promise((res) => setTimeout(res, 0));
      lastYield = performance.now();
    }
  }
}

async function fillSeaFromCoastlinesChunked(coastlines, data, W, H) {
  if (!coastlines || !coastlines.length) return 0;
  let lastYield = performance.now();
  const maybeYield = async () => {
    if (performance.now() - lastYield > WATER_MASK_YIELD_MS) {
      await new Promise((res) => setTimeout(res, 0));
      lastYield = performance.now();
    }
  };
  for (const line of coastlines) { rasterPolylineSupercover(line, data, W, H); await maybeYield(); } // shore = impassable edge
  const xs = []; // crossings of the current scan: { p = position along scan, sea = state past it }
  // Horizontal sweep: per ROW, a crossing sets the state to its EAST
  // (north-going coast, grid y decreasing → sea to the east).
  for (let ry = 0; ry < H; ry++) {
    const yc = ry + 0.5;
    xs.length = 0;
    for (const line of coastlines) for (let i = 0; i + 1 < line.length; i++) {
      const y0 = line[i][1], y1 = line[i + 1][1];
      if ((y0 > yc) !== (y1 > yc)) { const x0 = line[i][0], x1 = line[i + 1][0];
        xs.push({ p: x0 + (yc - y0) / (y1 - y0) * (x1 - x0), sea: y1 < y0 }); }
    }
    if (xs.length) {
      xs.sort((a, b) => a.p - b.p);
      const base = ry * W;
      let k = -1;
      for (let c = 0; c < W; c++) {
        const cx = c + 0.5;
        while (k + 1 < xs.length && xs[k + 1].p <= cx) k++;
        if (k >= 0 ? xs[k].sea : !xs[0].sea) data[base + c] = 1;
      }
    }
    await maybeYield();
  }
  // Vertical sweep: per COLUMN, a crossing sets the state to its SOUTH
  // (east-going coast, x increasing → sea to the south).
  for (let cx = 0; cx < W; cx++) {
    const xc = cx + 0.5;
    xs.length = 0;
    for (const line of coastlines) for (let i = 0; i + 1 < line.length; i++) {
      const x0 = line[i][0], x1 = line[i + 1][0];
      if ((x0 > xc) !== (x1 > xc)) { const y0 = line[i][1], y1 = line[i + 1][1];
        xs.push({ p: y0 + (xc - x0) / (x1 - x0) * (y1 - y0), sea: x1 > x0 }); }
    }
    if (xs.length) {
      xs.sort((a, b) => a.p - b.p);
      let k = -1;
      for (let r = 0; r < H; r++) {
        const cy = r + 0.5;
        while (k + 1 < xs.length && xs[k + 1].p <= cy) k++;
        if (k >= 0 ? xs[k].sea : !xs[0].sea) data[r * W + cx] = 1;
      }
    }
    await maybeYield();
  }
  let filled = 0; for (let i = 0, N = W * H; i < N; i++) if (data[i]) filled++;
  return filled;
}

// Whether river LINES count as impassable (the #imp-rivers toggle). Water areas
// and the coastline-derived sea are ALWAYS impassable; only the river-line layer
// is optional. Default true.
function riversImpassable() { return document.getElementById("imp-rivers")?.checked ?? true; }

// (Re)rasterise the cached OSM water geometry onto the DEM grid and feed it to
// the uploaded-mask pipeline. Re-callable so the #imp-rivers toggle re-applies
// without re-querying Overpass. Areas (even-odd fill) + sea (coastline flood)
// always; river lines (supercover) only when the toggle is on. Async and
// chunked (see fillRingsEvenOddChunked/fillSeaFromCoastlinesChunked above) so a
// large water pull doesn't freeze the tab. Double-guarded like every other OSM
// loader: `demRef` (state.dem IDENTITY, not state.calibrationGen — that counter
// also bumps on unrelated markBridgesDirty(true)/markImpassableDirty(true)
// toggles, which must NOT abort an in-flight water rebuild) catches a DEM swap
// mid-rebuild, and state.waterMaskGen catches a SECOND rebuildOsmWaterMask call
// starting before this one finishes (rapid #imp-rivers toggling) — only the
// LAST-started call may apply its result.
export async function rebuildOsmWaterMask() {
  const demRef = state.dem;
  const g = state.osmWaterGeom;
  if (!g || !state.dem || !state.dem.isGeographic) return;
  const myGen = ++state.waterMaskGen;
  const stale = () => state.dem !== demRef || myGen !== state.waterMaskGen;
  const { originX, originY, H, W, dx, dy } = state.dem;
  const data = new Uint8Array(W * H);
  const total = g.bodies.length + g.rivers.length + g.coastlines.length;
  progress.classList.add("active");
  progressBar.style.width = "0%";
  status.textContent = t("status.water_rasterising", total.toLocaleString());
  for (let bi = 0; bi < g.bodies.length; bi++) {
    await fillRingsEvenOddChunked(g.bodies[bi].rings, data, W, H);
    if (stale()) { progress.classList.remove("active"); status.textContent = t("status.load_superseded"); return; }
    progressBar.style.width = `${(((bi + 1) / Math.max(1, g.bodies.length)) * 50).toFixed(1)}%`;
  }
  if (riversImpassable()) {
    let lastYield = performance.now();
    for (let ri = 0; ri < g.rivers.length; ri++) {
      rasterPolylineSupercover(g.rivers[ri], data, W, H);
      if (performance.now() - lastYield > WATER_MASK_YIELD_MS) {
        await new Promise((r) => setTimeout(r, 0));
        lastYield = performance.now();
        if (stale()) { progress.classList.remove("active"); status.textContent = t("status.load_superseded"); return; }
        progressBar.style.width = `${(50 + ((ri + 1) / Math.max(1, g.rivers.length)) * 25).toFixed(1)}%`;
      }
    }
  }
  progressBar.style.width = "75%";
  await fillSeaFromCoastlinesChunked(g.coastlines, data, W, H);
  if (stale()) { progress.classList.remove("active"); status.textContent = t("status.load_superseded"); return; }
  progressBar.style.width = "100%";
  let cells = 0; for (let i = 0; i < data.length; i++) if (data[i]) cells++;
  // OSM water has a fixed polarity (water = impassable), so clear a stale Invert
  // from a prior uploaded raster before applying the canonical mask.
  const inv = document.getElementById("impassable-invert"); if (inv) inv.checked = false;
  const fi = document.getElementById("impassable-file"); if (fi) fi.value = "";
  // Wrap as a DEM-grid raster so the uploaded-mask pipeline consumes it
  // unchanged (resample is identity; Invert/corridors/overlay/bundle reused).
  applyImpassableRaster({ width: W, height: H, data, dx, dy, originX, originY, epsg: 4326 }, g.label || "OSM water");
  status.textContent = cells ? t("status.water_done", cells.toLocaleString()) : t("status.water_none");
  progress.classList.remove("active");
}

export async function loadOsmWater() {
  if (!state.dem) { status.innerHTML = `<span style="color:#ff6b6b">${t("status.load_dem_first")}</span>`; return; }
  if (!state.dem.isGeographic) { status.innerHTML = `<span style="color:#ff6b6b">${t("status.water_geographic")}</span>`; return; }
  // Epoch token: guards the async install tail below against a DEM swap
  // that happens while the Overpass fetch/parse is in flight.
  const demRef = state.dem;
  const { originX, originY, H, W, dx, dy } = state.dem;
  // Full DEM extent — a mask should cover the whole grid, not just the view.
  const south = originY - H * dy, north = originY, west = originX, east = originX + W * dx;
  const btn = document.getElementById("impassable-osm");
  if (btn) btn.disabled = true;
  progress.classList.add("active");
  progressBar.style.width = "20%";
  status.textContent = t("status.water_querying");
  try {
    const bbox = `${south.toFixed(6)},${west.toFixed(6)},${north.toFixed(6)},${east.toFixed(6)}`;
    const query = `[out:json][timeout:120];(` +
      `way["natural"="water"](${bbox});relation["natural"="water"](${bbox});` +
      `way["waterway"="riverbank"](${bbox});relation["waterway"="riverbank"](${bbox});` +
      `way["landuse"="reservoir"](${bbox});relation["landuse"="reservoir"](${bbox});` +
      `way["natural"="coastline"](${bbox});` +     // the open sea: directed line, water on the right
      `way["waterway"="river"](${bbox});` +        // streams/canals/ditches intentionally NOT queried
      `);out geom;`;
    const resp = await fetch(OVERPASS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "data=" + encodeURIComponent(query),
    });
    if (!resp.ok) throw new Error(t("status.overpass_http", resp.status));
    progressBar.style.width = "55%";
    status.textContent = t("status.water_parsing");
    const json = await resp.json();
    // A timed-out/OOM'd query still answers HTTP 200 with a `remark` field and
    // empty or PARTIAL elements — surface it as a failure BEFORE parsing any
    // elements, or a partial water pull installs an incomplete impassable mask
    // that silently lets routes cross rivers/lakes cut off by the timeout.
    if (json.remark) throw new Error(json.remark);
    const toGrid = (g) => llToGridFrac(g.lat, g.lon);
    const bodies = [];     // area bodies: { rings: [[[gx,gy],…], …] }
    const rivers = [];     // non-tunnelled river polylines: [[[gx,gy],…], …]
    const coastlines = []; // coastline polylines (sea = right side): [[[gx,gy],…], …]
    for (const el of json.elements || []) {
      const tg = el.tags || {};
      if (el.type === "way" && Array.isArray(el.geometry) && el.geometry.length >= 2) {
        if (tg.natural === "coastline") coastlines.push(el.geometry.map(toGrid));
        else if (tg.waterway === "river") { if (!tg.tunnel || tg.tunnel === "no") rivers.push(el.geometry.map(toGrid)); } // tunnelled = passable
        else bodies.push({ rings: [el.geometry.map(toGrid)] }); // closed water-area way (even-odd wraps it)
      } else if (el.type === "relation" && Array.isArray(el.members)) {
        const segs = [];
        for (const m of el.members) if (Array.isArray(m.geometry) && m.geometry.length >= 2) segs.push(m.geometry.map(toGrid));
        if (segs.length) bodies.push({ rings: assembleRings(segs) });
      }
    }
    if (!bodies.length && !rivers.length && !coastlines.length) {
      status.textContent = t("status.water_none"); // a normal "nothing here" result, not an error
      return;
    }
    progressBar.style.width = "75%";
    status.textContent = t("status.water_rasterising", (bodies.length + rivers.length + coastlines.length).toLocaleString());
    await new Promise((r) => setTimeout(r, 0)); // let the status paint before the (now chunked, async) rasterise below
    if (state.dem !== demRef) {
      status.textContent = t("status.load_superseded");
      return;
    }
    state.osmWaterGeom = { bodies, rivers, coastlines }; // cache so the #imp-rivers toggle re-applies without re-querying
    await rebuildOsmWaterMask();
  } catch (err) {
    console.error("[osm-water]", err);
    status.innerHTML = `<span style="color:#ff6b6b">${t("status.water_failed", escapeHtml(err.message))}</span>`;
  } finally {
    progress.classList.remove("active");
    if (btn) btn.disabled = false;
  }
}

// Pull the water mask from the project's water FlatGeobufs (amora's
// build-viario.py --water on gs://telhas): areas (natural=water /
// landuse=reservoir / waterway=riverbank polygons) + waterway=river lines —
// the same feature classes as the Overpass pull, minus two documented gaps:
// NO coastline layer (the open sea is not filled — use the OSM pull on
// coastal DEMs) and no tunnel tag on rivers (tunnelled rivers stay blocked,
// a tiny over-block the Overpass pull filters out). Fills the SAME
// state.osmWaterGeom cache and reuses rebuildOsmWaterMask(), so the
// #imp-rivers toggle re-applies without re-querying, exactly like OSM.
export async function loadFgbWater() {
  if (!state.dem) { status.innerHTML = `<span style="color:#ff6b6b">${t("status.load_dem_first")}</span>`; return; }
  if (!state.dem.isGeographic) { status.innerHTML = `<span style="color:#ff6b6b">${t("status.water_geographic")}</span>`; return; }
  if (typeof flatgeobuf === "undefined") { status.innerHTML = `<span style="color:#ff6b6b">${t("census.lib_missing")}</span>`; return; }
  const demRef = state.dem;
  const { originX, originY, H, W, dx, dy } = state.dem;
  // Full DEM extent — a mask should cover the whole grid (same as the OSM pull).
  const south = originY - H * dy, north = originY, west = originX, east = originX + W * dx;
  if ((east - west) * (north - south) > FGB_PULL_MAX_DEG2) {
    const kmX = (east - west) * 111.32 * Math.cos(((south + north) / 2) * Math.PI / 180);
    const kmY = (north - south) * 111.32;
    status.innerHTML = `<span style="color:#ff6b6b">${t("status.fgb_too_big", kmX.toFixed(0), kmY.toFixed(0))}</span>`;
    return;
  }
  const btn = document.getElementById("impassable-fgb");
  if (btn) btn.disabled = true;
  progress.classList.add("active");
  progressBar.style.width = "10%";
  status.textContent = t("status.fgb_querying");
  try {
    const rect = { minX: west, minY: south, maxX: east, maxY: north };
    const toGrid = (c) => llToGridFrac(c[1], c[0]);          // [lng,lat] GeoJSON
    const bodies = [];
    const rivers = [];
    // Áreas: cada polígono (anéis externo+furos) é UM corpo — o preenchimento
    // even-odd de rebuildOsmWaterMask corta os furos por paridade.
    // v73: áreas e rios são ARQUIVOS independentes — os dois streams rodam em
    // paralelo. (Paralelismo por sub-janelas dentro de UM arquivo foi medido
    // e descartado: cada fatia re-anda a R-tree e re-baixa lotes da fronteira,
    // saindo 2,5× MAIS LENTO que o stream único — o leitor já baixa os lotes
    // de features concorrentemente por conta própria.)
    await Promise.all([
      fgbStream(WATER_AREAS_FGB_URL, rect, (f) => {
        const g = f?.geometry;
        if (g?.type === "Polygon") bodies.push({ rings: g.coordinates.map((r) => r.map(toGrid)) });
        else if (g?.type === "MultiPolygon") for (const poly of g.coordinates) bodies.push({ rings: poly.map((r) => r.map(toGrid)) });
      }),
      fgbStream(WATER_RIVERS_FGB_URL, rect, (f) => {
        const g = f?.geometry;
        if (g?.type === "LineString") rivers.push(g.coordinates.map(toGrid));
        else if (g?.type === "MultiLineString") for (const part of g.coordinates) rivers.push(part.map(toGrid));
      }),
    ]);
    progressBar.style.width = "45%";
    if (!bodies.length && !rivers.length) {
      status.textContent = t("status.water_none");
      return;
    }
    if (state.dem !== demRef) {
      status.textContent = t("status.load_superseded");
      return;
    }
    state.osmWaterGeom = { bodies, rivers, coastlines: [], label: "FGB água" };
    await rebuildOsmWaterMask();
  } catch (err) {
    console.error("[fgb-water]", err);
    status.innerHTML = `<span style="color:#ff6b6b">${t("status.water_failed", escapeHtml(err.message))}</span>`;
  } finally {
    progress.classList.remove("active");
    if (btn) btn.disabled = false;
  }
}

export async function loadImpassableMaskFromFile(file) {
  if (!state.dem) { status.innerHTML = `<span style="color:#ff6b6b">${t("status.load_dem_first")}</span>`; return; }
  const meta = document.getElementById("imp-meta");
  try {
    if (meta) meta.textContent = `Reading ${file.name}…`;
    const buf = await readFileWithProgress(file, () => {});
    const raster = await readMaskGeoTIFF(buf);
    // A file upload supersedes any cached OSM water pull as the mask source —
    // otherwise a later #imp-rivers toggle would silently re-rasterise the
    // stale OSM geometry over this upload (mirrors clearImpassableMask).
    state.osmWaterGeom = null;
    applyImpassableRaster(raster, file.name);
  } catch (err) {
    console.error("[impassable]", err);
    if (meta) meta.innerHTML = `<span style="color:#ff6b6b">${escapeHtml(err.message)}</span>`;
  }
}

// (Re)resample the cached source raster onto the DEM grid with the current
// Invert setting, refresh derived state, and invalidate. Re-callable so the
// Invert toggle doesn't require a re-upload.
export function applyImpassableRaster(raster, name) {
  if (!raster || !state.dem) return;
  state.impassableRaster = raster;
  const invert = !!document.getElementById("impassable-invert")?.checked;
  const imp = resampleMaskToDem(raster, state.dem, { invert });
  let cells = 0;
  for (let i = 0; i < imp.length; i++) if (imp[i]) cells++;
  state.impassable = imp;
  state.impassableMeta = {
    name: name ?? state.impassableMeta?.name ?? "mask",
    width: raster.width, height: raster.height, srs: raster.epsg, cellsImpassable: cells,
  };
  recomputeCorridors();
  updateImpassableMeta();
  updateCorridorAvailability();
  markImpassableDirty(true);
  setGroupOpen("bridges-group", true); // mask loaded → next input step
}

export function updateImpassableMeta() {
  const meta = document.getElementById("imp-meta");
  if (!meta) return;
  if (!state.impassable) { meta.textContent = t("imp.none"); syncLoadedHighlights(); return; }
  const m = state.impassableMeta || {};
  const N = state.dem ? state.dem.H * state.dem.W : 0;
  const pct = N ? (100 * (m.cellsImpassable || 0) / N).toFixed(1) : "0";
  const corr = state.corridorCells ? state.corridorCells.length : 0;
  let html = `${escapeHtml(m.name || "mask")} · ` +
    t("imp.meta.cells", (m.cellsImpassable || 0).toLocaleString(), pct);
  if (corr) html += `<br/>${t("imp.meta.corridor", corr.toLocaleString())}`;
  meta.innerHTML = html;
  syncLoadedHighlights();
}

export function clearImpassableMask() {
  state.impassable = null;
  state.impassableRaster = null;
  state.impassableMeta = null;
  state.corridorCells = null; state.corridorBase = null; state.corridorRamp = null;
  state.corridorSet = null;
  state.osmWaterGeom = null; // forget the cached OSM water geometry too
  const inp = document.getElementById("impassable-file");
  if (inp) inp.value = "";
  updateImpassableMeta();
  updateCorridorAvailability();
  markImpassableDirty(true);
}

// Enable the "carve corridors" toggle only when a network is loaded.
export function updateCorridorAvailability() {
  const cb = document.getElementById("imp-corridor");
  const row = document.getElementById("imp-corridor-row");
  const hasNet = !!state.networkMask;
  if (cb) cb.disabled = !hasNet;
  if (row) row.style.opacity = hasNet ? "1" : "0.55";
}

// A network load/clear can add/remove bridge corridors, changing the effective
// compute grid. Recompute them, refresh the toggle, and — when a mask is present
// so the grid actually changed — fully invalidate (overlay + graph token +
// recalibration + estimate) via markImpassableDirty, exactly like a mask change.
// Enable the "extract bridges from loaded network" button only when the loaded
// network actually carries bridge/tunnel-tagged ways.
function updateBridgeNetworkButton() {
  const btn = document.getElementById("bridge-from-network");
  if (btn) btn.disabled = !(state.networkBridgeCandidates && state.networkBridgeCandidates.length);
}

export function onNetworkCorridorsChanged() {
  recomputeCorridors();
  updateCorridorAvailability();
  updateBridgeNetworkButton();
  if (state.impassable) {
    markImpassableDirty(true); // overlay + token bump + graph invalidation + reprobe + estimate
  } else {
    applyImpassableOverlay();
    state.impassableToken++;
  }
}
