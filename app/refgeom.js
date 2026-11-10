// Reference geometry: the GPX track overlay and its energy metrics.
import "./render.js"; // evaluation order — see ../app.js
import { refEnergyKJ as refEnergyKJFromCost } from "../lib/ref-energy.js";
import { t } from "./i18n.js";
import { readCost } from "./panel.js";
import { map } from "./map.js";
import { escapeHtml, state } from "./state.js";
import { status } from "./dom.js";
import { latLngToCellFrac } from "./graph-mode.js";
import { applyLayerControls } from "./render.js";
import { formatEnergy } from "./estimate.js";

// ------- Reference geometry (GPX overlay) -------
// "Geometria de referência": a user-uploaded GPX track shown as an overlay layer.
// Hover/click shows its metrics — distance, total energy (the app's asymmetric
// α·dist+β·dh model, with the CURRENT params, recomputed on each open so it tracks
// edits), total ascent and descent. Elevation is the GPX <ele> if present, else
// sampled from the loaded DEM; without either, only distance is shown.
const REFGEOM_COLOR = "#ff2d95";

function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371008.8, toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad, dLng = (lng2 - lng1) * toRad;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

function sampleDemElevation(lat, lng) {
  if (!state.dem || !state.dem.isGeographic) return null;
  const { H, W, height, mask } = state.dem;
  const [rf, cf] = latLngToCellFrac(lat, lng);
  // Corner-based fractional coords: the point lies in cell floor(r), not round(r).
  const r = Math.floor(rf), c = Math.floor(cf);
  if (r < 0 || r >= H || c < 0 || c >= W) return null;
  const idx = r * W + c;
  return mask[idx] ? height[idx] : null;
}

function parseGpx(text) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error(t("refgeom.parse_error"));
  let pts = [...doc.getElementsByTagName("trkpt")];
  if (!pts.length) pts = [...doc.getElementsByTagName("rtept")];
  if (!pts.length) pts = [...doc.getElementsByTagName("wpt")];
  const latlngs = [], eles = [];
  for (const p of pts) {
    const lat = parseFloat(p.getAttribute("lat")), lng = parseFloat(p.getAttribute("lon"));
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    latlngs.push([lat, lng]);
    const e = p.getElementsByTagName("ele")[0];
    const ev = e ? parseFloat(e.textContent) : NaN;
    eles.push(Number.isFinite(ev) ? ev : null);
  }
  if (latlngs.length < 2) throw new Error(t("refgeom.too_short"));
  return { latlngs, eles };
}

// Resolve elevation (GPX → DEM → none), then the params-independent per-segment
// {d, dh} + distance/ascent/descent once. Energy is params-dependent → computed
// fresh from the segments on each hover (refEnergyKJ).
function buildRefTrack(latlngs, eles) {
  let elev = null, eleSource = "none";
  if (eles.some((e) => e != null)) { elev = eles.slice(); eleSource = "gpx"; }
  else {
    const demEle = latlngs.map(([la, ln]) => sampleDemElevation(la, ln));
    if (demEle.some((e) => e != null)) { elev = demEle; eleSource = "dem"; }
  }
  if (elev) { // carry-forward fill any gaps so every point has an elevation
    let last = elev.find((e) => e != null) ?? 0;
    for (let i = 0; i < elev.length; i++) { if (elev[i] == null) elev[i] = last; else last = elev[i]; }
  }
  const segs = []; let distM = 0, ascentM = 0, descentM = 0;
  for (let i = 1; i < latlngs.length; i++) {
    const d = haversineM(latlngs[i - 1][0], latlngs[i - 1][1], latlngs[i][0], latlngs[i][1]);
    const dh = elev ? elev[i] - elev[i - 1] : 0;
    segs.push({ d, dh });
    distM += d;
    if (dh > 0) ascentM += dh; else descentM += -dh;
  }
  return { latlngs, segs, distM, ascentM, descentM, eleSource, hasEle: !!elev };
}

// v2 leg energy (kJ) of a route from its {d, dh} segments — the closed form in
// lib/ref-energy.js, evaluated with the live cost bundle and the #deadband τ.
function refEnergyKJ(segs) {
  const c = readCost();
  const tdv = parseFloat(document.getElementById("deadband")?.value);
  const TAU = Math.max(0, Number.isFinite(tdv) ? tdv : 2);  // τ=0 ⇒ identity (no smoothing)
  return refEnergyKJFromCost(segs, c, TAU);
}

function refMetricsHtml() {
  const rt = state.refTrack;
  if (!rt) return "";
  const rows = [`<strong>${escapeHtml(t("layer.refgeom"))}</strong>`,
    `${escapeHtml(t("refgeom.distance"))}: ${(rt.distM / 1000).toFixed(2)} km`];
  if (rt.hasEle) {
    rows.push(`${escapeHtml(t("refgeom.energy"))}: ${escapeHtml(formatEnergy(refEnergyKJ(rt.segs)))} kJ`);
    rows.push(`${escapeHtml(t("refgeom.ascent"))}: ${Math.round(rt.ascentM)} m`);
    rows.push(`${escapeHtml(t("refgeom.descent"))}: ${Math.round(rt.descentM)} m`);
  } else {
    rows.push(escapeHtml(t("refgeom.no_elevation")));
  }
  return rows.join("<br>");
}

function renderRefTrack() {
  if (state.refTrackLayer) { state.refTrackLayer.remove(); state.refTrackLayer = null; }
  if (!state.refTrack) return;
  const renderer = L.canvas({ pane: "refgeomPane", tolerance: 8 });
  const line = L.polyline(state.refTrack.latlngs, {
    pane: "refgeomPane", color: REFGEOM_COLOR, weight: 4, opacity: 0.95, interactive: true, renderer });
  // Function content → recomputed each open, so the energy reflects current α/β/η.
  line.bindTooltip(() => refMetricsHtml(), { sticky: true, direction: "top" });
  line.bindPopup(() => refMetricsHtml());
  line.addTo(map);
  state.refTrackLayer = line;
  applyLayerControls();
}

export async function loadRefGeometry(file) {
  try {
    status.textContent = t("refgeom.loading");
    const text = await file.text();
    const { latlngs, eles } = parseGpx(text);
    state.refTrack = buildRefTrack(latlngs, eles);
    const vis = document.getElementById("refgeom-visible");
    if (vis) vis.checked = true;
    renderRefTrack();
    map.fitBounds(L.latLngBounds(state.refTrack.latlngs), { padding: [30, 30], maxZoom: 16 });
    status.textContent = t("refgeom.loaded", escapeHtml(file.name), (state.refTrack.distM / 1000).toFixed(2));
  } catch (e) {
    console.error(e);
    status.innerHTML = `<span style="color:#ff6b6b">${escapeHtml(e.message)}</span>`;
  }
}
