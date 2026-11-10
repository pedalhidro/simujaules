// Map clicks → source / destination / reference points: markers, the
// reference set with undo/redo, Sobol/Halton and census placement, ref I/O.
import "./graph-mode.js"; // evaluation order — see ../app.js
import {
  clippedPolyArea, haltonPoint2D, pointInPolygon, polyArea, sobolPoint2D, sobolScalar1D,
} from "../lib/census-sampler.js";
import { t } from "./i18n.js";
import { syncLoadedHighlights } from "./panel.js";
import { map } from "./map.js";
import { escapeHtml, state } from "./state.js";
import { runBtn, status } from "./dom.js";
import { drawMode } from "./draw.js";
import {
  latLngToPixel, networkConstraintActive, pixelToLatLng, snapToNetwork,
} from "./network-view.js";
import { estimateRunTime } from "./estimate.js";
import { effectivePassableAt } from "./grid.js";

map.on("click", (e) => {
  // While a Geoman draw is armed, map clicks are placing polygon/line vertices —
  // don't ALSO drop a source/reference point (the two were confounding).
  if (drawMode || (map.pm && map.pm.globalDrawModeEnabled && map.pm.globalDrawModeEnabled())) return;
  if (!state.dem) {
    status.textContent = t("status.load_dem_first");
    return;
  }
  const rawPx = latLngToPixel(e.latlng);
  if (!rawPx) {
    status.innerHTML = `<span style="color:#ff6b6b">${t("status.click_outside")}</span>`;
    return;
  }
  // When a vector network is loaded, click points are snapped to the
  // nearest passable network cell within the configured radius.
  const px = snapToNetwork(rawPx);
  const [r, c] = px;
  const clickIdx = r * state.dem.W + c;
  if (!state.dem.mask[clickIdx]) {
    status.textContent = t("status.click_nodata");
    return;
  }
  if (!effectivePassableAt(clickIdx)) {
    // Impassable (barrier mask) and not reopened as a bridge corridor — the
    // compute would silently never seed/settle here.
    status.textContent = t("imp.cell_blocked");
    return;
  }
  if (networkConstraintActive() && !state.networkMask[r * state.dem.W + c]) {
    // Snap searches the whole grid now, so this only fires when the network
    // rasterised to zero usable cells (CRS/geometry mismatch with the DEM).
    status.innerHTML = `<span style="color:#ff6b6b">${t("status.net_no_snap_click")}</span>`;
    return;
  }
  // Density mode: clicks always add a reference point, regardless of the
  // #ref-sampling mode (random/sobol/halton/census) — that select only picks
  // how "Distribuir aleatórias" seeds points, not what a map click does. They
  // must never fall through to the src/dst branch below — density runs
  // ignore src/dst, so a silently-set source marker would contradict the
  // "— density —" displays and leak a stale seed into the compute message.
  const densityOn = !!document.getElementById("want-density")?.checked;
  if (densityOn) {
    refHistoryPush();
    addRefPoint([r, c]);
    refHistorySettle();
    return;
  }
  if (!state.src) {
    state.src = px;
    if (state.srcMarker) state.srcMarker.remove();
    state.srcMarker = L.marker(e.latlng, { icon: makeSrcDstIcon("src") })
      .addTo(map).bindTooltip(t("marker.src"));
    document.getElementById("src-display").textContent = `r=${r}, c=${c}`;
    document.getElementById("src-display").classList.add("set");
    status.textContent = t("status.src_set");
    updateRunButtonState();
  } else if (!state.dst) {
    state.dst = px;
    if (state.dstMarker) state.dstMarker.remove();
    state.dstMarker = L.marker(e.latlng, { icon: makeSrcDstIcon("dst") })
      .addTo(map).bindTooltip(t("marker.dst"));
    document.getElementById("dst-display").textContent = `r=${r}, c=${c}`;
    document.getElementById("dst-display").classList.add("set");
    status.textContent = t("status.both_set");
    updateRunButtonState(); // refresh 3B status (now src + dst → green)
  } else {
    // Reset and start over
    state.src = px;
    state.dst = null;
    if (state.srcMarker) state.srcMarker.remove();
    if (state.dstMarker) state.dstMarker.remove();
    state.srcMarker = L.marker(e.latlng, { icon: makeSrcDstIcon("src") })
      .addTo(map).bindTooltip(t("marker.src"));
    state.dstMarker = null;
    document.getElementById("src-display").textContent = `r=${r}, c=${c}`;
    document.getElementById("dst-display").textContent = t("pts.click_again");
    document.getElementById("dst-display").classList.remove("set");
    status.textContent = t("status.src_replaced");
    updateRunButtonState(); // refresh 3B status (src only → orange)
  }
});

document.getElementById("clear-points").addEventListener("click", () => {
  state.src = null;
  state.dst = null;
  if (state.srcMarker) { state.srcMarker.remove(); state.srcMarker = null; }
  if (state.dstMarker) { state.dstMarker.remove(); state.dstMarker = null; }
  if (state.pathLine) { state.pathLine.remove(); state.pathLine = null; }
  document.getElementById("src-display").textContent = t("pts.click_map");
  document.getElementById("dst-display").textContent = t("pts.optional");
  document.getElementById("src-display").classList.remove("set");
  document.getElementById("dst-display").classList.remove("set");
  updateRunButtonState();
});

// ------- Marker icons -------
// Source / destination / reference points all share a white-disc-with-
// black-border style. Tiny label text inside (`src` / `dst` / a 1-based
// order number for refs).
function makeLabelIcon(label, size, fontSize, bg = "#fff") {
  const html = `<div style="
    width:${size}px;height:${size}px;
    background:${bg};border:2px solid #000;border-radius:50%;
    display:flex;align-items:center;justify-content:center;
    font-family:ui-monospace,monospace;font-weight:700;color:#000;
    font-size:${fontSize}px;line-height:1;box-sizing:border-box;
    white-space:nowrap;
  ">${label}</div>`;
  return L.divIcon({
    html,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    className: "",
  });
}
const ICON_SRCDST_SIZE = 28, ICON_SRCDST_FONT = 9;
const ICON_REF_SIZE    = 20, ICON_REF_FONT    = 10;
export const makeSrcDstIcon = (label) => makeLabelIcon(label, ICON_SRCDST_SIZE, ICON_SRCDST_FONT);
export const makeRefIcon    = (idx, bg) => makeLabelIcon(String(idx), ICON_REF_SIZE, ICON_REF_FONT, bg);

// ------- Multi-reference density helpers -------
// FIFO buffer: state.refPoints / state.refMarkers are kept in arrival order.
// Once the population exceeds the `N references` cap, the oldest entries are
// dropped from the front. Applies to single clicks AND to "Place random".
export function addRefPoint(rc) {
  if (!state.dem) return;
  const [r, c] = rc;
  if (!effectivePassableAt(r * state.dem.W + c)) return; // nodata or blocked (barrier mask)
  // Any ref-set change voids the census population proxy and the cached
  // accessibility matrix (its rows are keyed to the refs it ran with).
  // placeCensusRefPoints re-assigns refPopM AFTER its addRefPoint loop.
  state.refPopM = null;
  kpiInvalidate();
  state.refPoints.push([r, c]);
  state.refMarkers.push(makeRefMarker(state.refPoints.length, [r, c]));
  enforceRefCap();
  syncRefDisplay();
}

// Build the numbered marker for ref #idx (1-based) at cell rc. Clicking it
// opens a popup with the ref's label and a "remove this reference" button —
// the popup content is a function so the label reflects the CURRENT number
// (deletes/trims renumber the survivors). Respects the visibility toggle: a
// marker created while refs are hidden stays off the map until the toggle
// re-adds it (applyLayerControls).
function makeRefMarker(idx, rc) {
  const [r, c] = rc;
  const { originX, originY, dx, dy } = state.dem;
  const latlng = L.latLng(originY - (r + 0.5) * dy, originX + (c + 0.5) * dx);
  const m = L.marker(latlng, { icon: makeRefIcon(idx) })
    .bindTooltip(`ref ${idx} · r=${r}, c=${c}`);
  m.bindPopup(() => {
    const i = state.refMarkers.indexOf(m);
    const cur = state.refPoints[i] || rc;
    const wrap = document.createElement("div");
    wrap.style.cssText = "text-align:center;font-size:12px;color:#000;";
    const label = document.createElement("div");
    label.style.cssText = "margin-bottom:6px;font-family:ui-monospace,monospace;";
    label.textContent = `ref ${i + 1} · r=${cur[0]}, c=${cur[1]}`;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "🗑 " + t("ref.delete_this");
    // Same explicit style as the drawn-shape delete popup: Leaflet's popup is
    // white, so the app's .secondary class would be invisible here.
    btn.style.cssText =
      "margin:0;padding:5px 12px;font-size:12px;font-weight:600;cursor:pointer;" +
      "background:#d6493e;color:#fff;border:none;border-radius:4px;white-space:nowrap;";
    btn.addEventListener("click", () => { m.closePopup(); deleteRefPoint(m); });
    wrap.appendChild(label);
    wrap.appendChild(btn);
    return wrap;
  }, { closeButton: false, offset: [0, -ICON_REF_SIZE / 2] });
  // Marker clicks must never fall through to the map handler (which would
  // drop a NEW reference under the one being inspected).
  m.on("click", (e) => L.DomEvent.stopPropagation(e));
  if (document.getElementById("refs-visible")?.checked ?? true) m.addTo(map);
  return m;
}

// Re-stamp every surviving ref's numbered icon + default tooltip so what's
// drawn matches the current order (after a FIFO trim, a delete, or a KPI
// recolor being undone).
function renumberRefMarkers() {
  for (let i = 0; i < state.refMarkers.length; i++) {
    const marker = state.refMarkers[i];
    const rc = state.refPoints[i];
    if (!marker || !rc) continue;
    marker.setIcon(makeRefIcon(i + 1));
    marker.unbindTooltip().bindTooltip(`ref ${i + 1} · r=${rc[0]}, c=${rc[1]}`);
  }
}

// Remove ONE reference by its marker (from the marker's popup). One undo
// step; the survivors are renumbered so the labels stay contiguous.
function deleteRefPoint(marker) {
  const i = state.refMarkers.indexOf(marker);
  if (i < 0) return;
  refHistoryPush();
  state.refPoints.splice(i, 1);
  state.refMarkers.splice(i, 1);
  marker.remove();
  state.refPopM = null;   // the set no longer matches the census sample
  kpiInvalidate();
  renumberRefMarkers();
  syncRefDisplay();
  status.textContent = t("ref.deleted", i + 1);
  scheduleStatusClear(status.textContent);
}

function enforceRefCap() {
  const cap = Math.max(1, parseInt(document.getElementById("n-refs")?.value, 10) || 10);
  if (state.refPoints.length > cap) {
    state.refPopM = null; // trimmed refs no longer match the census sample
    kpiInvalidate();
  }
  while (state.refPoints.length > cap) {
    state.refPoints.shift();
    const oldest = state.refMarkers.shift();
    if (oldest) oldest.remove();
  }
  // After a FIFO trim the surviving refs need their numbered icons
  // refreshed so what's drawn matches the (now reset) order.
  renumberRefMarkers();
}

export function clearRefPoints() {
  for (const m of state.refMarkers) m.remove();
  state.refMarkers = [];
  state.refPoints = [];
  state.qmcIndex = 0;
  state.refPopM = null;
  kpiInvalidate();
  syncRefDisplay();
}

// ------- Reference-set undo / redo -------
// Snapshot-based. Every USER-LEVEL operation on the ref set — map click,
// marker delete, Place random / census, Clear refs, GeoJSON load, bundle
// import — calls refHistoryPush() once BEFORE it mutates, so a batch of N
// random points is ONE undo step. Sync callers follow with
// refHistorySettle() to drop the entry when nothing actually changed (e.g. a
// clear on an empty set). The N-references cap travels with the snapshot
// (loadRefPointsFromFile raises it), and restore rebuilds the markers
// DIRECTLY — not through addRefPoint — so a cap lowered since the snapshot
// cannot FIFO-trim what undo brings back. Compute-time network re-snapping
// (runCompute) mutates refPoints in place without a snapshot on purpose: it
// is not a user action and re-applies to whatever undo restores.
const REF_HISTORY_MAX = 50;

function refSnapshot() {
  return {
    pts: state.refPoints.map(([r, c]) => [r, c]),
    qmc: state.qmcIndex,
    popM: state.refPopM,
    cap: document.getElementById("n-refs")?.value ?? null,
  };
}

function refSnapshotEquals(a, b) {
  if (!a || !b || a.pts.length !== b.pts.length) return false;
  if (a.qmc !== b.qmc || a.popM !== b.popM || a.cap !== b.cap) return false;
  for (let i = 0; i < a.pts.length; i++) {
    if (a.pts[i][0] !== b.pts[i][0] || a.pts[i][1] !== b.pts[i][1]) return false;
  }
  return true;
}

export function refHistoryPush() {
  const h = state.refHistory;
  h.past.push(refSnapshot());
  if (h.past.length > REF_HISTORY_MAX) h.past.shift();
  h.future.length = 0;
  updateRefHistoryButtons();
}

// Drop the top snapshot if the operation it preceded turned out to be a no-op.
export function refHistorySettle() {
  const h = state.refHistory;
  if (h.past.length && refSnapshotEquals(h.past[h.past.length - 1], refSnapshot())) {
    h.past.pop();
    updateRefHistoryButtons();
  }
}

export function refHistoryReset() {
  state.refHistory.past.length = 0;
  state.refHistory.future.length = 0;
  updateRefHistoryButtons();
}

function refRestore(snap) {
  for (const m of state.refMarkers) m.remove();
  state.refMarkers = [];
  state.refPoints = snap.pts.map(([r, c]) => [r, c]);
  state.qmcIndex = snap.qmc;
  kpiInvalidate();                 // rows were keyed to the set being replaced
  state.refPopM = snap.popM;
  const capInput = document.getElementById("n-refs");
  if (capInput && snap.cap != null) capInput.value = snap.cap;
  if (state.dem) {
    for (let i = 0; i < state.refPoints.length; i++) {
      state.refMarkers.push(makeRefMarker(i + 1, state.refPoints[i]));
    }
  }
  syncRefDisplay();
}

export function refUndo() {
  const h = state.refHistory;
  if (!h.past.length) return;
  h.future.push(refSnapshot());
  refRestore(h.past.pop());
  updateRefHistoryButtons();
  status.textContent = t("ref.undo.done");
  scheduleStatusClear(status.textContent);
}

export function refRedo() {
  const h = state.refHistory;
  if (!h.future.length) return;
  h.past.push(refSnapshot());
  refRestore(h.future.pop());
  updateRefHistoryButtons();
  status.textContent = t("ref.redo.done");
  scheduleStatusClear(status.textContent);
}

function updateRefHistoryButtons() {
  const u = document.getElementById("ref-undo-btn");
  const r = document.getElementById("ref-redo-btn");
  if (u) u.disabled = !state.refHistory.past.length;
  if (r) r.disabled = !state.refHistory.future.length;
}

// Drop the cached accessibility matrix + KPI block and restore the default
// ref-marker icons/tooltips. Called on ANY change that would desynchronise
// the cache from what's on screen: ref add/clear/trim, DEM load (via
// clearRefPoints in resetForNewDem), network load/clear, or a new result
// without a matrix. Safe to call repeatedly / before the UI exists.
export function kpiInvalidate() {
  if (!state.kpi) return;
  state.kpi = null;
  const group = document.getElementById("kpi-group");
  if (group) group.style.display = "none";
  // Undo the accessibility recoloring (markers may have been trimmed since).
  renumberRefMarkers();
}

// ---- Quasi-Monte-Carlo point sets for reference placement ----------------
// bitReverse32 / sobolPoint2D / haltonPoint2D (and the census polygon helpers
// further down) live in lib/census-sampler.js. The app keeps a persistent
// counter (state.qmcIndex) so successive "Place random" clicks CONTINUE the
// sequence — re-starting at i=0 every click would drop the same points on top
// of the previous batch.
export function placeRandomRefPoints(n) {
  if (!state.dem) return;
  const { mask, H, W } = state.dem;
  // Reservoir of valid cell indices is too big to enumerate for huge DEMs;
  // rejection sampling is fine for typical mask densities (~99% valid) and
  // preserves the QMC sequences' even coverage over the masked subset.
  const want = Math.max(1, Math.min(2000, n | 0));
  const sampling = document.getElementById("ref-sampling")?.value || "random";
  // "census" is population-weighted and runs an async cloud query (FlatGeobuf
  // over the DEM bbox); fork to it and leave the QMC/random paths synchronous.
  if (sampling === "census") { placeCensusRefPoints(want); return; }
  refHistoryPush();   // the whole batch is one undo step (census pushes its own)
  const nextUV =
    sampling === "sobol"  ? () => sobolPoint2D(++state.qmcIndex) :
    sampling === "halton" ? () => haltonPoint2D(++state.qmcIndex) :
    () => [Math.random(), Math.random()];
  let attempts = 0;
  const cap = want * 200;
  const placed = [];
  const seen = new Set();
  // With a constraining network, snap each sample to its nearest network
  // cell (grid-wide) — sampling the raw mask and rejecting would need
  // ~1/density attempts on sparse networks, and compute-time snapping
  // would silently move the points anyway. Snapped samples can collide,
  // hence the dedupe.
  const constrained = networkConstraintActive();
  while (placed.length < want && attempts++ < cap) {
    const [u, v] = nextUV();
    let r = (v * H) | 0;
    let c = (u * W) | 0;
    if (!mask[r * W + c]) continue;
    if (constrained) {
      [r, c] = snapToNetwork([r, c]);
      if (!state.networkMask[r * W + c]) continue; // empty network
    }
    const key = r * W + c;
    if (seen.has(key)) continue;
    seen.add(key);
    placed.push([r, c]);
  }
  for (const rc of placed) addRefPoint(rc);
  refHistorySettle();
}

// ---- Census (IBGE 2022) population-weighted reference sampling ------------
// A live, in-browser port of census/sample_census.py. Instead of spreading
// references uniformly, it samples them by where people actually live: fetch
// the census setores intersecting the DEM bbox from a cloud FlatGeobuf (HTTP
// Range queries — only the bbox slice transfers, not the ~450 MB national
// file), weight each setor by pop·(area clipped to the DEM / full area), pick
// setores by a 1-D Sobol inverse-CDF, and drop each point inside its setor
// with a 2-D Sobol rejection draw. Brazil-only; needs the network. Structural
// parity with the Python (NOT bit-parity — there's no harness pairing them).
const CENSUS_FGB_URL =
  "https://storage.googleapis.com/simujaules/census/setores_br_pop.fgb";
// Built + uploaded out-of-band by census/build_fgb.py — it lives in the cloud
// bucket, NOT in the deployed app bundle (deploy.sh never stages census/).
// Coarse Brazil bbox: skip the (multi-MB) index walk for DEMs that can't
// possibly intersect the national census coverage.
const BRAZIL_BBOX = { xmin: -74.5, ymin: -34.5, xmax: -28.5, ymax: 6.0 };

// sobolScalar1D, pointInRing/pointInPolygon, ringArea/polyArea and
// clipRingToBbox/clippedPolyArea come from lib/census-sampler.js.
// Place `want` references sampled from census population over the DEM bbox.
// Async + detached from placeRandomRefPoints (the sync QMC paths are unchanged).
async function placeCensusRefPoints(want) {
  const fail = (key, ...a) =>
    void (status.innerHTML = `<span style="color:#ff6b6b">${escapeHtml(t(key, ...a))}</span>`);
  if (!state.dem) return fail("census.no_dem");
  if (!state.dem.isGeographic) return fail("census.geographic");
  if (typeof flatgeobuf === "undefined") return fail("census.lib_missing");
  const bb = state.dem.bbox;     // {xmin,ymin,xmax,ymax} lon/lat
  if (bb.xmax < BRAZIL_BBOX.xmin || bb.xmin > BRAZIL_BBOX.xmax ||
      bb.ymax < BRAZIL_BBOX.ymin || bb.ymin > BRAZIL_BBOX.ymax)
    return fail("census.outside_brazil");
  if (state.censusInFlight) return;
  state.censusInFlight = true;
  const btn = document.getElementById("ref-place-random");
  if (btn) btn.disabled = true;
  status.textContent = t("census.fetching");
  try {
    // 1. Fetch setores intersecting the DEM bbox (HTTP Range over the .fgb).
    const rect = { minX: bb.xmin, minY: bb.ymin, maxX: bb.xmax, maxY: bb.ymax };
    const setores = [];          // { parts:[poly…], box:{minx…}, w }
    let totalW = 0;
    for await (const f of flatgeobuf.deserialize(CENSUS_FGB_URL, rect)) {
      const pop = +f?.properties?.pop;
      if (!Number.isFinite(pop) || pop <= 0) continue;
      const g = f.geometry;
      const parts = g?.type === "Polygon" ? [g.coordinates]
        : g?.type === "MultiPolygon" ? g.coordinates : null;
      if (!parts) continue;
      let full = 0, clip = 0;
      let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
      for (const rings of parts) {
        full += polyArea(rings);
        clip += clippedPolyArea(rings, bb);
        for (const p of rings[0]) {
          if (p[0] < minx) minx = p[0]; if (p[0] > maxx) maxx = p[0];
          if (p[1] < miny) miny = p[1]; if (p[1] > maxy) maxy = p[1];
        }
      }
      if (full <= 0) continue;
      const w = pop * Math.min(1, clip / full);   // pop weighted by in-extent area
      if (!(w > 0)) continue;
      setores.push({ parts, box: { minx, miny, maxx, maxy }, w });
      totalW += w;
    }
    if (!setores.length || totalW <= 0) return fail("census.no_setores");

    // 2. Population-weighted setor selection: 1-D Sobol → inverse CDF.
    const cdf = new Float64Array(setores.length);
    let acc = 0;
    for (let i = 0; i < setores.length; i++) { acc += setores[i].w; cdf[i] = acc / totalW; }
    const searchsorted = (u) => {
      let lo = 0, hi = setores.length - 1;
      while (lo < hi) { const m = (lo + hi) >> 1; if (cdf[m] < u) lo = m + 1; else hi = m; }
      return lo;
    };

    // 3. Place each point inside its setor: 2-D Sobol bbox draw + PIP rejection.
    const posCtr = new Map();     // setor idx → its 2-D Sobol counter (continues)
    const coords = [];
    for (let k = 0; k < want; k++) {
      const si = searchsorted(sobolScalar1D(k + 1));
      const s = setores[si];
      const { minx, miny, maxx, maxy } = s.box;
      let ctr = posCtr.get(si) ?? 0, pt = null;
      for (let tries = 0; tries < 64; tries++) {
        const [qx, qy] = sobolPoint2D(++ctr);
        const lng = minx + qx * (maxx - minx);
        const lat = miny + qy * (maxy - miny);
        if (s.parts.some((rings) => pointInPolygon(lng, lat, rings))) { pt = [lng, lat]; break; }
      }
      posCtr.set(si, ctr);
      if (!pt) { const r0 = s.parts[0][0]; pt = [r0[0][0], r0[0][1]]; }  // sliver fallback
      coords.push(pt);
    }

    // 4. lng/lat → pixel → passable → reference point (reuses the file-load path).
    const constrained = networkConstraintActive();
    const valid = [];
    let skipped = 0;
    for (const [lng, lat] of coords) {
      let rc = latLngToPixel(L.latLng(lat, lng));
      if (rc && constrained) {
        rc = snapToNetwork(rc);
        if (!state.networkMask[rc[0] * state.dem.W + rc[1]]) rc = null;
      }
      if (rc && effectivePassableAt(rc[0] * state.dem.W + rc[1])) valid.push(rc);
      else skipped++;
    }
    if (!valid.length) return fail("census.no_points");   // refs left untouched
    refHistoryPush();             // one undo step for the whole replacement
    clearRefPoints();             // census REPLACES the current set (like file load)
    for (const rc of valid) addRefPoint(rc);
    const placed = state.refPoints.length;
    // Population proxy for the accessibility KPIs: the refs were drawn
    // population-weighted from setores totalling totalW in-extent people, so
    // each placed ref represents refPopM/placed of them. Assigned AFTER the
    // addRefPoint loop (addRefPoint nulls it on every ref-set change).
    state.refPopM = placed > 0 ? totalW : null;
    status.textContent = skipped
      ? t("census.placed.skipped", placed, skipped)
      : t("census.placed", placed);
  } catch (err) {
    fail("census.fetch_failed", err?.message || String(err));
  } finally {
    state.censusInFlight = false;
    if (btn) btn.disabled = false;
  }
}

// Export the current reference points as a GeoJSON FeatureCollection (the
// inverse of loadRefPointsFromFile). Cells → lon/lat via pixelToLatLng; only
// works on a geographic DEM (same guard as the loader).
export function exportRefPoints() {
  if (!state.refPoints || !state.refPoints.length) {
    status.innerHTML = `<span style="color:#ff6b6b">${escapeHtml(t("ref.export_empty"))}</span>`;
    return;
  }
  const features = [];
  for (let i = 0; i < state.refPoints.length; i++) {
    const ll = pixelToLatLng(state.refPoints[i][0], state.refPoints[i][1]);
    if (!ll) { status.innerHTML = `<span style="color:#ff6b6b">${escapeHtml(t("ref.load.geographic"))}</span>`; return; }
    features.push({ type: "Feature", properties: { index: i + 1 }, geometry: { type: "Point", coordinates: [ll.lng, ll.lat] } });
  }
  const blob = new Blob([JSON.stringify({ type: "FeatureCollection", features })], { type: "application/geo+json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "referencias.geojson";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  status.textContent = t("ref.export_done", features.length);
}

// Load reference points from a GeoJSON of Point / MultiPoint features. Each
// coordinate is converted to a DEM pixel via latLngToPixel and placed through
// addRefPoint (reusing its mask check / numbered marker / FIFO cap). Replaces
// the current reference set; points outside the extent or on nodata are
// skipped. Pairs with census/sample_census.py output.
export async function loadRefPointsFromFile(file) {
  if (!file) return;
  const fail = (key, ...a) => {
    status.innerHTML = `<span style="color:#ff6b6b">${escapeHtml(t(key, ...a))}</span>`;
  };
  if (!state.dem) return fail("ref.load.no_dem");
  if (!state.dem.isGeographic) return fail("ref.load.geographic");
  let fc;
  try {
    fc = JSON.parse(await file.text());
  } catch (err) {
    return fail("ref.load.parse_error", err.message);
  }
  // Accept a FeatureCollection, a single Feature, or a bare geometry.
  const features = Array.isArray(fc?.features) ? fc.features
    : fc?.type === "Feature" ? [fc]
    : fc ? [{ geometry: fc.geometry || fc }] : [];
  const coords = [];
  for (const f of features) {
    const g = f?.geometry || f;
    if (g?.type === "Point") coords.push(g.coordinates);
    else if (g?.type === "MultiPoint") for (const c of g.coordinates) coords.push(c);
  }
  // GeoJSON coordinates are [lng, lat]. Keep only points inside the extent on a
  // passable cell; tally the rest so the load is never silently lossy.
  const valid = [];
  let skipped = 0;
  for (const [lng, lat] of coords) {
    const rc = latLngToPixel(L.latLng(lat, lng));
    if (rc && effectivePassableAt(rc[0] * state.dem.W + rc[1])) valid.push(rc);
    else skipped++;
  }
  if (!valid.length) return fail("ref.load.no_points", file.name);
  // Snapshot BEFORE the cap is raised so undo restores the previous cap too.
  refHistoryPush();
  // Raise the N-references cap so the whole file survives the FIFO trim in
  // addRefPoint (input + worker top out at 2000; warn if we clip).
  const capInput = document.getElementById("n-refs");
  if (capInput) {
    capInput.value = String(Math.min(2000, Math.max(parseInt(capInput.value, 10) || 0, valid.length)));
  }
  if (valid.length > 2000) {
    console.warn(`[refs] ${valid.length - 2000} of ${valid.length} points dropped (2000 cap, FIFO).`);
  }
  clearRefPoints();
  for (const rc of valid) addRefPoint(rc);
  const placed = state.refPoints.length;
  refHistorySettle();
  status.textContent = skipped
    ? t("ref.loaded.skipped", placed, file.name, skipped)
    : t("ref.loaded", placed, file.name);
}

export function syncRefDisplay() {
  const el = document.getElementById("ref-display");
  if (el) el.textContent = state.refPoints.length
    ? t("ref.count", state.refPoints.length)
    : t("ref.none");
  updateRunButtonState();
  estimateRunTime();
}

let statusClearTimer = null;
// Auto-dismiss a transient SUCCESS message after a few seconds so the floating
// pill doesn't park over the map indefinitely. Only clears if the text is still
// the same message (a newer status/compute write cancels the dismissal).
export function scheduleStatusClear(msg) {
  clearTimeout(statusClearTimer);
  statusClearTimer = setTimeout(() => { if (status.textContent === msg) status.textContent = ""; }, 6000);
}

// Unified gate for the Compute button. In density mode it unlocks once at
// least one reference point exists; otherwise it follows the src/dst rules.
export function updateRunButtonState() {
  if (!state.dem) {
    runBtn.disabled = true;
  } else {
    const densityOn = !!document.getElementById("want-density")?.checked;
    runBtn.disabled = densityOn
      ? !(state.refPoints && state.refPoints.length > 0)
      : !state.src;
  }
  // Explain the gate at the (disabled) button — title + status colours.
  runBtn.title = !runBtn.disabled ? ""
    : !state.dem ? t("compute.need_dem")
    : document.getElementById("want-density")?.checked ? t("compute.need_ref")
    : t("compute.need_src");
  syncLoadedHighlights(); // refresh 3B/3C/4 status colours
}
