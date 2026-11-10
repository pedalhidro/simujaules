// OSM / FlatGeobuf bridges and tunnels → portal edges (group 1D).
import "./network.js"; // evaluation order — see ../app.js
import { t } from "./i18n.js";
import { syncLoadedHighlights } from "./panel.js";
import { map } from "./map.js";
import { escapeHtml, state } from "./state.js";
import { cancelActiveCompute } from "./compute-source.js";
import { progress, progressBar, status } from "./dom.js";
import { FGB_PULL_MAX_DEG2, OVERPASS_URL, VIARIO_FGB_URL, fgbStream } from "./network.js";
import { applyBridgeOverlay, reappendDrawnPortals, updateDrawMeta } from "./draw.js";
import { kpiInvalidate } from "./points.js";
import { estimateRunTime, startCalibrationProbe } from "./estimate.js";

// ---- OSM bridges & tunnels (level decks → portal edges) -------------------
// Pull bridge/tunnel ways from OSM and model each as a level deck spanning its
// two ground abutments. A bare-earth DEM omits the deck, so routing over a
// viaduct otherwise dives into the valley below; the deck is the flat truth.
// In the raster compute each deck becomes a PORTAL EDGE between its end cells at
// the flat-deck cost, leaving the cells underneath untouched — so both the
// over-bridge and the under-bridge route stay correct (2.5-D safe).

export function llToCell(lat, lng) {
  const { originX, originY, dx, dy } = state.dem;
  return [Math.floor((originY - lat) / dy), Math.floor((lng - originX) / dx)];
}

export async function loadOsmBridges() {
  if (!state.dem) { status.innerHTML = `<span style="color:#ff6b6b">${t("status.load_dem_first")}</span>`; return; }
  // OSM coords are lon/lat; the cell mapping (llToCell) only holds for a
  // geographic (EPSG:4326) DEM. Refuse on a projected DEM rather than place
  // bridges on garbage cells (mirrors the map-click / ref-file guards).
  if (!state.dem.isGeographic) {
    status.innerHTML = `<span style="color:#ff6b6b">${t("bridges.osm_need_geographic")}</span>`;
    return;
  }
  // Epoch token: guards the async install tail below against a DEM swap
  // that happens while the Overpass fetch/parse is in flight.
  const demRef = state.dem;
  const { originX, originY, H, W, dx, dy } = state.dem;
  const b = map.getBounds();
  const south = Math.max(b.getSouth(), originY - H * dy);
  const north = Math.min(b.getNorth(), originY);
  const west  = Math.max(b.getWest(),  originX);
  const east  = Math.min(b.getEast(),  originX + W * dx);
  if (!(south < north && west < east)) {
    status.innerHTML = `<span style="color:#ff6b6b">${t("status.osm_no_intersect")}</span>`;
    return;
  }
  const withTunnels = !!document.getElementById("bridge-tunnels")?.checked;
  const btn = document.getElementById("bridge-osm");
  if (btn) btn.disabled = true;
  progress.classList.add("active");
  progressBar.style.width = "20%";
  status.textContent = t("status.osm_querying");
  try {
    const bbox = `${south.toFixed(6)},${west.toFixed(6)},${north.toFixed(6)},${east.toFixed(6)}`;
    const parts = [`way["bridge"]["bridge"!="no"]["highway"](${bbox});`];
    if (withTunnels) parts.push(`way["tunnel"="yes"]["highway"](${bbox});`);
    // Pull the ways' geometry AND any `ele` tags on their nodes (mapped deck
    // elevations): union → set .bw → emit geometry, then its nodes carrying ele.
    const query = `[out:json][timeout:90];(${parts.join("")})->.bw;.bw out geom;node(w.bw)["ele"];out body;`;
    const resp = await fetch(OVERPASS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "data=" + encodeURIComponent(query),
    });
    if (!resp.ok) throw new Error(t("status.overpass_http", resp.status));
    progressBar.style.width = "60%";
    status.textContent = t("status.osm_parsing");
    const json = await resp.json();
    // Mapped node elevations (`ele`), keyed by rounded coord — matched to way
    // vertices by position (same OSM nodes ⇒ identical coords).
    const eleByCoord = new Map();
    const ckey = (lat, lon) => `${lat.toFixed(7)},${lon.toFixed(7)}`;
    for (const el of json.elements || []) {
      if (el.type !== "node" || !el.tags || el.tags.ele == null) continue;
      const e = parseFloat(el.tags.ele);
      if (Number.isFinite(e)) eleByCoord.set(ckey(el.lat, el.lon), e);
    }
    const ways = [];
    for (const el of json.elements || []) {
      if (el.type !== "way" || !Array.isArray(el.geometry) || el.geometry.length < 2) continue;
      const tg = el.tags || {};
      const g = el.geometry;
      // Deck elevation at each abutment (way end): the end node's `ele` if
      // mapped, else a way-level `ele`, else the nearest mapped node from that
      // end; null ⇒ buildPortals falls back to the DEM at the abutment cell.
      const vEle = g.map((p) => (eleByCoord.has(ckey(p.lat, p.lon)) ? eleByCoord.get(ckey(p.lat, p.lon)) : null));
      const wayEle = Number.isFinite(parseFloat(tg.ele)) ? parseFloat(tg.ele) : null;
      let firstTagged = null, lastTagged = null;
      for (let i = 0; i < vEle.length; i++) { if (vEle[i] != null) { firstTagged = vEle[i]; break; } }
      for (let i = vEle.length - 1; i >= 0; i--) { if (vEle[i] != null) { lastTagged = vEle[i]; break; } }
      ways.push({
        latlngs: g.map((p) => [p.lat, p.lon]),
        kind: tg.tunnel === "yes" ? "tunnel" : "bridge",
        layer: parseInt(tg.layer, 10) || 0,
        name: tg["bridge:name"] || tg.name || null,
        eleA: vEle[0] ?? wayEle ?? firstTagged ?? null,
        eleB: vEle[vEle.length - 1] ?? wayEle ?? lastTagged ?? null,
      });
    }
    if (!ways.length) throw new Error(t("bridges.none_overpass"));
    if (state.dem !== demRef) {
      status.textContent = t("status.load_superseded");
      return;
    }
    installBridgesFromWays(ways, "OSM");
  } catch (err) {
    console.error("[osm-bridges]", err);
    status.innerHTML = `<span style="color:#ff6b6b">${t("bridges.pull_failed", escapeHtml(err.message))}</span>`;
  } finally {
    progress.classList.remove("active");
    if (btn) btn.disabled = false;
  }
}

// Pull road bridges/tunnels from the viário FlatGeobuf instead of Overpass:
// the FGB carries the same OSM ways (osmium keeps the way splitting, so the
// first/last vertex are still the abutments) with bridge/tunnel/layer as
// columns. Two documented gaps vs the OSM pull: no mapped `ele` node
// elevations (eleA/eleB = null → buildPortals falls back to the DEM at the
// abutment cells) and highway-only coverage (railway decks absent). Same
// #bridge-tunnels checkbox semantics, same installBridgesFromWays tail.
export async function loadFgbBridges() {
  if (!state.dem) { status.innerHTML = `<span style="color:#ff6b6b">${t("status.load_dem_first")}</span>`; return; }
  if (!state.dem.isGeographic) {
    status.innerHTML = `<span style="color:#ff6b6b">${t("bridges.osm_need_geographic")}</span>`;
    return;
  }
  if (typeof flatgeobuf === "undefined") { status.innerHTML = `<span style="color:#ff6b6b">${t("census.lib_missing")}</span>`; return; }
  const demRef = state.dem;
  const { originX, originY, H, W, dx, dy } = state.dem;
  const b = map.getBounds();
  const south = Math.max(b.getSouth(), originY - H * dy);
  const north = Math.min(b.getNorth(), originY);
  const west  = Math.max(b.getWest(),  originX);
  const east  = Math.min(b.getEast(),  originX + W * dx);
  if (!(south < north && west < east)) {
    status.innerHTML = `<span style="color:#ff6b6b">${t("status.osm_no_intersect")}</span>`;
    return;
  }
  if ((east - west) * (north - south) > FGB_PULL_MAX_DEG2) {
    const kmX = (east - west) * 111.32 * Math.cos(((south + north) / 2) * Math.PI / 180);
    const kmY = (north - south) * 111.32;
    status.innerHTML = `<span style="color:#ff6b6b">${t("status.fgb_too_big", kmX.toFixed(0), kmY.toFixed(0))}</span>`;
    return;
  }
  const withTunnels = !!document.getElementById("bridge-tunnels")?.checked;
  const btn = document.getElementById("bridge-fgb");
  if (btn) btn.disabled = true;
  progress.classList.add("active");
  progressBar.style.width = "20%";
  status.textContent = t("status.fgb_querying");
  try {
    const rect = { minX: west, minY: south, maxX: east, maxY: north };
    const ways = [];
    const pushWay = (coords, p) => {
      if (!Array.isArray(coords) || coords.length < 2) return;
      ways.push({
        latlngs: coords.map((c) => [c[1], c[0]]),
        kind: p.tunnel === "yes" ? "tunnel" : "bridge",   // mesmo desempate do pull OSM
        layer: parseInt(p.layer, 10) || 0,
        name: null,
        eleA: null, eleB: null,                            // sem `ele` no FGB → DEM nos apoios
      });
    };
    let n = 0;
    await fgbStream(VIARIO_FGB_URL, rect, (f) => {
      const g = f?.geometry;
      const p = f?.properties || {};
      const isBridge = p.bridge && p.bridge !== "no";
      const isTunnel = p.tunnel === "yes";
      if (!isBridge && !(withTunnels && isTunnel)) return;
      if (g?.type === "LineString") pushWay(g.coordinates, p);
      else if (g?.type === "MultiLineString") for (const part of g.coordinates) pushWay(part, p);
      if (++n % 512 === 0) status.textContent = t("status.fgb_progress", n.toLocaleString());
    });
    if (!ways.length) throw new Error(t("bridges.none_fgb"));
    if (state.dem !== demRef) {
      status.textContent = t("status.load_superseded");
      return;
    }
    progressBar.style.width = "80%";
    installBridgesFromWays(ways, "FGB");
  } catch (err) {
    console.error("[fgb-bridges]", err);
    status.innerHTML = `<span style="color:#ff6b6b">${t("bridges.pull_failed", escapeHtml(err.message))}</span>`;
  } finally {
    progress.classList.remove("active");
    if (btn) btn.disabled = false;
  }
}

// Turn raw bridge/tunnel ways into the deck model (state.bridges). OSM splits a
// bridge way at its abutments, so the first/last vertex are the ground ends.
export function installBridgesFromWays(ways, sourceLabel) {
  if (!state.dem.isGeographic) {
    status.innerHTML = `<span style="color:#ff6b6b">${t("bridges.need_geographic")}</span>`;
    return false;
  }
  const { H, W, dxM, dyM, mask } = state.dem;
  const inB = (rc) => rc[0] >= 0 && rc[0] < H && rc[1] >= 0 && rc[1] < W;
  const bridges = [];
  let skipped = 0;
  for (const w of ways) {
    const pts = w.latlngs;
    const a = llToCell(pts[0][0], pts[0][1]);
    const z = llToCell(pts[pts.length - 1][0], pts[pts.length - 1][1]);
    if (!inB(a) || !inB(z)) { skipped++; continue; }
    const endA = a[0] * W + a[1], endB = z[0] * W + z[1];
    // Need two distinct abutments with valid ground elevation to span a deck.
    if (endA === endB || !mask[endA] || !mask[endB]) { skipped++; continue; }
    let deckLenM = 0, prev = a;
    for (let i = 1; i < pts.length; i++) {
      const cur = llToCell(pts[i][0], pts[i][1]);
      deckLenM += Math.hypot((cur[0] - prev[0]) * dyM, (cur[1] - prev[1]) * dxM);
      prev = cur;
    }
    if (!(deckLenM > 0)) { skipped++; continue; }
    bridges.push({ latlngs: pts, endA, endB, deckLenM, kind: w.kind, layer: w.layer, name: w.name,
      eleA: Number.isFinite(w.eleA) ? w.eleA : null, eleB: Number.isFinite(w.eleB) ? w.eleB : null });
  }
  if (!bridges.length) {
    status.innerHTML = `<span style="color:#ff6b6b">${t("bridges.none_usable", escapeHtml(sourceLabel))}</span>`;
    return false;
  }
  state.bridges = bridges;
  reappendDrawnPortals(); // this pull REPLACED state.bridges — keep drawn portals
  state.bridgesMeta = { source: sourceLabel, count: bridges.length, skipped };
  updateBridgeMeta();
  applyBridgeOverlay();
  markBridgesDirty(true);
  status.textContent = t("bridges.loaded", bridges.length);
  return true;
}

export function clearBridges() {
  state.bridges = null;
  state.bridgesMeta = null;
  state.drawnPortals = []; // 1D "Clear bridges" also drops user-drawn portals
  if (state.bridgesLayer) { state.bridgesLayer.remove(); state.bridgesLayer = null; }
  updateBridgeMeta();
  if (typeof updateDrawMeta === "function") updateDrawMeta();
  markBridgesDirty(true);
}

export function updateBridgeMeta() {
  const meta = document.getElementById("bridge-meta");
  if (!meta) return;
  if (!state.bridges) { meta.textContent = t("bridge.none"); syncLoadedHighlights(); return; }
  const m = state.bridgesMeta || {};
  let html = t("bridge.meta.count", String(state.bridges.length));
  if (m.skipped) html += `<br/>${t("bridge.meta.skipped", String(m.skipped))}`;
  meta.innerHTML = html;
  syncLoadedHighlights();
}

// Bridges change the RASTER routing (portal edges), so invalidate the compute
// + estimate. They do NOT affect the network-graph (graph mode is portal-blind;
// its bridge handling comes from the network's own tags, not state.bridges), so
// leave the cached graph alone — mirror markImpassableDirty otherwise.
export function markBridgesDirty(reprobe = false) {
  cancelActiveCompute();
  state.lastResult = null;
  kpiInvalidate(); // portal edges change ref↔ref energies
  state.bridgesToken++;
  applyBridgeOverlay();
  if (reprobe && state.dem) {
    state.calibration = null;
    state.calibrationGen++;
    state.calibrationFailed = false;
    if (state.probeWorker) { state.probeWorker.terminate(); state.probeWorker = null; }
    startCalibrationProbe();
  }
  estimateRunTime();
  syncLoadedHighlights(); // 1D status (loaded/applied) may have changed
}
