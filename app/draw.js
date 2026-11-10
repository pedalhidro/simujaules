// On-map drawing (Leaflet-Geoman): impassable polygons, portal bridges,
// the bridge overlay, clearVectorNetwork().
import "./bridges.js"; // evaluation order — see ../app.js
import { fillRingsEvenOdd } from "../lib/water-raster.js";
import { t } from "./i18n.js";
import { syncLoadedHighlights } from "./panel.js";
import { map } from "./map.js";
import { escapeHtml, state } from "./state.js";
import { cancelActiveCompute } from "./compute-source.js";
import { status } from "./dom.js";
import { llToCell, markBridgesDirty, updateBridgeMeta } from "./bridges.js";
import {
  clearImpassableMask, llToGridFrac, markImpassableDirty, onNetworkCorridorsChanged,
} from "./water.js";
import { removeGraphLayers } from "./graph-mode.js";

// ------- On-map drawing tools (Leaflet-Geoman) -------
// 1C: barrier polygons (force impassable) + passable-corridor polygons (force
//     passable) rasterise into state.drawn{Impassable,Passable}Mask, applied in
//     buildComputeGrid + effectivePassableAt — separate from the file/OSM mask.
// 1D: portal lines become bridge shortcuts (drawn:true) in state.bridges, so
//     buildPortals + applyBridgeOverlay pick them up like OSM bridges.
// All drawn geometry persists via collectConfig/applyConfig (config + bundle).
const DRAW_STYLE = {
  barrier:  { color: "#d6493e", weight: 2, fillColor: "#d6493e", fillOpacity: 0.25 },
  corridor: { color: "#3fb56a", weight: 2, fillColor: "#3fb56a", fillOpacity: 0.22 },
  portal:   { color: "#1f6fd0", weight: 3, dashArray: "5,5" },
};
export let drawMode = null; // 'barrier' | 'corridor' | 'portal' while a draw is armed

function ensureDrawLayers() {
  if (!state.drawLayers) {
    // Dedicated pane ABOVE the data overlays (relief..routes live at z 401-406)
    // so drawn shapes stay visible AND clickable when a result/relief is shown —
    // in the default overlayPane (400) they'd sit behind the overlays. A canvas
    // renderer bound to the pane is needed because the map is preferCanvas.
    if (!map.getPane("drawnPane")) {
      const dp = map.createPane("drawnPane");
      dp.style.zIndex = 450;
      dp.style.cursor = "pointer"; // drawn shapes are click-to-delete
      state.drawnRenderer = L.canvas({ pane: "drawnPane", tolerance: 8 }); // near-click hits thin lines too
    }
    state.drawLayers = {
      barrier:  L.layerGroup().addTo(map),
      corridor: L.layerGroup().addTo(map),
      portal:   L.layerGroup().addTo(map),
    };
  }
  return state.drawLayers;
}

// Bind a popup with a "delete this shape" button to a drawn layer, and stop the
// click from also reaching the map (which would drop a source/reference point).
function bindDeletePopup(layer, onDelete) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = "🗑 " + t("draw.delete_this");
  // Explicit high-contrast style — Leaflet's popup is white, so the app's
  // .secondary class (light text on transparent) would be invisible here.
  btn.style.cssText =
    "margin:0;padding:5px 12px;font-size:12px;font-weight:600;cursor:pointer;" +
    "background:#d6493e;color:#fff;border:none;border-radius:4px;white-space:nowrap;";
  btn.addEventListener("click", () => { layer.closePopup(); onDelete(); });
  const wrap = document.createElement("div");
  wrap.style.textAlign = "center";
  wrap.appendChild(btn);
  layer.bindPopup(wrap);
  layer.on("click", (e) => L.DomEvent.stopPropagation(e)); // don't place a point too
}

// lat/lng polygon rings → DEM-grid Uint8Array (1 inside). null if no geo DEM.
export function rasterizeRingsToMask(rings) {
  if (!state.dem || !state.dem.isGeographic || !rings || !rings.length) return null;
  const { W, H } = state.dem;
  const data = new Uint8Array(W * H);
  for (const ring of rings) fillRingsEvenOdd([ring.map(([lat, lng]) => llToGridFrac(lat, lng))], data, W, H);
  return data;
}

function rebuildDrawnMasks() {
  state.drawnImpassableMask = rasterizeRingsToMask(state.drawnImpassable);
  state.drawnPassableMask = rasterizeRingsToMask(state.drawnPassable);
  updateDrawMeta();
  markImpassableDirty(true); // mask changed → invalidate compute + reprobe
}

export function updateDrawMeta() {
  const im = document.getElementById("draw-impassable-meta");
  if (im) im.textContent = t("draw.imp_meta", (state.drawnImpassable || []).length, (state.drawnPassable || []).length);
  const pm = document.getElementById("draw-portal-meta");
  if (pm) pm.textContent = t("draw.portal_meta", (state.drawnPortals || []).length);
  // Single chokepoint for every drawn-geometry change (create/delete/clear,
  // polygons + portals all route through here) → refresh 1C/1D green status.
  syncLoadedHighlights();
}

// Build a bridge object from a drawn portal polyline (mirrors the per-way logic
// of installBridgesFromWays). Returns null if the endpoints aren't usable.
function makePortalBridge(latlngs) {
  if (!state.dem || !state.dem.isGeographic || !latlngs || latlngs.length < 2) return null;
  const { H, W, dxM, dyM, mask } = state.dem;
  const inB = (rc) => rc[0] >= 0 && rc[0] < H && rc[1] >= 0 && rc[1] < W;
  const a = llToCell(latlngs[0][0], latlngs[0][1]);
  const z = llToCell(latlngs[latlngs.length - 1][0], latlngs[latlngs.length - 1][1]);
  if (!inB(a) || !inB(z)) return null;
  const endA = a[0] * W + a[1], endB = z[0] * W + z[1];
  if (endA === endB || !mask[endA] || !mask[endB]) return null;
  let deckLenM = 0, prev = a;
  for (let i = 1; i < latlngs.length; i++) {
    const cur = llToCell(latlngs[i][0], latlngs[i][1]);
    deckLenM += Math.hypot((cur[0] - prev[0]) * dyM, (cur[1] - prev[1]) * dxM);
    prev = cur;
  }
  if (!(deckLenM > 0)) return null;
  return { latlngs, endA, endB, deckLenM, kind: "bridge", layer: 0, name: "drawn", eleA: null, eleB: null, drawn: true };
}

// Re-append the user-drawn portals to state.bridges (called after any OSM/bundle
// pull that REPLACES state.bridges, so drawings survive).
export function reappendDrawnPortals() {
  if (!state.drawnPortals || !state.drawnPortals.length) return;
  state.bridges = state.bridges || [];
  for (const p of state.drawnPortals) { const br = makePortalBridge(p.latlngs); if (br) state.bridges.push(br); }
}

// Toggle the "armed" highlight (+ aria-pressed) on the three draw buttons.
function clearDrawArmed() {
  for (const m of ["barrier", "corridor", "portal"]) {
    const b = document.getElementById("draw-" + m);
    if (b) { b.classList.remove("armed"); b.removeAttribute("aria-pressed"); }
  }
}
function startDraw(mode) {
  if (!state.dem || !state.dem.isGeographic) {
    status.innerHTML = `<span style="color:#ff6b6b">${escapeHtml(t("draw.need_dem"))}</span>`;
    return;
  }
  if (!map.pm) return;
  drawMode = mode;
  clearDrawArmed();
  const ab = document.getElementById("draw-" + mode);
  if (ab) { ab.classList.add("armed"); ab.setAttribute("aria-pressed", "true"); }
  const shape = mode === "portal" ? "Line" : "Polygon";
  map.pm.enableDraw(shape, { templineStyle: DRAW_STYLE[mode], hintlineStyle: DRAW_STYLE[mode], pathOptions: DRAW_STYLE[mode] });
  status.textContent = t("draw.drawing");
  if (window.innerWidth <= 860 && window.__simuDrawer) window.__simuDrawer.close();
}

// Render a barrier/corridor ring as a clickable polygon (delete popup wired to
// remove THIS ring from state + rebuild). Reused by draw + restore.
function addDrawnPolygon(mode, ring) {
  const key = mode === "barrier" ? "drawnImpassable" : "drawnPassable";
  const groups = ensureDrawLayers();
  const layer = L.polygon(ring, { ...DRAW_STYLE[mode], pane: "drawnPane", renderer: state.drawnRenderer }).addTo(groups[mode]);
  bindDeletePopup(layer, () => {
    state[key] = (state[key] || []).filter((r) => r !== ring);
    layer.remove();
    rebuildDrawnMasks();
    status.textContent = t("draw.cleared");
  });
  return layer;
}

// Render a drawn portal as a clickable polyline (delete popup removes THIS
// portal + its bridge). Drawn portals live in their own layer group;
// applyBridgeOverlay skips drawn bridges so they aren't double-drawn.
function addDrawnPortalLayer(entry) {
  const groups = ensureDrawLayers();
  const layer = L.polyline(entry.latlngs, { ...DRAW_STYLE.portal, pane: "drawnPane", renderer: state.drawnRenderer }).addTo(groups.portal);
  bindDeletePopup(layer, () => {
    state.drawnPortals = (state.drawnPortals || []).filter((p) => p !== entry);
    state.bridges = (state.bridges || []).filter((b) => !b.drawn);
    reappendDrawnPortals();
    layer.remove();
    applyBridgeOverlay();
    markBridgesDirty(true);
    updateDrawMeta();
    status.textContent = t("draw.cleared");
  });
  return layer;
}

function onDrawCreate(e) {
  const mode = drawMode;
  drawMode = null;
  clearDrawArmed();
  if (map.pm) map.pm.disableDraw();
  const layer = e.layer;
  if (!mode || !layer) { if (layer && layer.remove) layer.remove(); return; }
  const ll = layer.getLatLngs ? layer.getLatLngs() : null;
  if (layer.remove) layer.remove(); // drop Geoman's layer; we keep our own
  if (!ll) return;
  if (mode === "portal") {
    const pts = ll.map((p) => [p.lat, p.lng]);
    const br = makePortalBridge(pts);
    if (!br) { status.innerHTML = `<span style="color:#ff6b6b">${escapeHtml(t("draw.portal_invalid"))}</span>`; return; }
    state.drawnPortals = state.drawnPortals || [];
    const entry = { latlngs: pts };
    state.drawnPortals.push(entry);
    state.bridges = state.bridges || [];
    state.bridges.push(br);
    addDrawnPortalLayer(entry);
    markBridgesDirty(true);
    updateDrawMeta();
    status.textContent = t("draw.portal_added", state.drawnPortals.length);
  } else {
    const ring = (Array.isArray(ll[0]) ? ll[0] : ll).map((p) => [p.lat, p.lng]);
    if (ring.length < 3) return;
    const key = mode === "barrier" ? "drawnImpassable" : "drawnPassable";
    state[key] = state[key] || [];
    state[key].push(ring);
    addDrawnPolygon(mode, ring);
    rebuildDrawnMasks();
    status.textContent = t(mode === "barrier" ? "draw.barrier_added" : "draw.corridor_added", state[key].length);
  }
}

function clearDrawnImpassable() {
  state.drawnImpassable = [];
  state.drawnPassable = [];
  const layers = ensureDrawLayers();
  layers.barrier.clearLayers();
  layers.corridor.clearLayers();
  rebuildDrawnMasks();
  status.textContent = t("draw.cleared");
}

// Unified 1C eraser: clears the loaded/OSM mask AND any drawn barriers/corridors.
function clearImpassableAll() {
  clearImpassableMask();
  clearDrawnImpassable();
}

function clearDrawnPortals() {
  state.drawnPortals = [];
  state.bridges = (state.bridges || []).filter((b) => !b.drawn);
  ensureDrawLayers().portal.clearLayers();
  applyBridgeOverlay();
  markBridgesDirty(true);
  updateDrawMeta();
  status.textContent = t("draw.cleared");
}

// Re-create overlays + masks + portal bridges from restored state.drawn*
// (after a config import or bundle load).
export function restoreDrawnGeometry() {
  const layers = ensureDrawLayers();
  layers.barrier.clearLayers();
  layers.corridor.clearLayers();
  layers.portal.clearLayers();
  for (const ring of state.drawnImpassable || []) addDrawnPolygon("barrier", ring);
  for (const ring of state.drawnPassable || []) addDrawnPolygon("corridor", ring);
  state.bridges = (state.bridges || []).filter((b) => !b.drawn);
  reappendDrawnPortals();
  for (const entry of state.drawnPortals || []) addDrawnPortalLayer(entry);
  state.drawnImpassableMask = rasterizeRingsToMask(state.drawnImpassable);
  state.drawnPassableMask = rasterizeRingsToMask(state.drawnPassable);
  updateDrawMeta();
  applyBridgeOverlay();
}

export function setupDrawingTools() {
  document.getElementById("draw-barrier")?.addEventListener("click", () => startDraw("barrier"));
  document.getElementById("draw-corridor")?.addEventListener("click", () => startDraw("corridor"));
  document.getElementById("draw-portal")?.addEventListener("click", () => startDraw("portal"));
  // Esc cancels an armed draw (a mode-error escape hatch).
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && drawMode) {
      drawMode = null;
      if (map.pm) map.pm.disableDraw();
      clearDrawArmed();
      status.textContent = t("draw.cleared");
    }
  });
  document.getElementById("draw-impassable-clear")?.addEventListener("click", clearImpassableAll);
  document.getElementById("draw-portal-clear")?.addEventListener("click", clearDrawnPortals);
  if (map.pm) map.on("pm:create", onDrawCreate);
  updateDrawMeta();
}

export function bridgeOverlayOpacity() {
  const v = parseFloat(document.getElementById("bridge-opacity")?.value);
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.9;
}

// Draw the decks as polylines (bridges orange, tunnels purple) on the network
// pane. Gated on the #bridge-show toggle + a geographic DEM.
export function applyBridgeOverlay() {
  if (state.bridgesLayer) { state.bridgesLayer.remove(); state.bridgesLayer = null; }
  const show = !!document.getElementById("bridge-show")?.checked;
  if (!show || !state.dem || !state.dem.isGeographic || !state.bridges) return;
  const op = bridgeOverlayOpacity();
  const group = L.layerGroup();
  // Tolerant renderer so a click NEAR a deck (not exactly on the 3px line) hits it.
  const renderer = state.bridgeRenderer || (state.bridgeRenderer = L.canvas({ pane: "networkPane", tolerance: 8 }));
  for (const br of state.bridges) {
    if (br.drawn) continue; // user-drawn portals render in their own clickable group
    const poly = L.polyline(br.latlngs, {
      color: br.kind === "tunnel" ? "#a26bff" : "#ff7f0e",
      weight: 3, opacity: op, pane: "networkPane", interactive: true, renderer,
    }).addTo(group);
    // Click a loaded/OSM bridge or tunnel → delete it from the input dataset.
    bindDeletePopup(poly, () => {
      state.bridges = (state.bridges || []).filter((b) => b !== br);
      applyBridgeOverlay();
      markBridgesDirty(true);
      updateBridgeMeta();
      status.textContent = t("draw.cleared");
    });
  }
  group.addTo(map);
  state.bridgesLayer = group;
}

// Bridges → GeoJSON FeatureCollection (LineStrings, [lon,lat]) for the bundle.
export function bridgesToFC(bridges) {
  return {
    type: "FeatureCollection",
    features: bridges.map((br) => ({
      type: "Feature",
      properties: { kind: br.kind, layer: br.layer, name: br.name || null,
        eleA: br.eleA ?? null, eleB: br.eleB ?? null },
      geometry: { type: "LineString", coordinates: br.latlngs.map(([lat, lng]) => [lng, lat]) },
    })),
  };
}

export function clearVectorNetwork() {
  cancelActiveCompute(); // in-flight runs are constrained to the old network
  state.networkMask = null;
  state.networkSrsId = null;
  state.networkFeatureCount = 0;
  state.networkLines = null;
  state.networkLinesMeta = null;
  state.networkBridgeCandidates = null;
  if (state.networkLinesLayer) { state.networkLinesLayer.remove(); state.networkLinesLayer = null; }
  state.networkGraph = null; state.networkGraphToken = null;
  removeGraphLayers();
  state.lastGraphResult = null;
  state.graphEnergyRaster = null;
  const meta = document.getElementById("vec-meta");
  // Back to the empty state: translated text + restore data-i18n so a later
  // language toggle re-translates it (the live-load path removed the attribute).
  if (meta) { meta.textContent = t("net.no_network"); meta.setAttribute("data-i18n", "net.no_network"); }
  const inp = document.getElementById("vector-file");
  if (inp) inp.value = "";
  syncLoadedHighlights(); // group 1B no longer "loaded"
  // Corridors depend on the network — drop them, disable the toggle, recalibrate.
  onNetworkCorridorsChanged();
}
