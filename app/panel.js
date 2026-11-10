// Side-panel plumbing: group highlights, label a11y, parameter persistence,
// the physics → cost-bundle readout (readCost), config export/import/reset.
import "./i18n.js"; // evaluation order — see ../app.js
import { deriveCost } from "../lib/cost.js";
import { currentLang, setLang, t } from "./i18n.js";
import { DEFAULT_LAYER_ORDER, applyLayerOrder, layerOrder, setLayerOrder } from "./map.js";
import { escapeHtml, state } from "./state.js";
import { computeMode } from "./compute-source.js";
import { status } from "./dom.js";
import { markBridgesDirty } from "./bridges.js";
import { restoreDrawnGeometry } from "./draw.js";
import { markImpassableDirty } from "./water.js";
import { applyLayerControls } from "./render.js";
import { syncComputeSourceUI } from "./engines.js";
import { COLORMAPS, applyColormapToLegend, setActiveColormap } from "./colormaps.js";

// ---- Loaded-group highlight (style only — never affects compute) --------
// Lights up the whole "Load DEM" / "vector network" group while its data is
// present. There is no central state-change event in this app — DOM is
// driven off polled state — so this is called at every DEM/network load and
// clear site. `.toggle(..., bool)` makes the clear paths self-heal.
// Set exactly one status colour (or none) on a group's <details>/<summary>.
function setGroupStatus(id, status) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove("st-green", "st-orange", "st-yellow", "st-red", "loaded");
  if (status) el.classList.add("st-" + status);
}

// Open/expand a collapsible group (and any ancestor <details>) so a nested
// group becomes visible. Used by the auto-expand hooks (DEM/network/mask/
// compute/bundle). Collapse state is not persisted — it follows these rules.
export function setGroupOpen(id, open) {
  const el = document.getElementById(id);
  if (!el) return;
  el.open = !!open;
  if (open) {
    let p = el.parentElement;
    while (p) { if (p.tagName === "DETAILS") p.open = true; p = p.parentElement; }
  }
}

// Per-group status colours (style-only). Loaded inputs (1A-1D) go green when
// applied-to-compute, orange when loaded-but-not-applied. 3B/3C/4 reflect
// whether there are enough points, the run state, and a ready result.
export function syncLoadedHighlights() {
  setGroupStatus("load-dem-group", state.dem ? "green" : "");
  const apply = (loaded, id) => loaded ? (document.getElementById(id)?.checked ? "green" : "orange") : "";
  setGroupStatus("network-group", apply(!!state.networkMask, "vec-constrain"));
  // 1C / 1D: drawn geometry counts as ready (green) on its own — even with no
  // loaded mask/network/bridge file (it's applied to the compute directly).
  const hasDrawnImp = !!((state.drawnImpassable && state.drawnImpassable.length) ||
                         (state.drawnPassable && state.drawnPassable.length));
  const hasDrawnPortals = !!(state.drawnPortals && state.drawnPortals.length);
  setGroupStatus("impassable-group", hasDrawnImp ? "green" : apply(!!state.impassable, "imp-enabled"));
  setGroupStatus("bridges-group", hasDrawnPortals ? "green" : apply(!!(state.bridges && state.bridges.length), "bridge-enabled"));

  // 3B — points & references: red = can't compute, orange = partial, green = complete.
  let pts = "";
  if (state.dem) {
    if (document.getElementById("want-density")?.checked) {
      const n = state.refPoints ? state.refPoints.length : 0;
      const target = Math.max(1, parseInt(document.getElementById("n-refs")?.value, 10) || 1);
      pts = n <= 0 ? "red" : (n >= target ? "green" : "orange");
    } else {
      pts = !state.src ? "red" : (state.dst ? "green" : "orange");
    }
  }
  setGroupStatus("pick-points-group", pts);

  // 3C — execution: orange running, green succeeded, yellow runnable-idle.
  const runBtnEl = document.getElementById("run");
  let exec = "";
  if (state.computeStartedAt) exec = "orange";
  else if (state.lastResult) exec = "green";
  else if (state.dem && runBtnEl && !runBtnEl.disabled) exec = "yellow";
  setGroupStatus("execution-group", exec);

  // 4 — results: orange if a result is ready.
  // 4 — results: orange while a compute is running, green once it finished.
  setGroupStatus("result-group", state.computeStartedAt ? "orange" : (state.lastResult ? "green" : ""));
}

// ---- Accessible names for standalone labels -----------------------------
// Most numeric/select fields are labelled by a sibling <label> with no `for`,
// so assistive tech reads them as unnamed. Associate each orphan label with
// the form control immediately after it (those controls all carry ids).
// Labels that WRAP their control (the checkbox rows) already name it — skip.
// Run once after the DOM is ready; the associations don't change with language.
export function associateOrphanLabels() {
  document.querySelectorAll("label:not([for])").forEach((lab) => {
    if (lab.querySelector("input, select, textarea")) return; // wrapping label
    const ctrl = lab.nextElementSibling;
    if (ctrl && /^(INPUT|SELECT|TEXTAREA)$/.test(ctrl.tagName) && ctrl.id) {
      lab.htmlFor = ctrl.id;
    }
  });
}

// ---- Parameter persistence (remember choices across reloads) ------------
// Saves the parameter / network / visualization control values to
// localStorage and restores them on load, so the user's knob settings
// survive a page reload. Deliberately EXCLUDES session data (the loaded DEM,
// src/dst, reference points — those ride in bundles) and `max-workers`
// (already persisted separately as simu-max-workers).
const PERSIST_KEY = "simu-params";

// ── v2 leg-energy cost bundle ────────────────────────────────────────────────
// The physics → kJ cost-bundle math (deriveCost, flatEqSpeed) and the local
// gravity constant G_SP live in lib/cost.js (shared with census/, mcp/ and
// test-energy-v2.mjs; the long GRAVITY note is there). readCost() only reads
// the Parameters inputs; deriveCost applies the defaults and clamps.
export function readCost() {
  const num = (id) => parseFloat(document.getElementById(id)?.value);
  return deriveCost({
    mass: num("mass"), crr: num("crr"), cda: num("cda"), rho: num("rho"), keff: num("keff"),
    pFlat: num("pflat"), climbThrPct: num("climb-thr"), kSmooth: num("ksmooth"),
  });
}
// The v2 analogue of v1's `alpha` (per-ground-metre distance cost) — used by the
// runtime estimator's reach model (flat reach ∝ eMax/alpha).
export function costAlphaEquiv(c) { return c.aRoll + c.aAero; }
// Read-only readout of the derived v2 cost coefficients in the Parameters panel:
// α_r (rolling), α_a (flat aero), β (climb), already kJ/m. Live-updates on change.
function updateCostReadout() {
  const c = readCost();
  const fmt4 = (n) => (Number.isFinite(n) ? n.toFixed(4) : "—");
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set("ro-alphar", fmt4(c.aRoll));
  set("ro-alphaa", fmt4(c.aAero));
  set("ro-beta", fmt4(c.beta));
}

const PERSIST_IDS = [
  // Parameters
  "mode", "mass", "crr", "cda", "rho", "keff", "pflat", "climb-thr", "ksmooth", "deadband", "dem-smooth", "e-max", "e-max-mode",
  "want-topn", "want-density",
  // Move directions + string pulling (v57) change what a run computes and
  // shows, so they belong to the remembered / exported configuration like
  // every other parameter (they were only in bundle metadata until v83).
  "n-dirs", "string-pull",
  "n-refs", "ref-sampling", "refs-visible",
  "backend-url", "orchestrator-url", "cloud-keep-warm", "cloud-machine", "cloud-no-fallback", "n-routes", "penalty", "repulsion-mode",
  "routes-colormap", "colormap",
  // Vector network
  "vec-width", "vec-snap", "vec-constrain", "vec-graph-mode", "vec-junction-mode",
  "vec-compare", "vec-render", "vec-render-width", "vec-render-opacity",
  "net-interp", "net-interp-max-dist", "net-interp-smoothing",
  // Impassable mask (1C) + bridges (1D) — apply toggles, render + generation knobs
  "imp-enabled", "imp-show", "imp-opacity", "imp-rivers", "imp-corridor", "imp-offset",
  "impassable-invert",
  "bridge-enabled", "bridge-show", "bridge-opacity", "bridge-tunnels",
  // Visualization
  "basemap-select", "tile-visible", "tile-opacity", "relief-visible", "relief-opacity",
  "energy-visible", "energy-opacity", "energy-source", "vmin", "vmax",
  "passes-visible", "passes-opacity", "passes-vmin", "passes-vmax",
  "passes-gamma", "passes-mean-window", "passes-blend",
  "passes-vmin-b", "passes-vmax-b", "passes-gamma-b", "passes-mean-window-b",
  "maxseg-len", "maxseg-turn", "maxseg-elong", "maxseg-lookback", "maxseg-nseg",
  "maxseg-colormap",
];
// Restored controls whose change must re-fire dependent UI (sub-panel
// show/hide, basemap swap). We dispatch a synthetic change after restoring so
// the existing sync handlers reconcile the panel. Deliberately EXCLUDES the
// colormap selects — their change handler calls markStyleDirty(), which would
// flag a bogus "● refresh" on load; the legend is reconciled directly via the
// activeColormap assignment + applyColormapToLegend() call below instead.
const PERSIST_REFIRE = [
  "mode", "want-density", "want-topn", "basemap-select",
  "vec-graph-mode",
];
// The compute-source selector is a radiogroup (no single element to dispatch a
// change on), so its restore + UI reconcile is handled inline in
// setupParamPersistence via syncComputeSourceUI(). Persisted under this key.
const COMPUTE_SOURCE_KEY = "compute-source";
// Connection settings (possibly private LAN hostnames) — portable through the
// explicit, user-initiated Group-0 config export/import, but NOT through
// bundles: a shared bundle must not leak the exporter's backend/orchestrator
// URLs, and importing a bundle must not silently repoint the importer's
// session to attacker-supplied endpoints. Shared by collectConfig({forBundle})
// and applyConfig's persist:false (bundle) path so they can't drift apart.
const CONNECTION_PERSIST_IDS = ["backend-url", "orchestrator-url", "cloud-keep-warm", "cloud-machine", "cloud-no-fallback"];

function savePersistedParams() {
  const out = {};
  for (const id of PERSIST_IDS) {
    const el = document.getElementById(id);
    if (!el) continue;
    out[id] = el.type === "checkbox" ? !!el.checked : el.value;
  }
  // The compute-source radiogroup persists as its checked value (not by id).
  out[COMPUTE_SOURCE_KEY] = computeMode();
  try { localStorage.setItem(PERSIST_KEY, JSON.stringify(out)); } catch {}
}

// Restore saved values, reconcile dependent UI, then wire change→save.
// Call LATE in init (after colormap selects are populated and the sub-panel
// sync handlers are wired) so dispatched changes find their listeners.
export function setupParamPersistence() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(PERSIST_KEY) || "null"); } catch {}
  if (saved && typeof saved === "object") {
    for (const id of PERSIST_IDS) {
      if (!(id in saved)) continue;
      const el = document.getElementById(id);
      if (!el) continue;
      if (el.type === "checkbox") el.checked = !!saved[id];
      else {
        el.value = saved[id];
        if (id === "colormap" && COLORMAPS[saved[id]]) setActiveColormap(saved[id]);
      }
    }
    for (const id of PERSIST_REFIRE) {
      document.getElementById(id)?.dispatchEvent(new Event("change"));
    }
    // Restore the compute-source selection. Prefer the new radiogroup key;
    // MIGRATE the old "use-backend" boolean: true → Localhost, false/absent →
    // Browser (Cloud is opt-in, never auto-selected on migration).
    let csVal = saved[COMPUTE_SOURCE_KEY];
    if (csVal == null && ("use-backend" in saved)) csVal = saved["use-backend"] ? "localhost" : "browser";
    if (csVal === "browser" || csVal === "localhost" || csVal === "cloud") {
      const radio = document.getElementById(
        csVal === "localhost" ? "cs-localhost" : csVal === "cloud" ? "cs-cloud" : "cs-browser");
      // Don't restore a disabled (non-local origin) Cloud radio — fall to Browser.
      if (radio && !radio.disabled) radio.checked = true;
    }
    applyColormapToLegend();
    applyLayerControls();
  }
  // Reconcile the compute-source sub-panels to whatever ended up selected
  // (always — even with no saved state, so the local-only gating note shows).
  syncComputeSourceUI();
  for (const id of PERSIST_IDS) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.addEventListener("change", savePersistedParams);
    el.addEventListener("input", updateCostReadout);
  }
  updateCostReadout();
  // The radios live under name="compute-source", not in PERSIST_IDS — wire
  // their change to persist too.
  document.querySelectorAll('input[name="compute-source"]').forEach((el) => {
    el.addEventListener("change", savePersistedParams);
  });
}

// ------- Full config: export / import / reset (Group 0) -------
// One portable object capturing EVERY persisted control + the separately-stored
// bits (compute source, layer order, max-workers, language). Shared by the
// Group-0 buttons AND bundle embedding (buildMetadata/applyMetadataToUI).
// opts.forBundle (default false): strip connection settings (backend/
// orchestrator URL, cloud-keep-warm) and computeSource — bundles are shared
// artifacts and must not carry the exporter's (possibly private) endpoints.
// The explicit Group-0 export (forBundle unset) keeps full fidelity.
export function collectConfig(opts = {}) {
  const forBundle = !!opts.forBundle;
  const params = {};
  for (const id of PERSIST_IDS) {
    if (forBundle && CONNECTION_PERSIST_IDS.includes(id)) continue;
    const el = document.getElementById(id);
    if (el) params[id] = el.type === "checkbox" ? !!el.checked : el.value;
  }
  // The control's own value ("0" = automatic; boot.js mirrors it to
  // localStorage "simu-max-workers" on change). Reading the stored copy
  // instead turned a never-touched "0" into "" on an export → import.
  const mwEl = document.getElementById("max-workers");
  let maxWorkers = mwEl ? mwEl.value : "";
  if (!mwEl) { try { maxWorkers = localStorage.getItem("simu-max-workers") || ""; } catch {} }
  return {
    kind: "simujoules-config",
    version: 1,
    params,
    computeSource: forBundle ? undefined : computeMode(),
    layerOrder: layerOrder.slice(),
    maxWorkers,
    lang: currentLang,
    // On-map drawn geometry (1C barriers/corridors as lat/lng rings, 1D portals
    // as lat/lng polylines) so it round-trips through config + bundles.
    drawn: {
      impassable: state.drawnImpassable || [],
      passable: state.drawnPassable || [],
      portals: (state.drawnPortals || []).map((p) => ({ latlngs: p.latlngs })),
    },
  };
}

// Apply a config object (from import or a bundle). Tolerates a flat params map.
// Returns true on success. Mirrors setupParamPersistence's restore path.
// opts.persist (default true): write the applied state back to localStorage and
// adopt the config's language. A BUNDLE load passes persist:false — it applies
// the params to the live session UI but must NOT clobber the user's saved
// language / params / layer order / max-workers on disk.
export function applyConfig(cfg, opts = {}) {
  if (!cfg || typeof cfg !== "object") return false;
  const persist = opts.persist !== false;
  const params = (cfg.params && typeof cfg.params === "object") ? cfg.params : cfg;
  for (const id of PERSIST_IDS) {
    // Bundles (persist:false) must never repoint the session's connection
    // settings — defence in depth even against a bundle whose writer forgot
    // to strip them (or an old/crafted bundle that still carries them).
    if (!persist && CONNECTION_PERSIST_IDS.includes(id)) continue;
    if (!(id in params)) continue;
    const el = document.getElementById(id);
    if (!el) continue;
    if (el.type === "checkbox") el.checked = !!params[id];
    else {
      el.value = params[id];
      if (id === "colormap" && COLORMAPS[params[id]]) setActiveColormap(params[id]);
    }
  }
  for (const id of PERSIST_REFIRE) document.getElementById(id)?.dispatchEvent(new Event("change"));
  // Same defence for the compute-source radiogroup — a bundle must not
  // silently select Localhost/Cloud for the importer.
  const cs = persist ? cfg.computeSource : null;
  if (cs === "browser" || cs === "localhost" || cs === "cloud") {
    const radio = document.getElementById(
      cs === "localhost" ? "cs-localhost" : cs === "cloud" ? "cs-cloud" : "cs-browser");
    if (radio && !radio.disabled) radio.checked = true;
  }
  syncComputeSourceUI();
  if (Array.isArray(cfg.layerOrder) && cfg.layerOrder.length) {
    const valid = cfg.layerOrder.filter((k) => DEFAULT_LAYER_ORDER.includes(k));
    setLayerOrder(valid.concat(DEFAULT_LAYER_ORDER.filter((k) => !valid.includes(k))));
    if (persist) try { localStorage.setItem("simu-layer-order", JSON.stringify(layerOrder)); } catch {}
    applyLayerOrder();
  }
  if (cfg.maxWorkers != null) {
    const mw = document.getElementById("max-workers");
    if (mw) mw.value = cfg.maxWorkers;
    if (persist) try { localStorage.setItem("simu-max-workers", String(cfg.maxWorkers)); } catch {}
  }
  // Adopt the config's language only on an explicit import — a bundle must not
  // flip the user's UI language (setLang persists it).
  if (persist && (cfg.lang === "en" || cfg.lang === "pt")) setLang(cfg.lang);
  // Restore on-map drawn geometry (overlays + masks + portal bridges).
  if (cfg.drawn && typeof cfg.drawn === "object") {
    state.drawnImpassable = Array.isArray(cfg.drawn.impassable) ? cfg.drawn.impassable : [];
    state.drawnPassable = Array.isArray(cfg.drawn.passable) ? cfg.drawn.passable : [];
    state.drawnPortals = Array.isArray(cfg.drawn.portals) ? cfg.drawn.portals : [];
    if (typeof restoreDrawnGeometry === "function") restoreDrawnGeometry();
    // The grid changed — drop any stale rendered result so it doesn't linger
    // inconsistent with the restored barriers/corridors/portals. (In the bundle
    // path the bundle's own result is rendered immediately after, overwriting.)
    const hasDrawn = (state.drawnImpassable.length || state.drawnPassable.length || state.drawnPortals.length);
    if (hasDrawn) { markImpassableDirty(true); markBridgesDirty(true); }
  }
  applyColormapToLegend();
  applyLayerControls();
  if (persist) savePersistedParams();
  return true;
}

// Wire the Group-0 export/import/reset buttons. Called from init.
export function setupConfigButtons() {
  document.getElementById("config-export")?.addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(collectConfig(), null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "simujoules-config.json";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  document.getElementById("config-import-btn")?.addEventListener("click", () => {
    document.getElementById("config-file")?.click();
  });
  document.getElementById("config-file")?.addEventListener("change", (ev) => {
    const f = ev.target.files && ev.target.files[0];
    ev.target.value = "";
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const cfg = JSON.parse(reader.result);
        if (applyConfig(cfg)) status.textContent = t("config.imported");
        else status.innerHTML = `<span style="color:#ff6b6b">${escapeHtml(t("config.import_error"))}</span>`;
      } catch (e) {
        status.innerHTML = `<span style="color:#ff6b6b">${t("config.import_error")}: ${escapeHtml(e.message)}</span>`;
      }
    };
    reader.readAsText(f);
  });
  document.getElementById("config-reset")?.addEventListener("click", () => {
    if (!window.confirm(t("config.reset_confirm"))) return;
    for (const k of ["simu-params", "simu-layer-order", "simu-max-workers", "simu-lang", "simu-sidebar-cols"]) {
      try { localStorage.removeItem(k); } catch {}
    }
    location.reload();
  });
}
