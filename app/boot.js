// Worker/engine URLs, the style-dirty flag, and the DOMContentLoaded wiring
// of every static control.
import "./panel.js"; // evaluation order — see ../app.js
import { parseChangelog } from "../lib/changelog.js";
import {
  applyTranslations, currentLang, setLang, setRefreshColormapLabels, setRefreshLayerOrderList,
  t,
} from "./i18n.js";
import {
  associateOrphanLabels, setGroupOpen, setupConfigButtons, setupParamPersistence,
  syncLoadedHighlights,
} from "./panel.js";
import {
  DEFAULT_LAYER_ORDER, applyBasemap, applyLayerOrder, layerOrder, setLayerOrder,
} from "./map.js";
import { escapeHtml, state } from "./state.js";
import { cloudToken, computeMode, effectiveBackendUrl } from "./compute-source.js";
import { progress, status } from "./dom.js";
import {
  DEM_EXAMPLES, centerOnUserLocation, cropDemToViewport, downsampleDem, loadDemFromArrayBuffer,
  loadDemFromUrl, loadFabdemForView, loadImpassableFromUrl, loadVectorFromUrl,
} from "./dem.js";
import {
  exportBridgesGpkg, exportDemTif, exportMaskTif, exportNetworkGpkg, importBridgesGpkg,
  loadFgbNetwork, loadOsmNetwork, loadVectorNetwork,
} from "./network.js";
import {
  clearBridges, installBridgesFromWays, loadFgbBridges, loadOsmBridges, markBridgesDirty,
} from "./bridges.js";
import {
  applyBridgeOverlay, bridgeOverlayOpacity, clearVectorNetwork, setupDrawingTools,
} from "./draw.js";
import {
  applyImpassableRaster, clearImpassableMask, loadFgbWater, loadImpassableMaskFromFile,
  loadOsmWater, markImpassableDirty, rebuildOsmWaterMask, updateImpassableMeta,
} from "./water.js";
import { applyNetworkLinesOverlay, updateNetworkLineStyle } from "./network-view.js";
import { syncGraphModeUI } from "./graph-mode.js";
import {
  clearRefPoints, exportRefPoints, loadRefPointsFromFile, placeRandomRefPoints, refHistoryPush,
  refHistorySettle, updateRunButtonState,
} from "./points.js";
import { recolorMaxsegStrokes } from "./maxseg.js";
import {
  applyImpassableOverlay, applyLayerControls, impassableOverlayOpacity, rerenderCachedResult,
} from "./render.js";
import { loadRefGeometry } from "./refgeom.js";
import { refreshBackendCores, syncComputeSourceUI } from "./engines.js";
import { setCloudHint, stopCloudVm } from "./cloud.js";
import { estimateRunTime } from "./estimate.js";
import {
  activeColormap, applyColormapToLegend, rebuildColormapOptions, recolorRouteLines,
  setActiveColormap,
} from "./colormaps.js";
import { recomputeCorridors } from "./grid.js";
import { downloadBundle, exportRenderedImages, loadBundleFile } from "./bundle.js";

// ------- Compute workers -------
// All compute runs in energy-worker.js instances: one worker for regular
// runs, a pool of them for multi-reference density (each ref's Dijkstra is
// independent — see the density pool in the Compute handler). An optional
// native Rust backend (backend/ in the repo, OFF by default) can take over
// density runs; everything else always stays in-browser.
export const WORKER_URL = "./energy-worker.js";
// v80 WebAssembly engine (#use-wasm, default on): wasm-worker.js is a SUPERSET
// of energy-worker.js that runs density-pool slices and plain single-source
// fields on the native engine compiled to WebAssembly (wasm/ — it include!s
// backend/src/main.rs verbatim, so its numbers are the Localhost/Cloud
// engine's), falling back to the JS engine per message. The page compiles
// each module once (loadWasmEngine) and hands the WebAssembly.Module to its
// workers. Engine choice: wasmEngineFor/densityEngine (runner + estimate).
export const WASM_WORKER_URL = "./wasm-worker.js";
export const WASM_ENGINE_URLS = { wasm32: "./engine32.wasm", wasm64: "./engine64.wasm" };

// ------- Map setup -------
// "Refresh style" dirty bookkeeping.
//
// Why a snapshot rather than a plain dirty flag: in some browsers the
// blur-fired `change` event on a focused input fires AFTER a click event
// on a different element. With a plain flag, that ordering re-marks the
// state dirty *after* the Refresh handler cleared it, leading to the
// "needs a second click" symptom. With a snapshot, markStyleDirty
// compares current values against what was last rendered — if nothing
// actually differs it stays clean, regardless of event ordering.
function styleSnapshot() {
  return JSON.stringify({
    cm:  activeColormap,
    rcm: document.getElementById("routes-colormap")?.value || "",
    vm:  document.getElementById("vmin")?.value || "",
    vM:  document.getElementById("vmax")?.value || "",
    pvm: document.getElementById("passes-vmin")?.value || "",
    pvM: document.getElementById("passes-vmax")?.value || "",
    g:   document.getElementById("passes-gamma")?.value || "",
    w:   document.getElementById("passes-mean-window")?.value || "",
    b:   document.getElementById("passes-blend")?.value || "",
    pbm: document.getElementById("passes-vmin-b")?.value || "",
    pbM: document.getElementById("passes-vmax-b")?.value || "",
    gb:  document.getElementById("passes-gamma-b")?.value || "",
    wb:  document.getElementById("passes-mean-window-b")?.value || "",
  });
}
function markStyleDirty() {
  // Skip if nothing actually changed since the last render — guards
  // against late blur/change events re-marking after a refresh click.
  if (state.lastStyleSnapshot === styleSnapshot()) return;
  const btn = document.getElementById("refresh-style");
  if (btn) {
    btn.dataset.dirty = "1";
    btn.textContent = `${t("btn.refresh_style")} ●`;
  }
}
export function clearStyleDirty() {
  state.lastStyleSnapshot = styleSnapshot();
  const btn = document.getElementById("refresh-style");
  if (btn) {
    btn.dataset.dirty = "";
    btn.textContent = t("btn.refresh_style");
  }
}

// (Engine-tag pill removed — JS is the only compute engine now.)

// Wire the colormap selector and the manual range inputs. Any change
// re-renders the cached energy field — no recompute needed.
document.addEventListener("DOMContentLoaded", () => {
  // Apply translations as soon as the DOM is ready, BEFORE any other UI
  // wiring that might read element text. This populates static labels,
  // option text in select elements, etc.
  applyTranslations();
  // Give every standalone field label an accessible association (for=…).
  associateOrphanLabels();
  // Language toggle pill — flips PT ↔ EN, persists to localStorage.
  const langPill = document.getElementById("lang-tag");
  if (langPill) {
    langPill.addEventListener("click", () => {
      setLang(currentLang === "pt" ? "en" : "pt");
    });
  }
  // Populate the colormap dropdown with all CET maps, grouped by class.
  const sel = document.getElementById("colormap");
  if (sel) {
    rebuildColormapOptions(sel);
    sel.value = activeColormap;
    // Live-update the swatch (cheap CSS) but DEFER the canvas re-render to
    // the explicit Refresh-style button — re-rendering on every keystroke
    // gets laggy on large DEMs.
    sel.addEventListener("change", () => {
      setActiveColormap(sel.value);
      applyColormapToLegend();
      markStyleDirty();
    });
  }
  // Numeric range / gamma / mean-window inputs only mark "dirty"; the
  // canvas redraws on Refresh-style click.
  for (const id of [
    "vmin", "vmax",
    "passes-vmin", "passes-vmax",
    "passes-gamma", "passes-mean-window",
    "passes-vmin-b", "passes-vmax-b",
    "passes-gamma-b", "passes-mean-window-b",
    "passes-blend",
  ]) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.addEventListener("input", markStyleDirty);
    el.addEventListener("change", markStyleDirty);
  }
  // Refresh-style commits whatever's marked dirty. We force-blur any
  // focused input first so the input's blur-fired `change` event (which
  // calls markStyleDirty) runs BEFORE we render+clear, not after — that
  // ordering quirk previously left the dirty bullet on after a single
  // click and made it look like a second click was needed.
  const refreshBtn = document.getElementById("refresh-style");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => {
      if (document.activeElement && document.activeElement.blur) {
        document.activeElement.blur();
      }
      rerenderCachedResult();
      clearStyleDirty();
    });
  }
  const reset = document.getElementById("range-reset");
  if (reset) {
    reset.addEventListener("click", () => {
      for (const id of ["vmin", "vmax", "passes-vmin", "passes-vmax"]) {
        const el = document.getElementById(id);
        if (el) el.value = "";
      }
      rerenderCachedResult();
      clearStyleDirty();
    });
  }
  // Per-layer visibility / opacity controls — pure live updates (no
  // canvas re-render).
  for (const id of [
    "tile-visible",   "tile-opacity",
    "relief-visible", "relief-opacity",
    "energy-visible", "energy-opacity",
    "passes-visible", "passes-opacity",
    "refs-visible",
  ]) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.addEventListener("input", applyLayerControls);
    el.addEventListener("change", applyLayerControls);
  }
  // (Passes blend mode used to fire its own re-render here; that path
  // is now folded into the Refresh-style button along with all the
  // other heavy controls. The dirty-marker loop above already wires
  // passes-blend to markStyleDirty, so changes show up on next refresh.)
  // Routes-colormap selector — populate from CET maps and re-draw routes
  // (without recomputing) on change.
  const routesSel = document.getElementById("routes-colormap");
  if (routesSel) {
    rebuildColormapOptions(routesSel);
    routesSel.value = "CET_R2"; // perceptually uniform rainbow — good for ranks
    // Recolour only the route polylines — no full raster re-render of the
    // energy/passes canvases (which the field-colormap inputs defer behind
    // the Refresh-style button anyway).
    routesSel.addEventListener("change", recolorRouteLines);
  }
  // Max-density-segment palette — same pattern as routes: populate from the
  // CET catalog, recolour the drawn strokes in place on change (no recompute).
  const maxsegSel = document.getElementById("maxseg-colormap");
  if (maxsegSel) {
    rebuildColormapOptions(maxsegSel);
    maxsegSel.value = "CET_R1"; // perceptually uniform rainbow (user request)
    maxsegSel.addEventListener("change", recolorMaxsegStrokes);
  }
  setRefreshColormapLabels(() => {
    if (sel) rebuildColormapOptions(sel);
    if (routesSel) rebuildColormapOptions(routesSel);
    if (maxsegSel) rebuildColormapOptions(maxsegSel);
  });
  // Top-N toggle reveals N + penalty + repulsion inputs
  const topnCheck = document.getElementById("want-topn");
  const topnExtra = document.getElementById("topn-extra");
  if (topnCheck && topnExtra) {
    const sync = () => { topnExtra.style.display = topnCheck.checked ? "" : "none"; estimateRunTime(); };
    topnCheck.addEventListener("change", sync);
    sync();
  }
  // Budget-mode select is only meaningful in round-trip mode (a single leg
  // IS the total in from/to) — hide it elsewhere.
  const modeSel = document.getElementById("mode");
  const budgetModeRow = document.getElementById("e-max-mode-row");
  if (modeSel && budgetModeRow) {
    const syncBudgetMode = () => {
      budgetModeRow.style.display = modeSel.value === "round" ? "" : "none";
    };
    modeSel.addEventListener("change", syncBudgetMode);
    syncBudgetMode();
  }
  // Basemap selector — swaps the base tile layer / solid background.
  const basemapSel = document.getElementById("basemap-select");
  if (basemapSel) {
    basemapSel.addEventListener("change", () => applyBasemap(basemapSel.value));
  }
  // Vector-network rendering toggle — pure overlay add/remove, no recompute.
  document.getElementById("vec-render")?.addEventListener("change", applyNetworkLinesOverlay);
  // Width/opacity restyle the existing polylines in place (live).
  for (const id of ["vec-render-width", "vec-render-opacity"]) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.addEventListener("input", updateNetworkLineStyle);
    el.addEventListener("change", updateNetworkLineStyle);
  }
  // Compute-source selector (Browser / Localhost / Cloud — a top-level compute
  // option). Each radio's change reconciles the sub-panels (Localhost URL /
  // Cloud orchestrator) and gates Cloud to local origins. Browser is the
  // default and the always-available fallback. syncComputeSourceUI also runs in
  // setupParamPersistence after the persisted selection is restored.
  document.querySelectorAll('input[name="compute-source"]').forEach((el) => {
    el.addEventListener("change", syncComputeSourceUI);
  });
  syncComputeSourceUI();
  // Persist the advanced max-workers override per device (like the lang /
  // layer-order prefs) — power users on big-RAM machines set it once.
  const maxWorkersEl = document.getElementById("max-workers");
  if (maxWorkersEl) {
    try { const v = localStorage.getItem("simu-max-workers"); if (v != null) maxWorkersEl.value = v; } catch {}
    maxWorkersEl.addEventListener("change", () => {
      try { localStorage.setItem("simu-max-workers", maxWorkersEl.value); } catch {}
    });
  }
  // The WebAssembly engine toggle (v80) is a per-device choice too — kept out
  // of PERSIST_IDS so bundles/config exports never carry it.
  const useWasmEl = document.getElementById("use-wasm");
  if (useWasmEl) {
    try { const v = localStorage.getItem("simu-use-wasm"); if (v != null) useWasmEl.checked = v === "1"; } catch {}
    useWasmEl.addEventListener("change", () => {
      try { localStorage.setItem("simu-use-wasm", useWasmEl.checked ? "1" : "0"); } catch {}
    });
  }
  // Density toggle reveals the multi-ref controls and locks out the
  // single-source top-N toggle, which doesn't compose with multi-reference
  // density. (Passes are always computed since v68 — no toggle to lock.)
  const densCheck = document.getElementById("want-density");
  const densExtra = document.getElementById("density-extra");
  if (densCheck && densExtra) {
    const sync = () => {
      const on = densCheck.checked;
      densExtra.style.display = on ? "" : "none";
      if (on) setGroupOpen("pick-points-group", true); // surface the census/refs panel

      const topnCheck = document.getElementById("want-topn");
      const topnLabel = topnCheck?.closest("label");
      const topnExtra = document.getElementById("topn-extra");
      if (topnCheck) {
        if (on) { topnCheck.checked = false; topnCheck.disabled = true; }
        else topnCheck.disabled = false;
      }
      if (topnLabel) topnLabel.style.opacity = on ? "0.5" : "1";
      if (on && topnExtra) topnExtra.style.display = "none";

      // Drop any source/destination state when entering density mode —
      // it's not used and the leftover markers / UI labels are confusing.
      // Fade ONLY the src/dst picker (references replace it); the reference-
      // action buttons clustered below it must stay live in density mode.
      const srcdst = document.getElementById("pick-points-srcdst");
      if (srcdst) {
        srcdst.style.opacity = on ? "0.45" : "1";
        srcdst.style.pointerEvents = on ? "none" : "";
      }
      // The "Place random" / "Clear refs" cluster only applies in density mode.
      const refActions = document.getElementById("ref-actions-row");
      if (refActions) refActions.style.display = on ? "" : "none";
      if (on) {
        state.src = null;
        state.dst = null;
        if (state.srcMarker) { state.srcMarker.remove(); state.srcMarker = null; }
        if (state.dstMarker) { state.dstMarker.remove(); state.dstMarker = null; }
        if (state.pathLine)  { state.pathLine.remove();  state.pathLine = null; }
        const srcDisp = document.getElementById("src-display");
        const dstDisp = document.getElementById("dst-display");
        if (srcDisp) { srcDisp.textContent = t("pts.density"); srcDisp.classList.remove("set"); }
        if (dstDisp) { dstDisp.textContent = t("pts.density"); dstDisp.classList.remove("set"); }
      } else {
        const srcDisp = document.getElementById("src-display");
        const dstDisp = document.getElementById("dst-display");
        if (srcDisp && !state.src) srcDisp.textContent = t("pts.click_map");
        if (dstDisp && !state.dst) dstDisp.textContent = t("pts.optional");
      }

      // Energy layer stays available in density mode — when refs > 0 the
      // worker returns the per-cell mean energy across all refs, so the
      // user can read the average as well as the density.
      applyLayerControls();
      // Re-render any cached result (so a leftover energy overlay clears).
      rerenderCachedResult();

      // Compute button gate flips between src-required and refs-required.
      updateRunButtonState();
      estimateRunTime();
    };
    densCheck.addEventListener("change", sync);
    sync();
  }
  document.getElementById("ref-place-random")?.addEventListener("click", () => {
    const n = parseInt(document.getElementById("n-refs")?.value, 10) || 10;
    placeRandomRefPoints(n);
  });
  document.getElementById("ref-clear")?.addEventListener("click", () => {
    refHistoryPush();
    clearRefPoints();
    refHistorySettle();   // clearing an empty set is not an undo step
  });
  document.getElementById("ref-file")?.addEventListener("change", async (ev) => {
    const f = ev.target.files[0];
    if (f) await loadRefPointsFromFile(f);
    ev.target.value = "";   // let the same file be re-loaded
  });
  document.getElementById("ref-export")?.addEventListener("click", exportRefPoints);
  // Anything that affects the time estimate
  // Inputs that move the (now budget- and engine-aware) time estimate.
  // `alpha` scales the explored region (flat reach ∝ eMax/alpha); the
  // compute-source selector switches the engine model (handled below with the
  // radios, since they share a name rather than a single id).
  for (const id of ["mode", "want-topn", "n-routes", "want-density",
                    "n-refs", "e-max", "mass", "crr", "cda", "rho", "keff", "pflat", "ksmooth", "max-workers", "use-wasm",
                    // Network/graph + interpolation controls — they move the
                    // estimate now that interp is a separate phase and graph
                    // mode has its own (much cheaper) compute model.
                    "net-interp", "net-interp-max-dist", "net-interp-smoothing",
                    "vec-graph-mode", "vec-constrain", "vec-compare"]) {
    const el = document.getElementById(id);
    if (el) el.addEventListener("change", estimateRunTime);
  }
  // Graph mode supersedes the raster constrain/compare toggles in the run
  // dispatch — grey them out when it's on so the precedence is visible. Fires
  // on toggle AND on load (vec-graph-mode is in PERSIST_REFIRE → synthetic
  // change after restore). See syncGraphModeUI.
  document.getElementById("vec-graph-mode")?.addEventListener("change", syncGraphModeUI);
  syncGraphModeUI();
  // Compute-source / URL changes refresh the cached /health core count (used by
  // the estimate's backend-parallelism model) AND re-estimate (engine model +
  // transfer line). The radios share name="compute-source"; the two URL fields
  // (backend / orchestrator) feed the same /health probe via effectiveBackendUrl.
  const onComputeSourceChange = () => { refreshBackendCores(); estimateRunTime(); };
  document.querySelectorAll('input[name="compute-source"]').forEach((el) => {
    el.addEventListener("change", onComputeSourceChange);
  });
  for (const id of ["backend-url", "orchestrator-url"]) {
    const el = document.getElementById(id);
    if (el) { el.addEventListener("change", onComputeSourceChange); el.addEventListener("input", estimateRunTime); }
  }
  // Cloud machine size: the estimate models the SELECTED size directly
  // (backendSpecForEstimate) — re-estimate on change, no /health probe needed.
  document.getElementById("cloud-machine")?.addEventListener("change", estimateRunTime);
  // "Desligar VM agora": manual stop, so a size change applies without the
  // untick-keep-warm-run-retick dance (a lease from a concurrent client still
  // vetoes the stop orchestrator-side). Best-effort like the post-run stop.
  document.getElementById("cloud-stop-now")?.addEventListener("click", () => {
    const url = computeMode() === "cloud" ? effectiveBackendUrl() : "";
    if (!url || !cloudToken()) { setCloudHint("cloud.need_orch_url"); return; }
    stopCloudVm(url);
    setCloudHint("cloud.stopping_manual");
  });
  // Cloud password: persisted in sessionStorage (a secret — NOT localStorage,
  // where the URL fields live). Restore on load, save on input.
  {
    const tokEl = document.getElementById("cloud-token");
    if (tokEl) {
      try { tokEl.value = sessionStorage.getItem("cloud-token") || ""; } catch { /* private mode */ }
      tokEl.addEventListener("input", () => {
        try { sessionStorage.setItem("cloud-token", tokEl.value); } catch { /* private mode */ }
      });
    }
  }
  // Example DEM loader links — populated declaratively in HTML, wired here.
  for (const ex of DEM_EXAMPLES) {
    const a = document.getElementById(ex.id);
    if (!a) continue;
    a.addEventListener("click", (ev) => {
      ev.preventDefault();
      loadDemFromUrl(ex.url, ex.label);
    });
  }
  // FABDEM-for-current-viewport. Sized at click time from map.getBounds()
  // so the user can zoom around before clicking; capped at FABDEM_MAX_BYTES
  // (10°² ≈ 494 MiB) inside loadFabdemForView().
  const fabBtn = document.getElementById("ex-fabdem-view");
  if (fabBtn) {
    fabBtn.addEventListener("click", (ev) => {
      ev.preventDefault();
      loadFabdemForView();
    });
  }
  // Crop the loaded DEM to the current viewport (1A) — export→reimport of
  // the window through the standard load path; see cropDemToViewport().
  document.getElementById("crop-dem")?.addEventListener("click", cropDemToViewport);
  // Downsample the loaded DEM by block averaging (1A); factor from the select.
  document.getElementById("downsample-dem")?.addEventListener("click", () => {
    const f = parseInt(document.getElementById("dem-downsample-factor")?.value, 10) || 6;
    downsampleDem(f);
  });
  // Locate-me floating button. Lives on the map (not in the drawer),
  // so it's reachable on mobile without opening the controls panel.
  document.getElementById("locate-btn")?.addEventListener("click", centerOnUserLocation);
  // Vector-network upload + clear.
  const vecFile = document.getElementById("vector-file");
  if (vecFile) {
    vecFile.addEventListener("change", async (ev) => {
      const f = ev.target.files[0];
      if (!f) return;
      try {
        await loadVectorNetwork(f);
      } catch (err) {
        console.error(err);
        progress.classList.remove("active");
        status.innerHTML = `<span style="color:#ff6b6b">${t("status.gpkg_failed", escapeHtml(err.message))}</span>`;
      }
      // Reset the input so re-picking the same file fires `change` again.
      ev.target.value = "";
    });
  }
  const vecClearBtn = document.getElementById("vec-clear");
  if (vecClearBtn) vecClearBtn.addEventListener("click", clearVectorNetwork);
  document.getElementById("vec-osm")?.addEventListener("click", loadOsmNetwork);
  document.getElementById("vec-fgb")?.addEventListener("click", loadFgbNetwork);
  document.getElementById("ex-viario")?.addEventListener("click", () =>
    loadVectorFromUrl("https://simujaules.pedalhidrografi.co/vector/sampa-viario.gpkg", t("net.example_viario")));

  // --- Impassable mask (group 1c) ---
  const impFile = document.getElementById("impassable-file");
  if (impFile) {
    impFile.addEventListener("change", async (ev) => {
      const f = ev.target.files[0];
      if (f) await loadImpassableMaskFromFile(f);
      ev.target.value = ""; // re-picking the same file fires change again
    });
  }
  document.getElementById("impassable-clear")?.addEventListener("click", clearImpassableMask);
  document.getElementById("impassable-osm")?.addEventListener("click", loadOsmWater);
  document.getElementById("impassable-fgb")?.addEventListener("click", loadFgbWater);
  document.getElementById("ex-water")?.addEventListener("click", () =>
    loadImpassableFromUrl("https://simujaules.pedalhidrografi.co/mask/water_mask.tif", t("imp.example_water")));
  document.getElementById("imp-rivers")?.addEventListener("change", async () => { await rebuildOsmWaterMask(); });
  document.getElementById("imp-enabled")?.addEventListener("change", () => markImpassableDirty(true));
  // 1B "Aplicar ao cálculo" toggle updates its green/orange status.
  document.getElementById("vec-constrain")?.addEventListener("change", syncLoadedHighlights);
  document.getElementById("impassable-invert")?.addEventListener("change", () => {
    // Re-resample the cached source with the flipped convention (no re-upload).
    if (state.impassableRaster) applyImpassableRaster(state.impassableRaster, state.impassableMeta?.name);
  });
  document.getElementById("imp-corridor")?.addEventListener("change", (ev) => {
    const row = document.getElementById("imp-offset-row");
    if (row) row.style.display = ev.target.checked ? "" : "none";
    recomputeCorridors();   // corridors appear/disappear → geometry change
    updateImpassableMeta();
    markImpassableDirty(true);
  });
  document.getElementById("imp-offset")?.addEventListener("change", () => {
    // Offset shifts corridor heights only (geometry unchanged) → no reprobe;
    // buildComputeGrid re-applies the offset to the cached corridor base/ramp.
    markImpassableDirty(false);
  });
  document.getElementById("imp-show")?.addEventListener("change", (ev) => {
    const row = document.getElementById("imp-opacity-row");
    if (row) row.style.display = ev.target.checked ? "" : "none";
    applyImpassableOverlay();
  });
  document.getElementById("imp-opacity")?.addEventListener("input", () => {
    if (state.impassableOverlay) state.impassableOverlay.setOpacity(impassableOverlayOpacity());
  });

  // --- Bridges & tunnels (group 1d) ---
  document.getElementById("bridge-osm")?.addEventListener("click", loadOsmBridges);
  document.getElementById("bridge-fgb")?.addEventListener("click", loadFgbBridges);
  document.getElementById("bridge-from-network")?.addEventListener("click", () => {
    const c = state.networkBridgeCandidates;
    if (!c || !c.length) { status.innerHTML = `<span style="color:#ff6b6b">${t("bridge.no_candidates")}</span>`; return; }
    const withTunnels = !!document.getElementById("bridge-tunnels")?.checked;
    const ways = withTunnels ? c : c.filter((w) => w.kind !== "tunnel");
    installBridgesFromWays(ways, "network");
  });
  document.getElementById("bridge-clear")?.addEventListener("click", clearBridges);
  document.getElementById("bridge-enabled")?.addEventListener("change", () => markBridgesDirty(true));
  document.getElementById("bridge-show")?.addEventListener("change", (ev) => {
    const row = document.getElementById("bridge-opacity-row");
    if (row) row.style.display = ev.target.checked ? "" : "none";
    applyBridgeOverlay();
  });
  document.getElementById("bridge-opacity")?.addEventListener("input", () => {
    // In-place opacity — don't rebuild every polyline on each slider tick.
    if (state.bridgesLayer) state.bridgesLayer.eachLayer((l) => l.setStyle({ opacity: bridgeOverlayOpacity() }));
  });
  // Switching the displayed energy field (constrained / unconstrained /
  // difference) re-renders cached arrays — never recomputes.
  document.getElementById("energy-source")?.addEventListener("change", () => {
    rerenderCachedResult();
    clearStyleDirty();
  });

  // Bundle download / reload
  const dlBtn = document.getElementById("download-bundle");
  if (dlBtn) dlBtn.addEventListener("click", downloadBundle);
  const exportImgBtn = document.getElementById("export-rendered");
  if (exportImgBtn) exportImgBtn.addEventListener("click", exportRenderedImages);
  const reloadInput = document.getElementById("bundle-file");
  if (reloadInput) {
    reloadInput.addEventListener("change", (ev) => {
      const f = ev.target.files[0];
      if (f) loadBundleFile(f);
      // Reset the input so the same filename re-triggers `change` if picked again.
      ev.target.value = "";
    });
  }

  // Group 0 input-dataset export/import. Exports are one-click; imports open a
  // hidden file input and route to the matching loader (same loaders the 1A–1D
  // groups use), so import accepts exactly what export produces.
  document.getElementById("export-dem")?.addEventListener("click", exportDemTif);
  document.getElementById("export-network")?.addEventListener("click", exportNetworkGpkg);
  document.getElementById("export-mask")?.addEventListener("click", exportMaskTif);
  document.getElementById("export-bridges")?.addEventListener("click", exportBridgesGpkg);
  const wireImport = (btnId, inputId, loader) => {
    document.getElementById(btnId)?.addEventListener("click", () => document.getElementById(inputId)?.click());
    document.getElementById(inputId)?.addEventListener("change", async (ev) => {
      const f = ev.target.files[0];
      ev.target.value = ""; // re-picking the same file fires change again
      if (!f) return;
      try { await loader(f); }
      catch (err) { console.error(err); status.innerHTML = `<span style="color:#ff6b6b">${escapeHtml(err.message)}</span>`; }
    });
  };
  wireImport("import-dem", "io-dem-file", async (f) => {
    const gen = ++state.demLoadGen;
    const buf = await f.arrayBuffer();
    if (gen !== state.demLoadGen) return; // a newer DEM load started while we were reading — last click wins
    state.demSourceUrl = null;
    await loadDemFromArrayBuffer(buf, f.name, gen);
  });
  wireImport("import-network", "io-network-file", (f) => loadVectorNetwork(f));
  wireImport("import-mask", "io-mask-file", (f) => loadImpassableMaskFromFile(f));
  wireImport("import-bridges", "io-bridges-file", (f) => importBridgesGpkg(f));

  // Reference-geometry GPX picker (triggered by the layer row's ↑ upload button).
  document.getElementById("refgeom-file")?.addEventListener("change", async (ev) => {
    const f = ev.target.files[0];
    ev.target.value = ""; // re-picking the same file fires change again
    if (f) await loadRefGeometry(f);
  });

  applyColormapToLegend();
  // Apply initial layer controls so the rmsampa-v2 tile layer (default ON)
  // gets added to the map without waiting for a Compute.
  applyLayerControls();

  // Help modal: open via the "?" button, close via × / backdrop click /
  // Escape key. Body scroll-lock isn't needed since the panel doesn't
  // scroll behind the modal.
  const helpBtn = document.getElementById("help-btn");
  const helpModal = document.getElementById("help-modal");
  const helpClose = document.getElementById("help-close");
  const openHelp  = () => helpModal?.classList.add("active");
  const closeHelp = () => helpModal?.classList.remove("active");
  helpBtn?.addEventListener("click", openHelp);
  helpClose?.addEventListener("click", closeHelp);
  helpModal?.addEventListener("click", (e) => {
    // Click on the backdrop (not on the modal body itself) closes.
    if (e.target === helpModal) closeHelp();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && helpModal?.classList.contains("active")) closeHelp();
  });

  // Help-modal changelog: CHANGELOG.md is the single source. Fetched and
  // rendered the first time the <details> opens (the blockquote under each
  // heading is the digest; lib/changelog.js returns it as escaped HTML with
  // only <strong>/<em>/<code>). Status lines use data-i18n(-html) so a
  // language switch re-translates them; the entries themselves are content.
  const changelogDetails = document.getElementById("changelog");
  const changelogList = document.getElementById("changelog-entries");
  let changelogState = "idle";   // idle → loading → done (failure → idle: retried on next open)
  changelogDetails?.addEventListener("toggle", async () => {
    if (!changelogDetails.open || !changelogList || changelogState !== "idle") return;
    changelogState = "loading";
    try {
      const res = await fetch("./CHANGELOG.md");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const entries = parseChangelog(await res.text());
      if (!entries.length) throw new Error("empty changelog");
      changelogList.innerHTML = entries.map((e) =>
        `<p><strong>${escapeHtml(e.version)}</strong> — ${escapeHtml(e.date)}<br/>${e.summaryHtml}</p>`,
      ).join("") + `<p data-i18n-html="help.changelog.full">${t("help.changelog.full")}</p>`;
      changelogState = "done";
    } catch (err) {
      console.warn("changelog load failed:", err);
      changelogList.innerHTML = `<p data-i18n-html="help.changelog.error">${t("help.changelog.error")}</p>`;
      changelogState = "idle";
    }
  });

  // Layer-stacking-order modal: list rendered top-of-screen-first, rows
  // moved with ↑/↓, applied immediately to the pane z-indices and
  // persisted. Rebuilt on every open so labels follow the language toggle.
  const orderModal = document.getElementById("layer-order-modal");
  const orderList = document.getElementById("layer-order-list");
  // Per-layer visibility/opacity input ids the modal rows PROXY (the real
  // inputs live in a hidden store, or in groups 1B/1C for network/impassable).
  // Every proxied input already has its own input+change listener that applies
  // the change, so the proxy just mirrors the value and dispatches those events.
  const LAYER_VIS = {
    relief:     { vis: "relief-visible",  op: "relief-opacity"  },
    impassable: { vis: "imp-show",        op: "imp-opacity"     },
    energy:     { vis: "energy-visible",  op: "energy-opacity"  },
    network:    { vis: "vec-render",      op: "vec-render-opacity" },
    passes:     { vis: "passes-visible",  op: "passes-opacity"  },
    refgeom:    { vis: "refgeom-visible", op: null, upload: true },
    routes:     { vis: null,              op: null              },
  };
  // Fixed (non-reorderable) layers shown after the stacking list.
  const FIXED_ROWS = [
    { labelKey: "layer.tiles",      vis: "tile-visible",   op: "tile-opacity" },
    { labelKey: "layer.bridges",    vis: "bridge-show",    op: "bridge-opacity" },
    { labelKey: "ref.show_markers", vis: "refs-visible",   op: null },
  ];
  const fireInput = (el) => {
    el.dispatchEvent(new Event("input",  { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const buildLayerRow = ({ labelKey, reorder, vis, op, upload }) => {
    const row = document.createElement("div");
    row.style.cssText =
      "display:flex;align-items:center;gap:6px;padding:4px 6px;" +
      "border:1px solid var(--border);border-radius:4px;margin-top:4px;";
    // Ordering arrows on the LEFT (or a same-width spacer for fixed rows).
    const arrows = document.createElement("div");
    arrows.style.cssText = "display:flex;gap:2px;flex:none;width:50px;";
    if (reorder) {
      const mkBtn = (label, disabled, delta) => {
        const b = document.createElement("button");
        b.type = "button"; b.className = "secondary"; b.textContent = label;
        b.disabled = disabled; b.style.cssText = "width:24px;height:24px;padding:2px 0;margin:0;";
        b.setAttribute("aria-label", t(delta > 0 ? "order.move_up" : "order.move_down") + " — " + t(labelKey));
        b.addEventListener("click", () => {
          // Visually "up" = drawn on top = later in the bottom→top layerOrder.
          const i = layerOrder.indexOf(reorder.key);
          const j = i + delta;
          if (j < 0 || j >= layerOrder.length) return;
          [layerOrder[i], layerOrder[j]] = [layerOrder[j], layerOrder[i]];
          applyLayerOrder();
          renderOrderList();
        });
        return b;
      };
      arrows.appendChild(mkBtn("↑", reorder.di === 0, +1));
      arrows.appendChild(mkBtn("↓", reorder.di === reorder.last, -1));
    }
    row.appendChild(arrows);
    // Visibility checkbox (proxies the real input).
    const realVis = vis ? document.getElementById(vis) : null;
    if (realVis) {
      const cb = document.createElement("input");
      cb.type = "checkbox"; cb.style.flex = "none"; cb.setAttribute("aria-label", t(labelKey));
      cb.checked = realVis.checked;
      cb.addEventListener("change", () => { realVis.checked = cb.checked; fireInput(realVis); });
      row.appendChild(cb);
    } else {
      const sp = document.createElement("span"); sp.style.cssText = "width:13px;flex:none;";
      row.appendChild(sp);
    }
    // Name.
    const name = document.createElement("span");
    name.style.cssText = "flex:1;font-size:12px;"; name.textContent = t(labelKey);
    row.appendChild(name);
    // Opacity slider (proxies the real input).
    const realOp = op ? document.getElementById(op) : null;
    if (realOp) {
      const r = document.createElement("input");
      r.type = "range"; r.min = "0"; r.max = "1"; r.step = "0.05"; r.value = realOp.value;
      r.setAttribute("aria-label", t(labelKey) + " — " + t("layer.opacity"));
      r.style.cssText = "flex:none;width:64px;";
      r.addEventListener("input", () => { realOp.value = r.value; fireInput(realOp); });
      row.appendChild(r);
    }
    // Upload control (↑) in place of the opacity slider — used by the
    // reference-geometry layer to load a GPX track.
    if (upload) {
      const up = document.createElement("button");
      up.type = "button"; up.className = "secondary"; up.textContent = "↑";
      up.title = t("refgeom.upload"); up.setAttribute("aria-label", t("refgeom.upload"));
      up.style.cssText = "width:24px;height:24px;padding:2px 0;margin:0;flex:none;";
      up.addEventListener("click", () => document.getElementById("refgeom-file")?.click());
      row.appendChild(up);
    }
    return row;
  };
  const renderOrderList = () => {
    if (!orderList) return;
    orderList.innerHTML = "";
    const topToBottom = layerOrder.slice().reverse();
    topToBottom.forEach((key, di) => {
      const v = LAYER_VIS[key] || {};
      orderList.appendChild(buildLayerRow({
        labelKey: `order.${key}`,
        reorder: { key, di, last: topToBottom.length - 1 },
        vis: v.vis, op: v.op, upload: v.upload,
      }));
    });
    FIXED_ROWS.forEach((f) => orderList.appendChild(buildLayerRow({
      labelKey: f.labelKey, reorder: null, vis: f.vis, op: f.op,
    })));
  };
  // Expose to the module scope so setLang() can rebuild the panel in place
  // when it's left open across a language toggle.
  setRefreshLayerOrderList(renderOrderList);
  const layerCtrlBtns = ["layer-ctrl-open", "layer-ctrl-btn"]
    .map((id) => document.getElementById(id)).filter(Boolean);
  const markLayerBtns = (on) => layerCtrlBtns.forEach((b) => b.classList.toggle("active", on));
  const openOrder = () => { renderOrderList(); orderModal?.classList.add("active"); markLayerBtns(true); };
  const closeOrder = () => { orderModal?.classList.remove("active"); markLayerBtns(false); };
  // Non-blocking corner panel: the buttons TOGGLE it (re-click to dismiss).
  const toggleOrder = () => orderModal?.classList.contains("active") ? closeOrder() : openOrder();
  layerCtrlBtns.forEach((b) => b.addEventListener("click", toggleOrder));
  document.getElementById("layer-order-close")?.addEventListener("click", closeOrder);
  orderModal?.addEventListener("click", (e) => {
    if (e.target === orderModal) closeOrder();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && orderModal?.classList.contains("active")) closeOrder();
  });
  document.getElementById("layer-order-reset")?.addEventListener("click", () => {
    setLayerOrder(DEFAULT_LAYER_ORDER.slice());
    applyLayerOrder();
    renderOrderList();
  });

  // Restore saved parameter/viz choices and start persisting future edits.
  // Last so the colormap selects are populated and every sub-panel sync
  // handler is already wired (restore dispatches synthetic change events).
  setupParamPersistence();
  setupConfigButtons();
  setupDrawingTools();
});
