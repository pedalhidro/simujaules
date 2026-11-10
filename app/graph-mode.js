// Graph mode ("follow the vectors"): graph token, route comparison,
// graph energy/passes rasterisation and overlay.
import "./network-view.js"; // evaluation order — see ../app.js
import { t } from "./i18n.js";
import { map } from "./map.js";
import { escapeHtml, state } from "./state.js";
import { networkLineWeightPx } from "./network-view.js";
import {
  applyEnergyOverlay, applyLayerControls, applyPassesOverlay, passesAsDensity, readRangeInput,
  renderDualPassesToDataURL, renderFieldToDataURL, syncRangePlaceholders, updateLegendTicks,
} from "./render.js";
import { formatSci } from "./estimate.js";
import { applyColormapToLegend, colormap, routeColour } from "./colormaps.js";

// ------- "Follow the vectors" graph mode -------
// Routing on the real polyline graph (graph-engine.js) instead of the raster
// mask, so passes trace the vectors with no staircase. Geometry round-trips
// through FRACTIONAL cell space: lat/lng → (r,c) for the engine, (r,c) → lat/lng
// for rendering. Gated to geographic DEMs (the same constraint as map clicks).
export function latLngToCellFrac(lat, lng) {
  const { originX, originY, dx, dy } = state.dem;
  return [(originY - lat) / dy, (lng - originX) / dx];
}
export function cellFracToLatLng(r, c) {
  const { originX, originY, dx, dy } = state.dem;
  return L.latLng(originY - r * dy, originX + c * dx);
}
export function networkLinesToCellLines() {
  // state.networkLines = [[ [lat,lng], … ], … ] → fractional [r,c] polylines.
  return state.networkLines.map((ln) => ln.map(([lat, lng]) => latLngToCellFrac(lat, lng)));
}
export function graphJunctionMode() {
  return document.getElementById("vec-junction-mode")?.value === "shared" ? "shared" : "crossings";
}
// Graph mode is usable only with a vector network whose geometry was kept and a
// geographic DEM. The toggle lives in the network panel.
export function graphModeActive() {
  return !!document.getElementById("vec-graph-mode")?.checked
    && !!state.networkLines && state.networkLines.length > 0
    && !!state.dem && state.dem.isGeographic;
}
// Graph mode ("follow the vectors") is a SEPARATE engine that computes on the
// network graph. The compute is INHERENTLY constrained to the network, so the
// raster "Constrain compute to network" toggle is forced ON and locked while
// graph mode is checked (its precedence is visible, not silently ignored).
// "Compare with unconstrained" STAYS togglable: graph mode now honours it,
// running a full-DEM unconstrained raster scenario alongside the graph compute
// and exposing the difference through the displayed-scenario picker (see
// startGraphCompute). The checkbox is persisted, so it can be on from a prior
// session; a synthetic change after restore re-runs this.
export function syncGraphModeUI() {
  const graph = !!document.getElementById("vec-graph-mode")?.checked;
  // Constrain: forced ON + locked in graph mode (compute is always on the net).
  // Remember the user's prior choice in a data attribute and RESTORE it when they
  // leave graph mode — entering graph mode shouldn't silently flip "constrain" on
  // for good. Only snapshot on the first entry (repeated calls while graph is on
  // must not overwrite the snapshot with the now-forced value).
  const con = document.getElementById("vec-constrain");
  if (con) {
    if (graph) {
      if (con.dataset.preGraph === undefined) con.dataset.preGraph = con.checked ? "1" : "0";
      con.checked = true;
    } else if (con.dataset.preGraph !== undefined) {
      con.checked = con.dataset.preGraph === "1";
      delete con.dataset.preGraph;
    }
    con.disabled = graph;
    const row = con.closest("label");
    if (row) {
      row.style.opacity = graph ? "0.6" : "";
      // dataset.i18nTitle (same convention as #e-max, app.js ~1241) so
      // applyTranslations() keeps this tooltip current on a language
      // toggle instead of it going stale until graph mode is retoggled.
      if (graph) { row.dataset.i18nTitle = "net.graph_constrain_locked"; row.title = t("net.graph_constrain_locked"); }
      else { delete row.dataset.i18nTitle; row.title = ""; }
    }
  }
  // Compare: stays available — graph mode does run the comparison now.
  const cmp = document.getElementById("vec-compare");
  if (cmp) {
    cmp.disabled = false;
    const row = cmp.closest("label");
    if (row) { row.style.opacity = ""; row.title = ""; }
  }
}
// Identity of everything the cached graph depends on — a change rebuilds it.
export function computeNetworkGraphToken() {
  return `${state.networkFeatureCount}|${graphJunctionMode()}|${state.dem ? state.dem.W + "x" + state.dem.H : "0"}|imp${state.impassableToken}`;
}

// Difference-view scenario colours, the single source of truth shared by the
// density passes overlay AND the source→destination route polylines: network /
// constrained = warm orange, terrain / unconstrained = azure blue. They are
// additive complements (sum to white where both routes coincide) and stay
// discriminable under red–green colour-blindness. Keeping the route lines on the
// same constants means they never drift from the field tints.
const NET_ORANGE = [255, 165, 60];
const TERR_BLUE  = [0, 90, 195];
export const NET_ORANGE_CSS = `rgb(${NET_ORANGE[0]}, ${NET_ORANGE[1]}, ${NET_ORANGE[2]})`;
export const TERR_BLUE_CSS  = `rgb(${TERR_BLUE[0]}, ${TERR_BLUE[1]}, ${TERR_BLUE[2]})`;

// Flat raster-index path → Leaflet [lat,lng] cell-centre polyline.
function rasterPathToLatLngs(p) {
  const { W, originX, originY, dx, dy } = state.dem;
  return p.map((idx) => {
    const rr = (idx / W) | 0;
    const cc = idx - rr * W;
    return [originY - (rr + 0.5) * dy, originX + (cc + 0.5) * dx];
  });
}

// Comparison content for a compare route line: shows BOTH the network and the
// terrain route's energy + length (and the Δ), so hovering / tapping EITHER line
// compares the two at once. `focus` ("network" | "terrain") bolds the line you
// are pointing at. Returns an HTML string (energies/lengths are numbers; the
// labels come from the trusted STRINGS table but are escaped defensively).
function compareRoutesContent(netE, netL, terrE, terrL, focus) {
  const fmtE = (e) => Number.isFinite(e) ? e.toExponential(2) : "—";
  const fmtL = (l) => Number.isFinite(l) ? (l / 1000).toFixed(2) + " km" : "—";
  const row = (swatch, label, e, l, on) => {
    const dot = `<span style="display:inline-block;width:9px;height:9px;border-radius:50%;` +
      `background:${swatch};margin-right:5px;vertical-align:middle"></span>`;
    const body = `${dot}${escapeHtml(label)}: E <span class="v">${fmtE(e)}</span> · ${fmtL(l)}`;
    return on ? `<strong>${body}</strong>` : body;
  };
  let html =
    row(NET_ORANGE_CSS, t("route.network"), netE, netL, focus === "network") + "<br/>" +
    row(TERR_BLUE_CSS,  t("route.terrain"), terrE, terrL, focus === "terrain");
  // Δ = network − terrain ≥ 0: the energy cost of staying on the network.
  if (Number.isFinite(netE) && Number.isFinite(terrE)) {
    const d = netE - terrE;
    const pct = terrE > 0 ? (d / terrE) * 100 : null;
    html += `<br/>${escapeHtml(t("route.delta"))}: <span class="v">${d >= 0 ? "+" : ""}${d.toExponential(2)}</span>` +
      (pct != null ? ` (${pct >= 0 ? "+" : ""}${pct.toFixed(0)}%)` : "");
  }
  // Disclosure, not recomputation: the two routes are cross-metric (8-connected
  // grid vs true polylines) — see the finding this note documents.
  html += `<br/><span style="opacity:.65;font-size:10px">${escapeHtml(t("route.compare_metric_note"))}</span>`;
  return html;
}

// Attach the compare content to a route line as BOTH a hover tooltip (desktop)
// and a click/tap popup (touch), so the energy comparison is reachable however
// the user points at it. `focus` flags which line this is.
export function bindRouteCompare(layer, focus, netE, netL, terrE, terrL) {
  const html = compareRoutesContent(netE, netL, terrE, terrL, focus);
  layer.bindTooltip(html, { sticky: true });
  layer.bindPopup(html);
}

// Draw a path/route (sequence of node ids) as a polyline over the edges.
function drawGraphPath(graph, p, colour, group) {
  if (!p || !p.nodes || !p.nodes.length) return;
  const pts = p.nodes.map((n) => cellFracToLatLng(graph.nodeR[n], graph.nodeC[n]));
  group.addLayer(L.polyline(pts, { color: colour, weight: 4, opacity: 0.95, pane: "routesPane", interactive: false }));
}

// Render the cached graph result as a colored-vector overlay. Reads the style
// knobs LIVE so colormap/range/gamma changes recolor without recomputing.
// Rasterise the graph's per-node energy onto the DEM grid (network cells only),
// stamping each edge's lerped endpoint energy along its cells with the network
// line width. Returns a Float32Array (Infinity off-network) to feed the IDW
// interp, or null if there's no energy. Invalid (off-extent) edges are skipped.
export function rasterizeGraphEnergy(graph, result) {
  if (!state.dem || !result.nodeEnergy) return null;
  const { H, W, mask } = state.dem;
  const lineWidth = Math.max(1, parseInt(document.getElementById("vec-width")?.value, 10) || 1);
  const halfWidth = (lineWidth - 1) >> 1;
  const eGrid = new Float32Array(H * W).fill(Infinity);
  let any = false;
  for (let e = 0; e < graph.nEdges; e++) {
    const a = graph.edgeA[e], b = graph.edgeB[e];
    if (graph.nodeValid && (!graph.nodeValid[a] || !graph.nodeValid[b])) continue;
    const eA = result.nodeEnergy[a], eB = result.nodeEnergy[b];
    const fA = Number.isFinite(eA), fB = Number.isFinite(eB);
    if (!fA && !fB) continue;
    const r0 = graph.nodeR[a], c0 = graph.nodeC[a], r1 = graph.nodeR[b], c1 = graph.nodeC[b];
    const steps = Math.max(1, Math.ceil(Math.hypot(r1 - r0, c1 - c0)));
    for (let s = 0; s <= steps; s++) {
      const f = s / steps;
      // Fractional coords: integer values are cell CORNERS, so point r lives
      // in cell floor(r) — round() would shift the stamp half a cell. Clamp
      // so a point exactly on the far boundary lands in the edge cell.
      const rr = Math.min(H - 1, Math.max(0, Math.floor(r0 + (r1 - r0) * f)));
      const cc = Math.min(W - 1, Math.max(0, Math.floor(c0 + (c1 - c0) * f)));
      const ev = (fA ? eA : eB) * (1 - f) + (fB ? eB : eA) * f;
      for (let pdr = -halfWidth; pdr <= halfWidth; pdr++) {
        const rrr = rr + pdr; if (rrr < 0 || rrr >= H) continue;
        for (let pdc = -halfWidth; pdc <= halfWidth; pdc++) {
          const ccc = cc + pdc; if (ccc < 0 || ccc >= W) continue;
          const idx = rrr * W + ccc;
          if (!mask[idx]) continue;
          if (ev < eGrid[idx]) eGrid[idx] = ev;
          any = true;
        }
      }
    }
  }
  return any ? eGrid : null;
}

// Splat per-edge PASSES (3C.a network channel) onto the DEM grid — the raster
// twin of buildGraphFieldLayer's vectors, so the "filtro média N" mean filter
// can smooth them exactly like the terrain passes raster. Each cell takes the
// MAX passes of any edge crossing it (a junction shouldn't sum-inflate). Mirrors
// rasterizeGraphEnergy's walk; 0 = untouched (transparent).
function rasterizeGraphPasses(graph, edgePasses) {
  if (!state.dem || !edgePasses) return null;
  const { H, W, mask } = state.dem;
  const lineWidth = Math.max(1, parseInt(document.getElementById("vec-width")?.value, 10) || 1);
  const halfWidth = (lineWidth - 1) >> 1;
  const grid = new Float32Array(H * W); // 0-filled
  let any = false;
  for (let e = 0; e < graph.nEdges; e++) {
    const v = edgePasses[e];
    if (!Number.isFinite(v) || v <= 0) continue;
    const a = graph.edgeA[e], b = graph.edgeB[e];
    if (graph.nodeValid && (!graph.nodeValid[a] || !graph.nodeValid[b])) continue;
    const r0 = graph.nodeR[a], c0 = graph.nodeC[a], r1 = graph.nodeR[b], c1 = graph.nodeC[b];
    const steps = Math.max(1, Math.ceil(Math.hypot(r1 - r0, c1 - c0)));
    for (let s = 0; s <= steps; s++) {
      const f = s / steps;
      // Same corner-based convention as rasterizeGraphEnergy: floor + clamp.
      const rr = Math.min(H - 1, Math.max(0, Math.floor(r0 + (r1 - r0) * f)));
      const cc = Math.min(W - 1, Math.max(0, Math.floor(c0 + (c1 - c0) * f)));
      for (let pdr = -halfWidth; pdr <= halfWidth; pdr++) {
        const rrr = rr + pdr; if (rrr < 0 || rrr >= H) continue;
        for (let pdc = -halfWidth; pdc <= halfWidth; pdc++) {
          const ccc = cc + pdc; if (ccc < 0 || ccc >= W) continue;
          const idx = rrr * W + ccc;
          if (!mask[idx]) continue;
          if (v > grid[idx]) grid[idx] = v;
          any = true;
        }
      }
    }
  }
  return any ? grid : null;
}

// Remove all graph-mode layers and reset the pane opacities (the raster
// overlays assume the panes sit at opacity 1 and set their own element opacity).
export function removeGraphLayers() {
  for (const k of ["graphEnergyLayer", "graphPassesLayer", "graphRoutesLayer"]) {
    if (state[k]) { state[k].remove(); state[k] = null; }
  }
  const ep = map.getPane("energyPane"), pp = map.getPane("passesPane");
  if (ep) ep.style.opacity = "";
  if (pp) { pp.style.opacity = ""; pp.style.mixBlendMode = ""; }
}

// Build one colored-polyline-per-edge vector layer for a per-edge field.
// greyscale matches the raster passes layer; colormap matches the energy layer.
// Returns a layerGroup with `_range = [lo, hi]` for the legend.
function buildGraphFieldLayer(graph, field, { pane, greyscale, tint, minId, maxId, percentiles, skipZero }) {
  if (state.dem) field = passesAsDensity(field, state.dem.W, state.dem.H); // counts → density units
  // Collect drawable values. skipZero mirrors the raster's treatZeroAsTransparent:
  // zero / unreached edges DON'T draw, so the result reads as corridors instead
  // of a full-network outline. Percentile bounds tame the long passes tail.
  const vals = [];
  for (let e = 0; e < graph.nEdges; e++) {
    const v = field[e];
    if (!Number.isFinite(v)) continue;
    if (skipZero && v <= 0) continue;
    vals.push(v);
  }
  if (!vals.length) return null;
  vals.sort((a, b) => a - b);
  const pAt = (p) => vals[Math.min(vals.length - 1, Math.max(0, Math.floor((p / 100) * (vals.length - 1))))];
  let lo = pAt(percentiles[0]), hi = pAt(percentiles[1]);
  const uMin = readRangeInput(minId, null), uMax = readRangeInput(maxId, null);
  if (uMin != null) lo = uMin;
  if (uMax != null) hi = uMax;
  const span = hi > lo ? hi - lo : 1;
  const gamma = Math.max(0.05, parseFloat(document.getElementById("passes-gamma")?.value) || 1);
  const weight = Math.max(1.5, networkLineWeightPx());
  const renderer = L.canvas({ padding: 0.3, pane });
  // Quantise per-edge intensity into a fixed number of colour/opacity BINS and
  // emit one MultiPolyline (nested latlngs) PER NON-EMPTY BIN, instead of one
  // L.Polyline per edge — a city-scale network is 10^5-10^6 drawable edges
  // after junction splitting, and that many individual layer objects freezes
  // the main thread on build and makes Leaflet's canvas renderer re-iterate
  // all of them on every pan/zoom. Colour/opacity is evaluated at the BIN
  // CENTRE, so quantisation error is at most ±1/(2·GRAPH_FIELD_BINS) of the
  // intensity range — imperceptible.
  const GRAPH_FIELD_BINS = 32;
  const binLatLngs = new Array(GRAPH_FIELD_BINS);
  for (let e = 0; e < graph.nEdges; e++) {
    const v = field[e];
    if (!Number.isFinite(v)) continue;
    if (skipZero && v <= 0) continue;
    let t = (v - lo) / span; t = t < 0 ? 0 : (t > 1 ? 1 : t);
    t = Math.pow(t, gamma);
    const bin = Math.min(GRAPH_FIELD_BINS - 1, Math.floor(t * GRAPH_FIELD_BINS));
    const a = graph.edgeA[e], b = graph.edgeB[e];
    const pair = [cellFracToLatLng(graph.nodeR[a], graph.nodeC[a]), cellFracToLatLng(graph.nodeR[b], graph.nodeC[b])];
    (binLatLngs[bin] || (binLatLngs[bin] = [])).push(pair);
  }
  const group = L.layerGroup();
  for (let bin = 0; bin < GRAPH_FIELD_BINS; bin++) {
    const pairs = binLatLngs[bin];
    if (!pairs || !pairs.length) continue;
    const tc = (bin + 0.5) / GRAPH_FIELD_BINS; // bin-centre, already gamma-mapped
    let col, op = 1;
    // Tint (difference view): keep the HUE constant (a true orange / azure) and
    // encode intensity as OPACITY. Multiplying the tint RGB by t (the old way)
    // darkened mid-values into a muddy yellow-brown that didn't read as the
    // channel colour, and made min/max edits look unresponsive (dark→dark).
    if (tint) { const [tr, tg, tb] = tint; col = `rgb(${tr},${tg},${tb})`; op = 0.3 + 0.7 * tc; }
    else if (greyscale) { const g = Math.round(tc * 255); col = `rgb(${g},${g},${g})`; }
    else { const [cr, cg, cb] = colormap(tc); col = `rgb(${cr},${cg},${cb})`; }
    group.addLayer(L.polyline(pairs, { color: col, weight, opacity: op, interactive: false, renderer }));
  }
  group._range = [lo, hi];
  return group;
}

// Render the cached graph result as a pane-integrated vector layer driven by the
// existing visibility/opacity controls, plus a routes/path layer. Passes (the
// "follow the vectors" corridors) is the primary result; energy is shown ONLY
// when there are no passes (an energy-only from/to) — otherwise colouring every
// reached edge just restates the network, which the user already toggles via
// "Draw network". Reads style knobs live → recolours on restyle, no recompute.
export function renderGraphOverlay() {
  if (!state.lastGraphResult || !state.dem) return;
  const { graph, result, energyAlt, passesAlt, pathAlt, pathAltEnergy, pathAltLengthM } = state.lastGraphResult;
  const { W, H } = state.dem;
  if (state.passesOverlay) { state.passesOverlay.remove(); state.passesOverlay = null; }
  removeGraphLayers();

  // The displayed-scenario picker only makes sense after a graph-mode COMPARE run.
  const srcRow = document.getElementById("energy-source-row");
  if (srcRow) srcRow.style.display = energyAlt ? "" : "none";
  const energySel = energyAlt
    ? (document.getElementById("energy-source")?.value || "constrained")
    : "constrained";

  // Energy: interpolated RASTER (built in finishGraph), shown through the same
  // energy imageOverlay grid mode uses → the Energy visibility/opacity/colormap
  // controls drive it, and it reads as a smooth field, not a network outline.
  // In a compare run the picker swaps the raster: the graph (constrained) field,
  // the full-DEM unconstrained field, or their difference.
  if (state.energyOverlay) { state.energyOverlay.remove(); state.energyOverlay = null; }
  const energyField = (energyAlt && energySel === "unconstrained" && energyAlt.unconstrained)
    ? energyAlt.unconstrained
    : (energyAlt && energySel === "difference" && energyAlt.difference)
      ? energyAlt.difference
      : state.graphEnergyRaster;
  if (energyField) {
    const out = renderFieldToDataURL(energyField, W, H, {
      usePercentileBounds: true, percentiles: [1, 80],
      userMin: readRangeInput("vmin", null), userMax: readRangeInput("vmax", null),
      useGreyscale: false, treatZeroAsTransparent: false,
    });
    state.energyDataUrl = out.url;
    state.lastAutoMin = out.lo; state.lastAutoMax = out.hi;
    applyEnergyOverlay();
  } else {
    state.energyDataUrl = null;
  }

  // Passes. Network = the graph "follow-the-vectors" corridors (3C.a). When a
  // compare produced terrain (free-movement) passes, the difference / unconstrained
  // views ALSO show them as a RASTER overlay (3C.b) — the terrain is NOT graphed.
  const hasPasses = !!(result.edgePasses && result.edgePasses.some((v) => v > 0));
  const terrainPasses = passesAlt && passesAlt.unconstrained;
  const showNet = hasPasses && energySel !== "unconstrained";              // graph vector passes
  const showTerr = !!terrainPasses && (energySel === "unconstrained" || energySel === "difference");
  // In the difference view, colour the two channels like the raster difference:
  // network = warm orange, terrain = azure blue (additive complements → white on
  // overlap, discriminable under red–green colour-blindness). Single-scenario
  // views stay greyscale, matching raster mode.
  const diffView = energySel === "difference";
  const numOr = (id, fb) => { const v = parseFloat(document.getElementById(id)?.value); return Number.isFinite(v) ? v : fb; };
  const intOr = (id, fb) => { const v = parseInt(document.getElementById(id)?.value, 10); return Number.isFinite(v) ? v : fb; };
  const phB = (id, v) => { const el = document.getElementById(id); if (el) el.placeholder = v; };
  // 3C.a network channel: precise VECTORS when "filtro média N" is empty; a
  // rasterised + mean-smoothed grid when N is set (so it respects the mean filter
  // exactly like the terrain raster). A rasterised network can't share the single
  // passes overlay with the terrain raster, so in the difference view the two are
  // composited into one orange/azure image (renderDualPassesToDataURL — the same
  // path raster mode's difference uses, additive blend baked into the pixels).
  const netWin = parseInt(document.getElementById("passes-mean-window")?.value, 10);
  const netRasterize = showNet && Number.isFinite(netWin) && netWin > 1;

  if (showNet && !netRasterize) {
    state.graphPassesLayer = buildGraphFieldLayer(graph, result.edgePasses, {
      pane: "passesPane", greyscale: !diffView, tint: diffView ? NET_ORANGE : null,
      minId: "passes-vmin", maxId: "passes-vmax", percentiles: [10, 90], skipZero: true });
    if (state.graphPassesLayer) {
      state.graphPassesLayer.addTo(map);
      state.lastPassesAutoMin = state.graphPassesLayer._range[0];
      state.lastPassesAutoMax = state.graphPassesLayer._range[1];
    }
  }

  if (netRasterize && showTerr) {
    // Difference: rasterised network (orange, A) + terrain (azure, B) → one image.
    const netGrid = rasterizeGraphPasses(graph, result.edgePasses);
    if (netGrid) {
      const gammaB = numOr("passes-gamma-b", null), winB = intOr("passes-mean-window-b", null);
      const out = renderDualPassesToDataURL(netGrid, terrainPasses, W, H, {
        userMin: readRangeInput("passes-vmin", null), userMax: readRangeInput("passes-vmax", null),
        gamma: numOr("passes-gamma", 1), meanWindow: netWin,
        userMinB: readRangeInput("passes-vmin-b", null), userMaxB: readRangeInput("passes-vmax-b", null),
        gammaB, meanWindowB: winB,
      });
      state.passesDataUrl = out.url;
      state.lastPassesAutoMin = out.lo; state.lastPassesAutoMax = out.hi;
      // 3C.b placeholders = the RESOLVED B (terrain) values; inputs stay empty.
      phB("passes-vmin-b", out.loB != null ? formatSci(out.loB) : "=");
      phB("passes-vmax-b", out.hiB != null ? formatSci(out.hiB) : "=");
      phB("passes-gamma-b", String(gammaB != null ? gammaB : numOr("passes-gamma", 1)));
      phB("passes-mean-window-b", String(winB != null && winB > 1 ? winB : netWin));
    } else state.passesDataUrl = null;
  } else if (netRasterize) {
    // Constrained: rasterised network only → single greyscale raster.
    const netGrid = rasterizeGraphPasses(graph, result.edgePasses);
    if (netGrid) {
      const out = renderFieldToDataURL(netGrid, W, H, {
        usePercentileBounds: true, percentiles: [10, 90], maxAboveMin: true,
        userMin: readRangeInput("passes-vmin", null), userMax: readRangeInput("passes-vmax", null),
        gamma: numOr("passes-gamma", 1), meanWindow: netWin,
        useGreyscale: true, treatZeroAsTransparent: true, densityNormalize: true,
      });
      state.passesDataUrl = out.url;
      state.lastPassesAutoMin = out.lo; state.lastPassesAutoMax = out.hi;
    } else state.passesDataUrl = null;
  } else if (showTerr) {
    // Terrain passes raster (network is vectors or absent). When terrain is the
    // displayed PRIMARY channel (unconstrained) it uses the PRIMARY controls —
    // exactly like raster mode, so the mean filter (default 5) applies and it
    // isn't thin. In the difference view it's the B-channel override, inheriting
    // the A value where empty.
    const terrPrimary = !showNet;
    const aGamma = numOr("passes-gamma", 1), aWin = intOr("passes-mean-window", 1);
    const gamma = terrPrimary ? aGamma : numOr("passes-gamma-b", aGamma);
    const win   = terrPrimary ? aWin   : intOr("passes-mean-window-b", aWin);
    const uMin = terrPrimary ? readRangeInput("passes-vmin", null)
      : (readRangeInput("passes-vmin-b", null) ?? readRangeInput("passes-vmin", null));
    const uMax = terrPrimary ? readRangeInput("passes-vmax", null)
      : (readRangeInput("passes-vmax-b", null) ?? readRangeInput("passes-vmax", null));
    const out = renderFieldToDataURL(terrainPasses, W, H, {
      usePercentileBounds: true, percentiles: [10, 90], maxAboveMin: true,
      userMin: uMin, userMax: uMax,
      gamma, meanWindow: win > 1 ? win : 1,
      useGreyscale: !diffView, tint: diffView ? TERR_BLUE : null, tintOpacityRamp: diffView,
      treatZeroAsTransparent: true, densityNormalize: true,
    });
    state.passesDataUrl = out.url;
    if (!showNet) { state.lastPassesAutoMin = out.lo; state.lastPassesAutoMax = out.hi; }
    // Difference view: surface the RESOLVED terrain values as the 3C.b placeholders
    // — the inputs stay empty (= inheriting) but show the inferred number, not "=".
    if (showNet) {
      phB("passes-vmin-b", out.lo != null ? formatSci(out.lo) : "=");
      phB("passes-vmax-b", out.hi != null ? formatSci(out.hi) : "=");
      phB("passes-gamma-b", String(gamma));
      phB("passes-mean-window-b", String(win > 1 ? win : 1));
    }
  } else {
    state.passesDataUrl = null;
  }
  applyPassesOverlay();
  const routesGroup = L.layerGroup();
  if (energyAlt && pathAlt && pathAlt.length) {
    // Compare run: the scenario picker switches the BEST ROUTE the same way it
    // switches the field — the network (graph) route in orange, the unconstrained
    // terrain (raster) route in blue, both together in the difference view. Single
    // best per scenario (top-N collapses to the optimum here).
    const showNetRoute  = energySel === "constrained" || energySel === "difference";
    const showTerrRoute = energySel === "unconstrained" || energySel === "difference";
    const netGraphPath = result.path || (result.routes && result.routes.length ? result.routes[0] : null);
    const netE = netGraphPath ? netGraphPath.energy : null;
    const netL = netGraphPath ? netGraphPath.lengthM : null;
    if (showTerrRoute) {
      const ln = L.polyline(rasterPathToLatLngs(pathAlt), {
        color: TERR_BLUE_CSS, weight: 4, opacity: 0.95, pane: "routesPane",
      });
      bindRouteCompare(ln, "terrain", netE, netL, pathAltEnergy, pathAltLengthM);
      routesGroup.addLayer(ln);
    }
    if (showNetRoute && netGraphPath) {
      // Draw the graph route directly (interactive) rather than via drawGraphPath
      // (which is interactive:false) so it carries the compare tooltip/popup too.
      const pts = netGraphPath.nodes.map((n) => cellFracToLatLng(graph.nodeR[n], graph.nodeC[n]));
      const ln = L.polyline(pts, {
        color: NET_ORANGE_CSS, weight: 4, opacity: 0.95, pane: "routesPane",
      });
      bindRouteCompare(ln, "network", netE, netL, pathAltEnergy, pathAltLengthM);
      routesGroup.addLayer(ln);
    }
  } else if (result.routes && result.routes.length) {
    for (let i = 0; i < result.routes.length; i++) drawGraphPath(graph, result.routes[i], routeColour(i, result.routes.length), routesGroup);
  } else if (result.path) {
    drawGraphPath(graph, result.path, "#4cc9f0", routesGroup);
  }
  routesGroup.addTo(map);
  state.graphRoutesLayer = routesGroup;

  const passesRow = document.getElementById("passes-row");
  if (passesRow) passesRow.style.display = (showNet || showTerr) ? "" : "none";
  // Channel mapping mirrors the raster path: the PRIMARY controls live with the
  // displayed primary channel — network (3C.a) unless terrain is the ONLY channel
  // (unconstrained), where they move to 3C.b so you edit real values there. The
  // B-channel dual-row shows only in the difference view (both channels visible).
  const primaryCtl = document.getElementById("passes-primary");
  const netBody = document.getElementById("density-net-body");
  const terrBody = document.getElementById("density-terrain-body");
  const dualRow = document.getElementById("passes-dual-row");
  const terrPrimary = showTerr && !showNet;
  const primaryHost = terrPrimary ? terrBody : netBody;
  if (primaryCtl && primaryHost && primaryCtl.parentElement !== primaryHost) primaryHost.insertBefore(primaryCtl, primaryHost.firstChild);
  if (dualRow && terrBody && dualRow.parentElement !== terrBody) terrBody.appendChild(dualRow);
  const netGroup = document.getElementById("result-density-net-group");
  const terrGroup = document.getElementById("result-density-terrain-group");
  if (netGroup) netGroup.style.display = showNet ? "" : "none";
  if (terrGroup) terrGroup.style.display = showTerr ? "" : "none";
  if (dualRow) dualRow.style.display = (showNet && showTerr) ? "" : "none";

  applyLayerControls();   // drive visibility + opacity from the Energy/Passes controls
  // Difference view: additively blend the azure terrain raster over the orange
  // network vectors so overlap sums to white (matches the raster difference).
  // After applyLayerControls, which would otherwise reset blend to passes-blend.
  if (diffView && showTerr && state.passesOverlay) {
    const el = state.passesOverlay.getElement();
    // The combined network+terrain raster (netRasterize) already bakes the
    // additive blend into its pixels, so it draws NORMAL; the vector-network
    // difference still needs plus-lighter to add the azure terrain raster over
    // the orange network vectors.
    if (el) el.style.mixBlendMode = netRasterize ? "normal" : "plus-lighter";
  }
  updateLegendTicks();
  applyColormapToLegend();
  // Show the resolved auto bounds as the 3C.a passes + 3B energy input
  // placeholders — graph mode never called this, so they stayed at the static
  // "p10"/"p90"/"auto" defaults instead of the real numbers.
  syncRangePlaceholders();
}
