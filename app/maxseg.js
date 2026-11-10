// Max-density segment (3C.c): coarsening, the worker run, stroke rendering.
import "./kpi.js"; // evaluation order — see ../app.js
import { coarsenFieldForMaxseg } from "../lib/maxseg-coarsen.js";
import { t } from "./i18n.js";
import { WORKER_URL } from "./boot.js";
import { map } from "./map.js";
import { escapeHtml, state } from "./state.js";
import { cellFracToLatLng } from "./graph-mode.js";
import { COLORMAPS } from "./colormaps.js";
import { buildComputeGrid } from "./grid.js";

// ---- Max-density segment (3C.c) --------------------------------------------
// Post-hoc analysis over the LAST computed passes/density field: the search
// in energy-worker.js (kind "maxseg" — multi-start self-avoiding greedy with
// rollout lookahead) finds a continuous SIMPLE path of ~L km maximising
// Σ densidade·metro. The field is block-averaged here first so the coarse
// grid fits a fixed cell budget — the factor is chosen automatically (small
// DEMs run at full resolution). Display/analysis layer only: never triggers
// a recompute, never enters a bundle, and is cleared by cancelActiveCompute()
// alongside everything else derived from the current grid + result.

const MAXSEG_CELL_BUDGET = 4 * 1024 * 1024; // coarse cells — under the worker's 16 M guard

export function clearMaxseg() {
  state.maxsegGen++;
  const ms = state.maxseg;
  if (ms) {
    if (ms.worker) ms.worker.terminate();
    if (ms.line) map.removeLayer(ms.line);
    state.maxseg = null;
  }
  const metaEl = document.getElementById("maxseg-meta");
  if (metaEl) metaEl.textContent = "—";
  const clr = document.getElementById("maxseg-clear");
  if (clr) clr.style.display = "none";
  const btn = document.getElementById("maxseg-run");
  if (btn) btn.disabled = false;
}

// Smallest integer coarsening factor that brings the coarse grid under the
// cell budget (the search's cost is dominated by a fixed pass over the cells
// plus per-start work independent of grid size, so runs stay in the seconds
// range regardless of DEM size). `steps` ≈ path cells at the target length —
// the resolution sanity check.
function maxsegPickFactor(H, W, minCellM, targetLenM) {
  for (let f = 1; f <= 8192; f++) {
    const Hc = Math.ceil(H / f), Wc = Math.ceil(W / f);
    if (Hc * Wc <= MAXSEG_CELL_BUDGET) return { f, steps: targetLenM / (f * minCellM) };
  }
  return null;
}

// Block-mean coarsening (coarsenFieldForMaxseg) lives in lib/maxseg-coarsen.js
// (shared with test-maxseg.mjs).

function runMaxseg() {
  const r = state.lastResult;
  const metaEl = document.getElementById("maxseg-meta");
  const say = (txt) => { if (metaEl) metaEl.textContent = txt; };
  if (!state.dem || !r || !r.passes) { say(t("maxseg.need_passes")); return; }
  // Route/segment polylines are lat/lng-only in this app — every route draw is
  // gated on isGeographic (a projected DEM's raw origin+dx math would land the
  // line at garbage coordinates). Refuse honestly instead of drawing nowhere.
  if (!state.dem.isGeographic) { say(t("maxseg.need_geo")); return; }
  clearMaxseg();
  const gen = state.maxsegGen; // clearMaxseg just bumped it
  const cgen = state.computeGen;

  // Same channel the passes layer is showing (a compare run can display the
  // unconstrained scenario) — mirrors rerenderCachedResult's selection.
  const energySel = document.getElementById("energy-source")?.value || "constrained";
  const field = (r.passesAlt && energySel === "unconstrained" && r.passesAlt.unconstrained)
    ? r.passesAlt.unconstrained : r.passes;

  const { H, W, dxM, dyM } = state.dem;
  const km = parseFloat(document.getElementById("maxseg-len")?.value);
  const targetLenM = (Number.isFinite(km) && km > 0 ? km : 20) * 1000;
  // Shape knobs (0 = off, clamped like the worker's own sanitiser): turn
  // smoothness and the anti-round-trip elongation preference. They steer the
  // SEARCH only — the displayed sum is always the drawn line's raw integral.
  const readShapeKnob = (id, dflt) => {
    const v = parseFloat(document.getElementById(id)?.value);
    return Number.isFinite(v) ? Math.min(4, Math.max(0, v)) : dflt;
  };
  const turnExp = readShapeKnob("maxseg-turn", 0.5);
  const elongExp = readShapeKnob("maxseg-elong", 0.5);
  // Local anti-round-trip window (km): blank = auto (target/8); 0 = off
  // (global chord reference only). Passed to the worker in metres.
  const lookRaw = document.getElementById("maxseg-lookback")?.value ?? "";
  const lookKm = parseFloat(lookRaw);
  const elongLookbackM = lookRaw.trim() === "" || !Number.isFinite(lookKm)
    ? targetLenM / 8
    : Math.max(0, lookKm) * 1000;
  // Consecutive non-overlapping segments (worker peels a tube per segment).
  // Clamp must match the worker's MAXSEG_MAX_SEGMENTS (v75 shipped with this
  // still at 10 while the worker + input said 100 — the knob silently capped).
  const nsegRaw = parseInt(document.getElementById("maxseg-nseg")?.value, 10);
  const nSegments = Number.isFinite(nsegRaw) ? Math.min(100, Math.max(1, nsegRaw)) : 1;

  const minCellM = Math.min(dxM, dyM);
  const pick = maxsegPickFactor(H, W, minCellM, targetLenM);
  if (!pick || pick.steps < 4) { say(t("maxseg.too_short")); return; }
  const f = pick.f;

  // Terrain mask (nodata + water + drawn barriers) — deliberately NOT the
  // network constraint: off-network cells carry zero density, so crossing
  // them adds length without reward and the DP avoids them on its own.
  const mask = buildComputeGrid({ maskOnly: true }).mask;
  const { density, allowed, Hc, Wc } = coarsenFieldForMaxseg(field, mask, H, W, f);

  // Field-wide mean over allowed coarse cells — the "×N of the field mean"
  // readout (scale-invariant, so raw passes counts and normalised densities
  // read the same).
  let fSum = 0, fCnt = 0;
  for (let i = 0; i < density.length; i++) if (allowed[i]) { fSum += density[i]; fCnt++; }
  const fieldMean = fCnt ? fSum / fCnt : 0;

  const w = new Worker(WORKER_URL);
  state.maxseg = { worker: w, line: null };
  const btn = document.getElementById("maxseg-run");
  if (btn) btn.disabled = true;
  const done = () => {
    if (btn) btn.disabled = false;
    w.terminate();
    if (state.maxseg && state.maxseg.worker === w) state.maxseg.worker = null;
  };
  w.onmessage = (ev) => {
    if (gen !== state.maxsegGen || cgen !== state.computeGen) return;
    const m = ev.data;
    if (m.kind === "progress") { say(t("maxseg.progress", Math.round(m.progress * 100))); return; }
    if (m.kind === "error") { done(); say(t("maxseg.failed", m.message)); return; }
    if (m.kind !== "maxseg-done") return;
    done();
    renderMaxseg(m, { f, Wc, fieldMean, minCellM });
  };
  w.onerror = (err) => {
    if (gen !== state.maxsegGen) return;
    done();
    say(t("maxseg.failed", err?.message || "worker error"));
  };
  w.postMessage(
    { kind: "maxseg", density, allowed, H: Hc, W: Wc, dx: dxM * f, dy: dyM * f, targetLenM, turnExp, elongExp, elongLookbackM, nSegments },
    [density.buffer, allowed.buffer],
  );
  say(t("maxseg.progress", 0));
}

// Segment colour: the 3C.c palette (default CET-R1) sampled at t = this
// segment's density ratio ÷ the run's best ratio — colour is PROPORTIONAL to
// how many times denser than the field the segment is, with the run's best
// at the palette top. Same anchor-lerp as routeColour.
function maxsegColour(tVal) {
  const name = document.getElementById("maxseg-colormap")?.value || "CET_R1";
  const anchors = COLORMAPS[name] || COLORMAPS.CET_R1;
  const m = anchors.length - 1;
  const fPos = Math.min(1, Math.max(0, tVal)) * m;
  const j = Math.floor(fPos), frac = fPos - j;
  const a = anchors[Math.min(j, m)], b = anchors[Math.min(j + 1, m)];
  const r = Math.round(a[0] + (b[0] - a[0]) * frac);
  const g = Math.round(a[1] + (b[1] - a[1]) * frac);
  const bl = Math.round(a[2] + (b[2] - a[2]) * frac);
  return `rgb(${r},${g},${bl})`;
}

// Palette change → restyle the drawn strokes in place (style layer only —
// same rule as recolorRouteLines: never a recompute, never a raster render).
export function recolorMaxsegStrokes() {
  const ms = state.maxseg;
  if (!ms || !ms.strokes) return;
  for (const s of ms.strokes) s.stroke.setStyle({ color: maxsegColour(s.t) });
}

function renderMaxseg(m, { f, Wc, fieldMean, minCellM }) {
  const { H, W } = state.dem;
  const segs = (m.segments && m.segments.length) ? m.segments : [m];
  // Density ratio (mean along segment ÷ field mean) per segment; the palette
  // position is PROPORTIONAL to it, normalised by the run's best ratio.
  const ratios = segs.map((seg) => {
    const meanD = seg.lengthM > 0 ? seg.sum / seg.lengthM : 0;
    return fieldMean > 0 ? meanD / fieldMean : 0;
  });
  const rMax = Math.max(...ratios);
  const entries = []; // {casing, stroke, ratio} per rank — z-sorted before adding
  const strokes = []; // {stroke, t} — for live palette recolouring
  const metaLines = [];
  let bounds = null;
  for (let si = 0; si < segs.length; si++) {
    const seg = segs[si];
    // Coarse flat indices → fine block-centre fractional cells → lat/lng.
    const pts = [];
    for (let i = 0; i < seg.path.length; i++) {
      const idx = seg.path[i];
      const cr = (idx / Wc) | 0, cc = idx - cr * Wc;
      pts.push(cellFracToLatLng(Math.min(H, cr * f + f / 2), Math.min(W, cc * f + f / 2)));
    }
    const meanD = seg.lengthM > 0 ? seg.sum / seg.lengthM : 0;
    const ratio = ratios[si];
    const label = (segs.length > 1 ? `S${si + 1}: ` : "") + t(
      "maxseg.result",
      (seg.lengthM / 1000).toFixed(2),
      meanD.toExponential(2),
      ratio.toFixed(1),
      Math.round(f * minCellM),
      Number.isFinite(seg.straightness) ? seg.straightness.toFixed(2) : "—",
    );
    // Dark casing under each stroke: the segments hug the brightest corridor
    // cells by construction — exactly where a single thin line would vanish
    // into the hot end of the colormap.
    const tPos = rMax > 0 ? ratio / rMax : 1;
    const casing = L.polyline(pts, { color: "#1a1a1a", weight: 7, opacity: 0.8, pane: "routesPane", interactive: false });
    const stroke = L.polyline(pts, {
      color: maxsegColour(tPos), weight: Math.max(2.5, 4 - si * 0.15),
      opacity: Math.max(0.7, 0.95 - si * 0.03), pane: "routesPane",
    });
    stroke.bindTooltip(label, { sticky: true });
    stroke.bindPopup(label);
    entries.push({ casing, stroke, ratio });
    strokes.push({ stroke, t: tPos });
    bounds = bounds ? bounds.extend(stroke.getBounds()) : stroke.getBounds();
    metaLines.push(label);
  }
  // Z-order by density: add in ASCENDING ratio order so the densest segment
  // paints LAST (on top) at crossings, its casing separating it from the
  // lines beneath. The group goes on the map FIRST and layers are added one
  // by one — with the group already on the map each addLayer reaches the
  // pane immediately in call order, which is what fixes the paint order
  // (a pre-filled L.layerGroup(array) replays its members in internal id
  // order on addTo, not array order).
  entries.sort((a, b) => a.ratio - b.ratio);
  const line = L.layerGroup().addTo(map);
  for (const e of entries) { line.addLayer(e.casing); line.addLayer(e.stroke); }
  // Bring the result into view — the best segment is often far from the
  // current viewport, and "found but off-screen" reads as "nothing happened".
  if (bounds) map.fitBounds(bounds, { padding: [40, 40] });
  state.maxseg = { worker: null, line, strokes };
  const metaEl = document.getElementById("maxseg-meta");
  if (metaEl) metaEl.innerHTML = metaLines.map(escapeHtml).join("<br/>");
  const clr = document.getElementById("maxseg-clear");
  if (clr) clr.style.display = "";
}

document.getElementById("maxseg-run")?.addEventListener("click", runMaxseg);
document.getElementById("maxseg-clear")?.addEventListener("click", clearMaxseg);
