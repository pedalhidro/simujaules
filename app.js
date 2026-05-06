// app.js — wires up DEM loading, map UI, worker dispatch, result overlay.

// ------- Wasm engine probe -------
// At startup we try to construct the wasm worker once. If it sends back
// `ready`, every Compute will use the wasm worker. If it fails (browser
// doesn't support module workers, wasm/pkg/ wasn't built, etc.) we fall
// back to the JS worker. Probe result is cached for the session.
const WASM_WORKER_URL = "./energy-worker-wasm.js";
const JS_WORKER_URL = "./energy-worker.js";
const wasmAvailable = probeWasmEngine();

function probeWasmEngine() {
  return new Promise((resolve) => {
    let w;
    try {
      w = new Worker(WASM_WORKER_URL, { type: "module" });
    } catch (e) {
      console.info("[engine] wasm worker unavailable (constructor):", e?.message ?? e);
      resolve(false);
      return;
    }
    const timeout = setTimeout(() => {
      console.info("[engine] wasm probe timed out — falling back to JS");
      try { w.terminate(); } catch {}
      resolve(false);
    }, 4000);
    w.onmessage = (ev) => {
      const m = ev.data || {};
      if (m.kind === "ready") {
        clearTimeout(timeout);
        try { w.terminate(); } catch {}
        console.info("[engine] wasm worker ready");
        resolve(true);
      } else if (m.kind === "wasm_failed") {
        clearTimeout(timeout);
        try { w.terminate(); } catch {}
        console.info("[engine] wasm load failed:", m.reason);
        resolve(false);
      }
    };
    w.onerror = (e) => {
      clearTimeout(timeout);
      try { w.terminate(); } catch {}
      console.info("[engine] wasm worker errored during probe:", e?.message ?? e);
      resolve(false);
    };
  });
}

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
  });
}
function markStyleDirty() {
  // Skip if nothing actually changed since the last render — guards
  // against late blur/change events re-marking after a refresh click.
  if (state.lastStyleSnapshot === styleSnapshot()) return;
  const btn = document.getElementById("refresh-style");
  if (btn) {
    btn.dataset.dirty = "1";
    btn.textContent = "Refresh style ●";
  }
}
function clearStyleDirty() {
  state.lastStyleSnapshot = styleSnapshot();
  const btn = document.getElementById("refresh-style");
  if (btn) {
    btn.dataset.dirty = "";
    btn.textContent = "Refresh style";
  }
}

// Surface engine choice in the UI once the probe resolves.
wasmAvailable.then((ok) => {
  const el = document.getElementById("engine-tag");
  if (el) el.textContent = ok ? "wasm" : "js";
  state.engine = ok ? "wasm" : "js";
  estimateRunTime();
});

// Wire the colormap selector and the manual range inputs. Any change
// re-renders the cached energy field — no recompute needed.
document.addEventListener("DOMContentLoaded", () => {
  // Populate the colormap dropdown with all CET maps, grouped by class.
  const sel = document.getElementById("colormap");
  if (sel) {
    sel.innerHTML = "";
    for (const grp of COLORCET_GROUPS) {
      const og = document.createElement("optgroup");
      og.label = grp.label;
      for (const k of grp.keys) {
        if (!COLORMAPS[k]) continue;
        const opt = document.createElement("option");
        opt.value = k;
        opt.textContent = k.replace("CET_", "CET-");
        og.appendChild(opt);
      }
      sel.appendChild(og);
    }
    sel.value = activeColormap;
    // Live-update the swatch (cheap CSS) but DEFER the canvas re-render to
    // the explicit Refresh-style button — re-rendering on every keystroke
    // gets laggy on large DEMs.
    sel.addEventListener("change", () => {
      activeColormap = sel.value;
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
    "tile-visible", "tile-opacity",
    "energy-visible", "energy-opacity",
    "passes-visible", "passes-opacity",
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
    routesSel.innerHTML = "";
    for (const grp of COLORCET_GROUPS) {
      const og = document.createElement("optgroup");
      og.label = grp.label;
      for (const k of grp.keys) {
        if (!COLORMAPS[k]) continue;
        const opt = document.createElement("option");
        opt.value = k;
        opt.textContent = k.replace("CET_", "CET-");
        og.appendChild(opt);
      }
      routesSel.appendChild(og);
    }
    routesSel.value = "CET_R2"; // perceptually uniform rainbow — good for ranks
    routesSel.addEventListener("change", rerenderCachedResult);
  }
  // Top-N toggle reveals N + penalty + repulsion inputs
  const topnCheck = document.getElementById("want-topn");
  const topnExtra = document.getElementById("topn-extra");
  if (topnCheck && topnExtra) {
    const sync = () => { topnExtra.style.display = topnCheck.checked ? "" : "none"; estimateRunTime(); };
    topnCheck.addEventListener("change", sync);
    sync();
  }
  // Density toggle reveals the multi-ref controls and locks out the
  // single-source toggles (wantPasses / wantTopN) that don't compose
  // with multi-reference density.
  const densCheck = document.getElementById("want-density");
  const densExtra = document.getElementById("density-extra");
  if (densCheck && densExtra) {
    const sync = () => {
      const on = densCheck.checked;
      densExtra.style.display = on ? "" : "none";

      const passesCheck = document.getElementById("want-passes");
      const passesLabel = passesCheck?.closest("label");
      if (passesCheck) {
        if (on) { passesCheck.checked = false; passesCheck.disabled = true; }
        else passesCheck.disabled = false;
      }
      if (passesLabel) passesLabel.style.opacity = on ? "0.5" : "1";

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
      // Also fade the "Pick points" group so it's clearly inactive.
      const pickGroup = document.getElementById("pick-points-group");
      if (pickGroup) {
        pickGroup.style.opacity = on ? "0.45" : "1";
        pickGroup.style.pointerEvents = on ? "none" : "";
      }
      if (on) {
        state.src = null;
        state.dst = null;
        if (state.srcMarker) { state.srcMarker.remove(); state.srcMarker = null; }
        if (state.dstMarker) { state.dstMarker.remove(); state.dstMarker = null; }
        if (state.pathLine)  { state.pathLine.remove();  state.pathLine = null; }
        const srcDisp = document.getElementById("src-display");
        const dstDisp = document.getElementById("dst-display");
        if (srcDisp) { srcDisp.textContent = "— disabled in density mode —"; srcDisp.classList.remove("set"); }
        if (dstDisp) { dstDisp.textContent = "— disabled in density mode —"; dstDisp.classList.remove("set"); }
      } else {
        const srcDisp = document.getElementById("src-display");
        const dstDisp = document.getElementById("dst-display");
        if (srcDisp && !state.src) srcDisp.textContent = "— click map to set —";
        if (dstDisp && !state.dst) dstDisp.textContent = "— click again to set —";
      }

      // Hide and DISABLE the energy layer controls in density mode — the
      // user wants only the density (passes) view. The renderer also
      // skips applying the energy overlay when density is on, so toggling
      // density off later restores both control and rendering.
      const eVis = document.getElementById("energy-visible");
      const eOp  = document.getElementById("energy-opacity");
      const eBlock = eVis?.closest(".layer-block");
      if (eVis) eVis.disabled = on;
      if (eOp)  eOp.disabled  = on;
      if (eBlock) {
        eBlock.style.opacity = on ? "0.45" : "1";
        eBlock.style.pointerEvents = on ? "none" : "";
      }
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
  document.getElementById("ref-clear")?.addEventListener("click", clearRefPoints);
  // Anything that affects the time estimate
  for (const id of ["mode", "want-passes", "want-topn", "n-routes", "want-density", "n-refs", "e-max"]) {
    const el = document.getElementById(id);
    if (el) el.addEventListener("change", estimateRunTime);
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
  // Bundle download / reload
  const dlBtn = document.getElementById("download-bundle");
  if (dlBtn) dlBtn.addEventListener("click", downloadBundle);
  const reloadInput = document.getElementById("bundle-file");
  if (reloadInput) {
    reloadInput.addEventListener("change", (ev) => {
      const f = ev.target.files[0];
      if (f) loadBundleFile(f);
      // Reset the input so the same filename re-triggers `change` if picked again.
      ev.target.value = "";
    });
  }
  applyColormapToLegend();
  // Apply initial layer controls so the rmsampa-v2 tile layer (default ON)
  // gets added to the map without waiting for a Compute.
  applyLayerControls();
});

const map = L.map("map", { preferCanvas: true }).setView([-23.55, -46.63], 12);
L.tileLayer(
  "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
  {
    attribution: "© OpenStreetMap contributors",
    maxZoom: 19,
  }
).addTo(map);

// ------- State -------
const state = {
  dem: null, // { height, mask, H, W, dx, dy, bbox, originX, originY }
  src: null, // [r, c]
  dst: null, // [r, c]
  worker: null,
  // Stacked overlays — z-order from bottom up:
  //   OSM basemap → tileOverlay (rmsampa-v2) → energyOverlay → passesOverlay
  tileOverlay: null,
  energyOverlay: null,
  passesOverlay: null,
  pathLine: null,
  routeLines: [],
  srcMarker: null,
  dstMarker: null,
  // Optional XYZ tile overlay (rmsampa-v2). Initialised below.
  tileOverlayActive: false,
  // Outline rectangle drawn to show the loaded DEM's extent.
  demRect: null,
  // Multi-reference density: list of [r, c] pixel coords plus their map markers.
  refPoints: [],
  refMarkers: [],
  // Live-ETA bookkeeping (set on Compute, cleared on done/error).
  computeStartedAt: 0,
  estimatedTotalMs: 0,
  etaTimer: 0,
};

// ------- DEM loading -------
const demFile = document.getElementById("dem-file");
const demMeta = document.getElementById("dem-meta");
const status = document.getElementById("status");
const runBtn = document.getElementById("run");
const progress = document.getElementById("progress");
const progressBar = progress.querySelector(".bar");
const resultMeta = document.getElementById("result-meta");

// Construct the rmsampa-v2 XYZ tile layer once. Add/remove on visibility
// toggle so we don't pay tile fetches when it's hidden.
const RMSAMPA_URL = "https://telhas.pedalhidrografi.co/rmsampa-v2/{z}/{x}/{y}.png";
state.tileOverlay = L.tileLayer(RMSAMPA_URL, {
  maxZoom: 19,
  opacity: 0.85,
  attribution: 'pedalhidrografi.co',
});

demFile.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  status.textContent = "Loading DEM…";
  try {
    const buf = await file.arrayBuffer();
    state.demSourceUrl = null;
    await loadDemFromArrayBuffer(buf, file.name);
  } catch (err) {
    console.error(err);
    status.innerHTML = `<span style="color:#ff6b6b">Error: ${err.message}</span>`;
  }
});

// Three example DEMs hosted alongside the rmsampa-v2 tiles. Wired below.
const DEM_EXAMPLES = [
  { id: "ex-aguapreta", label: "Entorno da Água Preta", size: "instantâneo",
    url: "https://telhas.pedalhidrografi.co/simujoules/dem/sampa_aguapreta.tif" },
  { id: "ex-centro",    label: "Sampa Centro Expandido", size: "rápido",
    url: "https://telhas.pedalhidrografi.co/simujoules/dem/sampa_centro.tif" },
  { id: "ex-geral",     label: "Sampa Sítio Urbano",    size: "lento",
    url: "https://telhas.pedalhidrografi.co/simujoules/dem/sampa_geral.tif" },
];

async function loadDemFromUrl(url, label) {
  status.textContent = `Fetching ${label}…`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
    const buf = await resp.arrayBuffer();
    state.demSourceUrl = url;
    await loadDemFromArrayBuffer(buf, label);
  } catch (err) {
    console.error(err);
    status.innerHTML = `<span style="color:#ff6b6b">Error: ${err.message}</span>`;
  }
}

async function loadDemFromArrayBuffer(buf, label) {
  status.textContent = `Loading ${label}…`;
  const tiff = await GeoTIFF.fromArrayBuffer(buf);
  const image = await tiff.getImage();
  const W = image.getWidth();
  const H = image.getHeight();
  const tiePoints = image.getTiePoints();
  const fileDirectory = image.fileDirectory;
  const pixelScale = fileDirectory.ModelPixelScale;
  if (!pixelScale || !tiePoints?.length) {
    throw new Error("DEM lacks geotransform metadata. Use a properly georeferenced GeoTIFF.");
  }
  const dx = pixelScale[0];
  const dy = pixelScale[1];
  const originX = tiePoints[0].x;
  const originY = tiePoints[0].y;

  // Read elevation as Float32Array
  const raster = await image.readRasters({ interleave: true });
  const height = raster instanceof Float32Array ? raster : Float32Array.from(raster);

  // Build mask: anything finite and != nodata
  const nodata = fileDirectory.GDAL_NODATA ? parseFloat(fileDirectory.GDAL_NODATA) : null;
  const mask = new Uint8Array(H * W);
  for (let i = 0; i < H * W; i++) {
    const v = height[i];
    mask[i] = (Number.isFinite(v) && (nodata === null || v !== nodata)) ? 1 : 0;
  }

  // Detect CRS — for this prototype we assume the DEM is in a projected
  // metric CRS where x = easting, y = northing increasing northward.
  // Geographic (lon/lat) DEMs need reprojection that we skip here for clarity.
  // Most real-world cycling DEMs are UTM, which works.
  const isProbablyGeographic =
    Math.abs(originX) < 360 && Math.abs(originY) < 90 && dx < 0.01;
  if (isProbablyGeographic) {
    status.innerHTML = '<span style="opacity:0.7">DEM is in lon/lat — distances approximated from latitude (good to ~0.3% under ~50 km extent).</span>';
  }

  // Convert degrees → metres for geographic DEMs using a flat-earth
  // approximation centred on the DEM's middle latitude. For a 5–50 km
  // extent this is good to ~0.3%.
  const latRef = isProbablyGeographic ? originY - (H * dy) / 2 : 0;
  const dxM = isProbablyGeographic
    ? dx * 111320 * Math.cos((latRef * Math.PI) / 180)
    : dx;
  const dyM = isProbablyGeographic ? dy * 110574 : dy;

  state.dem = {
    height, mask, H, W,
    dx, dy,                  // native CRS units (degrees for geographic)
    dxM, dyM,                // always metres — fed to the worker
    originX, originY,
    // bbox in DEM CRS units (degrees for geographic):
    bbox: { xmin: originX, ymin: originY - H * dy, xmax: originX + W * dx, ymax: originY },
    isGeographic: isProbablyGeographic,
  };
  state.demLabel = label;

  // Draw a rectangle around the DEM extent (so the user sees what cells
  // they're working with) and pan/zoom the map to fit.
  if (state.demRect) { state.demRect.remove(); state.demRect = null; }
  if (isProbablyGeographic) {
    const south = originY - H * dy;
    const north = originY;
    const west = originX;
    const east = originX + W * dx;
    const bounds = [[south, west], [north, east]];
    state.demRect = L.rectangle(bounds, {
      color: "#ff8c42",
      weight: 1.5,
      fillOpacity: 0,
      dashArray: "4 3",
      interactive: false,
    }).addTo(map);
    map.fitBounds(bounds, { padding: [20, 20], maxZoom: 16 });
  }

  // Clear any prior energy / passes overlay + clicked points so we don't
  // leave stale visuals from the previous DEM hanging around.
  if (state.energyOverlay) { state.energyOverlay.remove(); state.energyOverlay = null; }
  if (state.passesOverlay) { state.passesOverlay.remove(); state.passesOverlay = null; }
  if (state.pathLine)      { state.pathLine.remove();      state.pathLine = null; }
  if (state.routeLines)    { for (const ln of state.routeLines) ln.remove(); state.routeLines = []; }
  if (state.srcMarker)     { state.srcMarker.remove();     state.srcMarker = null; }
  if (state.dstMarker)     { state.dstMarker.remove();     state.dstMarker = null; }
  if (state.refMarkers && state.refMarkers.length) {
    for (const m of state.refMarkers) m.remove();
  }
  state.refMarkers = [];
  state.refPoints = [];
  state.src = null;
  state.dst = null;
  state.lastResult = null;
  syncRefDisplay();
  document.getElementById("src-display").textContent = "— click map to set —";
  document.getElementById("dst-display").textContent = "— click again to set —";
  document.getElementById("src-display").classList.remove("set");
  document.getElementById("dst-display").classList.remove("set");
  resultMeta.innerHTML = "—";

  // Display metadata. For geographic DEMs (EPSG:4326), dx/dy are in
  // degrees and need to be converted to metres for cell-size and coverage
  // figures. We use a flat-earth approximation good to ~0.3% at typical
  // cycling-region scales.
  const cellLabel = formatCellSize(dx, dy, originY, H, isProbablyGeographic);
  const coverLabel = formatCoverage(W, H, dx, dy, originY, isProbablyGeographic);
  const originLabel = isProbablyGeographic
    ? `${originX.toFixed(4)}°, ${originY.toFixed(4)}°`
    : `${originX.toFixed(1)}, ${originY.toFixed(1)}`;
  demMeta.innerHTML = `
    <span class="v">${W} × ${H}</span> cells, cell ${cellLabel}<br/>
    origin <span class="v">${originLabel}</span><br/>
    ${coverLabel}
  `;
  status.textContent = `${label} loaded. Click on the map to set source point.`;
  updateRunButtonState();
  estimateRunTime();
}

// ------- Map clicks: set points -------
// Convert lat/lon to DEM pixel coords. For a UTM DEM this needs proj4; for
// the prototype we accept WGS84 DEMs OR provide a small UTM helper.
// The cleanest demo path is to show the DEM extent on the map in its native
// units. To keep dependencies minimal, the prototype assumes DEMs in EPSG:4326.
// Production: pull in proj4 and parse the GeoKeys to get the source CRS.

function latLngToPixel(latlng) {
  if (!state.dem) return null;
  const { originX, originY, dx, dy, W, H, isGeographic } = state.dem;
  // For a geographic DEM (lon = x, lat = y):
  if (isGeographic) {
    const col = Math.floor((latlng.lng - originX) / dx);
    const row = Math.floor((originY - latlng.lat) / dy);
    if (row < 0 || row >= H || col < 0 || col >= W) return null;
    return [row, col];
  }
  // For UTM DEMs we'd need proj4 here. As a fallback, treat the click
  // as if it were in the DEM's native units (only useful for testing
  // against a small DEM you've manually situated).
  return null;
}

function pixelToLatLng(r, c) {
  if (!state.dem) return null;
  const { originX, originY, dx, dy, isGeographic } = state.dem;
  if (isGeographic) {
    return L.latLng(originY - (r + 0.5) * dy, originX + (c + 0.5) * dx);
  }
  return null;
}

map.on("click", (e) => {
  if (!state.dem) {
    status.textContent = "Load a DEM first.";
    return;
  }
  const px = latLngToPixel(e.latlng);
  if (!px) {
    status.innerHTML = '<span style="color:#ff6b6b">Click is outside the DEM, or DEM is in a non-geographic CRS (this prototype supports EPSG:4326 DEMs only — see notes).</span>';
    return;
  }
  const [r, c] = px;
  if (!state.dem.mask[r * state.dem.W + c]) {
    status.textContent = "Clicked cell is nodata.";
    return;
  }
  // Density mode in "click" placement: every click adds a reference point.
  // src/dst are left alone in this mode.
  const densityOn = !!document.getElementById("want-density")?.checked;
  const densityClick = (document.getElementById("ref-source")?.value || "click") === "click";
  if (densityOn && densityClick) {
    addRefPoint([r, c]);
    return;
  }
  if (!state.src) {
    state.src = px;
    if (state.srcMarker) state.srcMarker.remove();
    state.srcMarker = L.marker(e.latlng, { icon: makeSrcDstIcon("src") })
      .addTo(map).bindTooltip("Source");
    document.getElementById("src-display").textContent = `r=${r}, c=${c}`;
    document.getElementById("src-display").classList.add("set");
    status.textContent = "Source set. Click again to set destination, or run.";
    updateRunButtonState();
  } else if (!state.dst) {
    state.dst = px;
    if (state.dstMarker) state.dstMarker.remove();
    state.dstMarker = L.marker(e.latlng, { icon: makeSrcDstIcon("dst") })
      .addTo(map).bindTooltip("Destination");
    document.getElementById("dst-display").textContent = `r=${r}, c=${c}`;
    document.getElementById("dst-display").classList.add("set");
    status.textContent = "Both points set. Run to compute.";
  } else {
    // Reset and start over
    state.src = px;
    state.dst = null;
    if (state.srcMarker) state.srcMarker.remove();
    if (state.dstMarker) state.dstMarker.remove();
    state.srcMarker = L.marker(e.latlng, { icon: makeSrcDstIcon("src") })
      .addTo(map).bindTooltip("Source");
    state.dstMarker = null;
    document.getElementById("src-display").textContent = `r=${r}, c=${c}`;
    document.getElementById("dst-display").textContent = "— click again to set —";
    document.getElementById("dst-display").classList.remove("set");
    status.textContent = "Source replaced. Click to set destination, or run.";
  }
});

document.getElementById("clear-points").addEventListener("click", () => {
  state.src = null;
  state.dst = null;
  if (state.srcMarker) { state.srcMarker.remove(); state.srcMarker = null; }
  if (state.dstMarker) { state.dstMarker.remove(); state.dstMarker = null; }
  if (state.pathLine) { state.pathLine.remove(); state.pathLine = null; }
  document.getElementById("src-display").textContent = "— click map to set —";
  document.getElementById("dst-display").textContent = "— click again to set —";
  document.getElementById("src-display").classList.remove("set");
  document.getElementById("dst-display").classList.remove("set");
  updateRunButtonState();
});

// ------- Marker icons -------
// Source / destination / reference points all share a white-disc-with-
// black-border style. Tiny label text inside (`src` / `dst` / a 1-based
// order number for refs).
function makeLabelIcon(label, size, fontSize) {
  const html = `<div style="
    width:${size}px;height:${size}px;
    background:#fff;border:2px solid #000;border-radius:50%;
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
const makeSrcDstIcon = (label) => makeLabelIcon(label, ICON_SRCDST_SIZE, ICON_SRCDST_FONT);
const makeRefIcon    = (idx)   => makeLabelIcon(String(idx), ICON_REF_SIZE, ICON_REF_FONT);

// ------- Multi-reference density helpers -------
// FIFO buffer: state.refPoints / state.refMarkers are kept in arrival order.
// Once the population exceeds the `N references` cap, the oldest entries are
// dropped from the front. Applies to single clicks AND to "Place random".
function addRefPoint(rc) {
  if (!state.dem) return;
  const [r, c] = rc;
  if (!state.dem.mask[r * state.dem.W + c]) return;
  state.refPoints.push([r, c]);
  const { originX, originY, dx, dy } = state.dem;
  const latlng = L.latLng(originY - (r + 0.5) * dy, originX + (c + 0.5) * dx);
  const idx = state.refPoints.length;
  const m = L.marker(latlng, { icon: makeRefIcon(idx) })
    .addTo(map).bindTooltip(`ref ${idx} · r=${r}, c=${c}`);
  state.refMarkers.push(m);
  enforceRefCap();
  syncRefDisplay();
}

function enforceRefCap() {
  const cap = Math.max(1, parseInt(document.getElementById("n-refs")?.value, 10) || 10);
  while (state.refPoints.length > cap) {
    state.refPoints.shift();
    const oldest = state.refMarkers.shift();
    if (oldest) oldest.remove();
  }
  // After a FIFO trim the surviving refs need their numbered icons
  // refreshed so what's drawn matches the (now reset) order.
  for (let i = 0; i < state.refMarkers.length; i++) {
    const marker = state.refMarkers[i];
    const [r, c] = state.refPoints[i];
    marker.setIcon(makeRefIcon(i + 1));
    marker.unbindTooltip().bindTooltip(`ref ${i + 1} · r=${r}, c=${c}`);
  }
}

function clearRefPoints() {
  for (const m of state.refMarkers) m.remove();
  state.refMarkers = [];
  state.refPoints = [];
  syncRefDisplay();
}

function placeRandomRefPoints(n) {
  if (!state.dem) return;
  const { mask, H, W } = state.dem;
  // Reservoir of valid cell indices is too big to enumerate for huge DEMs;
  // rejection sampling is fine for typical mask densities (~99% valid).
  const want = Math.max(1, Math.min(2000, n | 0));
  let attempts = 0;
  const cap = want * 200;
  const placed = [];
  while (placed.length < want && attempts++ < cap) {
    const r = (Math.random() * H) | 0;
    const c = (Math.random() * W) | 0;
    if (mask[r * W + c]) placed.push([r, c]);
  }
  for (const rc of placed) addRefPoint(rc);
}

function syncRefDisplay() {
  const el = document.getElementById("ref-display");
  if (el) el.textContent = state.refPoints.length
    ? `${state.refPoints.length} reference${state.refPoints.length === 1 ? "" : "s"} placed`
    : "no references placed";
  updateRunButtonState();
  estimateRunTime();
}

// Unified gate for the Compute button. In density mode it unlocks once at
// least one reference point exists; otherwise it follows the src/dst rules.
function updateRunButtonState() {
  if (!state.dem) { runBtn.disabled = true; return; }
  const densityOn = !!document.getElementById("want-density")?.checked;
  if (densityOn) {
    runBtn.disabled = !(state.refPoints && state.refPoints.length > 0);
  } else {
    runBtn.disabled = !state.src;
  }
}

// ------- Run -------
runBtn.addEventListener("click", async () => {
  const wantDensity = !!document.getElementById("want-density")?.checked;
  // Density mode runs from refPoints, not src — relax the src-required guard.
  if (!state.dem) return;
  if (!wantDensity && !state.src) return;
  if (wantDensity && (!state.refPoints || state.refPoints.length === 0)) {
    status.innerHTML = '<span style="color:#ff6b6b">Density mode needs at least one reference point — click on the map or use "Place random".</span>';
    return;
  }

  const mode = document.getElementById("mode").value;
  const alpha = parseFloat(document.getElementById("alpha").value);
  const beta = parseFloat(document.getElementById("beta").value);
  const eta = parseFloat(document.getElementById("eta").value);
  const eMaxRaw = parseFloat(document.getElementById("e-max")?.value);
  const eMax = Number.isFinite(eMaxRaw) && eMaxRaw > 0 ? eMaxRaw : 0;

  // Optional extras (default off — energy-only is the fast path)
  const wantPasses = !!document.getElementById("want-passes")?.checked;
  const wantTopN   = !!document.getElementById("want-topn")?.checked;
  const nRoutes    = Math.max(1, Math.min(20, parseInt(document.getElementById("n-routes")?.value, 10) || 3));
  const penalty    = Math.max(0, parseFloat(document.getElementById("penalty")?.value) || 2.0);
  const repulsionMode = document.getElementById("repulsion-mode")?.value || "per-cell";
  // Density follows the global Mode select instead of having its own
  // direction toggle.
  const densityMode  = mode;

  if (wantTopN && !state.dst) {
    status.innerHTML = '<span style="color:#ff6b6b">Top-N routes requires a destination point.</span>';
    return;
  }

  // Tear down old worker if any (we can't re-use after transferred buffers)
  if (state.worker) state.worker.terminate();

  // Wasm worker doesn't yet implement passes / top-N / density / budget.
  // Force JS for those; the energy-only fast path still uses wasm.
  const wasmOk = await wasmAvailable;
  const useWasm = wasmOk && !wantPasses && !wantTopN && !wantDensity && eMax === 0;
  state.worker = useWasm
    ? new Worker(WASM_WORKER_URL, { type: "module" })
    : new Worker(JS_WORKER_URL);
  state.engine = useWasm ? "wasm" : "js";

  status.textContent = "Computing…";
  progress.classList.add("active");
  progressBar.style.width = "0%";
  runBtn.disabled = true;

  // ETA bookkeeping. The wasm worker doesn't emit progress messages; for
  // it we just show "Computing…" and the static estimate. The JS worker
  // emits progress every ~N/50 cells, which gives a usable ETA after the
  // first few percent.
  state.computeStartedAt = performance.now();
  state.estimatedTotalMs = 0;
  // Cache density's expected ref count so the progress text reads
  // "ref X/N" while the worker is iterating.
  state.computeRefTotal = wantDensity ? state.refPoints.length : 0;

  state.worker.onmessage = (ev) => {
    const m = ev.data;
    if (m.kind === "progress") {
      const pct = Math.min(100, m.progress * 100);
      progressBar.style.width = `${pct.toFixed(1)}%`;
      // Live ETA: linear extrapolation. Skip the noisy first 5% of the run.
      if (m.progress > 0.05) {
        const elapsed = performance.now() - state.computeStartedAt;
        const total = elapsed / m.progress;
        const remaining = Math.max(0, total - elapsed);
        let label;
        if (state.computeRefTotal > 0) {
          // Density: progress fraction is (k+1)/N_refs after each ref.
          const cur = Math.max(1, Math.min(state.computeRefTotal, Math.ceil(m.progress * state.computeRefTotal)));
          label = `Computing density: ref ${cur}/${state.computeRefTotal} (${pct.toFixed(0)}%)`;
        } else {
          label = `Computing… ${pct.toFixed(0)}%`;
        }
        status.textContent = `${label} — ${formatDuration(remaining)} left`;
      }
    } else if (m.kind === "done") {
      progress.classList.remove("active");
      updateRunButtonState();
      state.computeStartedAt = 0;
      renderResult(m);
      status.textContent = `Done in ${m.elapsedMs.toFixed(0)} ms (${state.engine}).`;
    } else if (m.kind === "error") {
      progress.classList.remove("active");
      updateRunButtonState();
      state.computeStartedAt = 0;
      status.innerHTML = `<span style="color:#ff6b6b">Worker error: ${m.message}</span>`;
    }
  };

  // Transfer the DEM to the worker (clone, since we need to keep our copy).
  // For very large DEMs you'd transfer ownership and re-load on each run.
  const heightCopy = new Float32Array(state.dem.height);
  const maskCopy = new Uint8Array(state.dem.mask);

  state.worker.postMessage(
    {
      kind: "run",
      height: heightCopy,
      mask: maskCopy,
      H: state.dem.H,
      W: state.dem.W,
      dx: state.dem.dxM,
      dy: state.dem.dyM,
      seedR: state.src ? state.src[0] : (state.refPoints[0] ? state.refPoints[0][0] : -1),
      seedC: state.src ? state.src[1] : (state.refPoints[0] ? state.refPoints[0][1] : -1),
      goalR: state.dst ? state.dst[0] : -1,
      goalC: state.dst ? state.dst[1] : -1,
      mode, alpha, beta, eta, eMax,
      wantPasses, wantTopN, nRoutes, penalty, repulsionMode,
      wantDensity,
      refPoints: wantDensity ? state.refPoints.slice() : null,
      densityMode,
    },
    [heightCopy.buffer, maskCopy.buffer]
  );
});

// ------- Render -------
function renderResult({ energy, passes, path, pathEnergy, pathLengthM, routes, elapsedMs }) {
  // Cache for live re-render on colormap / view / range changes.
  state.lastResult = { energy, passes, path, pathEnergy, pathLengthM, routes, elapsedMs };

  // Compute energy auto range (one pass) — skip if energy is null (a
  // density-only run could omit it, though the worker currently always
  // returns the first ref's energy field).
  let autoMin = Infinity, autoMax = 0;
  if (energy) {
    for (let i = 0; i < energy.length; i++) {
      const v = energy[i];
      if (Number.isFinite(v)) {
        if (v < autoMin) autoMin = v;
        if (v > autoMax) autoMax = v;
      }
    }
  }
  if (!Number.isFinite(autoMin)) autoMin = 0;
  if (autoMax <= autoMin) autoMax = autoMin + 1;
  state.lastAutoMin = autoMin;
  state.lastAutoMax = autoMax;

  // Compute passes auto range over settled (non-zero) cells. Passes counts
  // are integer-valued and long-tailed; auto + sqrt stretch in the renderer
  // handles the long tail without needing a separate percentile path.
  let passesMin = Infinity, passesMax = 0;
  if (passes) {
    for (let i = 0; i < passes.length; i++) {
      const v = passes[i];
      if (v > 0 && Number.isFinite(v)) {
        if (v < passesMin) passesMin = v;
        if (v > passesMax) passesMax = v;
      }
    }
    if (!Number.isFinite(passesMin)) passesMin = 0;
    state.lastPassesAutoMin = passesMin;
    state.lastPassesAutoMax = passesMax;
  } else {
    state.lastPassesAutoMin = 0;
    state.lastPassesAutoMax = 0;
  }

  // Show/hide the passes layer controls based on whether passes was computed
  const passesRow = document.getElementById("passes-row");
  if (passesRow) passesRow.style.display = passes ? "" : "none";

  rerenderCachedResult();

  const meta = [];
  meta.push(`max E: <span class="v">${autoMax.toExponential(2)}</span>`);
  meta.push(`time: <span class="v">${elapsedMs.toFixed(0)} ms</span>`);
  if (passes) {
    meta.push(`max passes: <span class="v">${passesMax.toExponential(2)}</span>`);
  }
  if (routes && routes.length) {
    meta.push(`<span class="v">${routes.length}</span> route${routes.length === 1 ? "" : "s"}:`);
    for (let i = 0; i < routes.length; i++) {
      const r = routes[i];
      meta.push(
        `  ${i + 1}. E=<span class="v">${r.energy.toExponential(2)}</span>, ` +
        `L=<span class="v">${(r.length / 1000).toFixed(2)} km</span>` +
        (r.shared > 0 ? `, shared <span class="v">${r.shared}</span>` : "")
      );
    }
  } else if (pathEnergy != null) {
    meta.push(`path E: <span class="v">${pathEnergy.toExponential(3)}</span>`);
    meta.push(`length: <span class="v">${(pathLengthM / 1000).toFixed(2)} km</span>`);
  }
  resultMeta.innerHTML = meta.join("<br/>");
}

// Re-render the cached energy + passes overlays with the currently-selected
// colormap. Called from renderResult (after a compute), from the colormap
// selector, and from any of the per-field range inputs.
function rerenderCachedResult() {
  const r = state.lastResult;
  if (!r || !state.dem) return;
  const { energy, passes, path, routes } = r;
  const { H, W, originX, originY, dx, dy, isGeographic } = state.dem;

  // -- Energy layer (rendered unless density mode is on, in which case
  // the user wants the density view alone). --
  const densityOn = !!document.getElementById("want-density")?.checked;
  if (energy && !densityOn) {
    state.energyDataUrl = renderFieldToDataURL(energy, W, H, {
      autoMin: state.lastAutoMin ?? 0,
      autoMax: state.lastAutoMax ?? 1,
      userMin: readRangeInput("vmin", null),
      userMax: readRangeInput("vmax", null),
      useGreyscale: false,
      treatZeroAsTransparent: false,
    });
  } else {
    state.energyDataUrl = null;
  }

  // -- Passes layer (greyscale, mirrors energy's absolute-range UI) --
  // Greyscale so additive blending on top of the colour-mapped energy
  // brightens "highway" cells without imposing its own hue. When blend
  // mode is "normal" the renderer paints with full alpha so dim cells
  // read as solid black instead of transparent.
  let passesDU = null;
  if (passes) {
    const blend = document.getElementById("passes-blend")?.value || "plus-lighter";
    const gamma = parseFloat(document.getElementById("passes-gamma")?.value);
    const win = parseInt(document.getElementById("passes-mean-window")?.value, 10);
    passesDU = renderFieldToDataURL(passes, W, H, {
      // Auto bounds (when user hasn't pinned vmin/vmax) come from p10/p90
      // rather than min/max — passes counts are heavily long-tailed and the
      // raw min/max maps the dynamic range mostly to a couple of highway
      // cells, leaving everything else flat.
      usePercentileBounds: true,
      userMin: readRangeInput("passes-vmin", null),
      userMax: readRangeInput("passes-vmax", null),
      gamma: Number.isFinite(gamma) ? gamma : 1,
      meanWindow: Number.isFinite(win) && win > 1 ? win : 1,
      useGreyscale: true,
      solidAlpha: blend === "normal",
      treatZeroAsTransparent: true,
    });
    state.passesDataUrl = passesDU;
  } else {
    state.passesDataUrl = null;
  }

  // Apply both overlays to the map (creates / updates Leaflet layers).
  applyEnergyOverlay();
  applyPassesOverlay();
  applyLayerControls(); // visibility/opacity/blend

  // Clear existing route polylines before redrawing
  if (state.pathLine) { state.pathLine.remove(); state.pathLine = null; }
  if (state.routeLines) {
    for (const ln of state.routeLines) ln.remove();
  }
  state.routeLines = [];

  function pathToLatLngs(p) {
    return p.map((idx) => {
      const rr = (idx / W) | 0;
      const cc = idx - rr * W;
      return [originY - (rr + 0.5) * dy, originX + (cc + 0.5) * dx];
    });
  }

  if (routes && routes.length > 0 && isGeographic) {
    // Top-N: colour each route by rank using the routes-colormap, with a
    // weight that decays slightly so the optimal route reads strongest.
    for (let i = 0; i < routes.length; i++) {
      const r = routes[i];
      const colour = routeColour(i, routes.length);
      const weight = Math.max(2.5, 5 - i * 0.4);
      const opacity = Math.max(0.55, 0.95 - i * 0.05);
      const ln = L.polyline(pathToLatLngs(r.path), {
        color: colour, weight, opacity,
      }).bindTooltip(`route ${i + 1} · E ${r.energy.toExponential(2)} · ${(r.length / 1000).toFixed(2)} km`).addTo(map);
      state.routeLines.push(ln);
    }
  } else if (path && path.length > 0 && isGeographic) {
    state.pathLine = L.polyline(pathToLatLngs(path), {
      color: "#4cc9f0", weight: 4, opacity: 0.95,
    }).addTo(map);
  }

  // Update the legend's numeric ticks to reflect the current mapping.
  updateLegendTicks();
  // Update placeholders so the user can see what "auto" is currently using.
  syncRangePlaceholders();
  // Whatever style was rendered is now the "clean" snapshot. Any input
  // change after this point will re-mark dirty.
  clearStyleDirty();
}

// Separable 2D box blur. Treats the input as zero-padded outside the grid;
// unsettled cells (value 0 in the passes field) get averaged in, which lets
// the smoothed field bleed slightly past the original settled extent — the
// natural "blur" look the user wants.
function boxBlur2D(field, W, H, win) {
  const N = W * H;
  if (win <= 1) return field;
  const half = (win - 1) >> 1;
  const tmp = new Float64Array(N);
  // Horizontal pass: sliding-window mean over each row.
  for (let r = 0; r < H; r++) {
    const rowOff = r * W;
    let sum = 0, count = 0;
    for (let c = 0; c <= half && c < W; c++) {
      sum += field[rowOff + c];
      count++;
    }
    tmp[rowOff] = sum / count;
    for (let c = 1; c < W; c++) {
      const addC = c + half;
      const remC = c - half - 1;
      if (addC < W) { sum += field[rowOff + addC]; count++; }
      if (remC >= 0) { sum -= field[rowOff + remC]; count--; }
      tmp[rowOff + c] = sum / count;
    }
  }
  // Vertical pass over tmp.
  const out = new Float64Array(N);
  for (let c = 0; c < W; c++) {
    let sum = 0, count = 0;
    for (let r = 0; r <= half && r < H; r++) {
      sum += tmp[r * W + c];
      count++;
    }
    out[c] = sum / count;
    for (let r = 1; r < H; r++) {
      const addR = r + half;
      const remR = r - half - 1;
      if (addR < H) { sum += tmp[addR * W + c]; count++; }
      if (remR >= 0) { sum -= tmp[remR * W + c]; count--; }
      out[r * W + c] = sum / count;
    }
  }
  return out;
}

// Render a 2D scalar field to a base64 dataURL.
// Range: vmin/vmax in real units. When both blank → auto. Auto-bounds use
// percentiles (p10/p90) when `usePercentileBounds` is set, else min/max.
// Stretch: linear when bounds are pinned or percentile-based; sqrt for the
// raw min/max auto path (long-tail friendly).
// `useGreyscale: true` paints a black→white ramp instead of the active
// colormap — used for the passes layer.
// `meanWindow > 1` applies a separable box-blur prefilter (treats unsettled
// cells as zero, so the smoothed field bleeds slightly outside the original
// settled extent — that's the desired blur look).
// `gamma`: exponent γ such that `t' = t^γ`. γ=1 → identity. γ=2 squares
// the intensity (darkens dim cells). γ=0.5 takes the square root
// (brightens dim cells).
function renderFieldToDataURL(field, W, H, opts) {
  const N = W * H;

  // Optional mean filter. boxBlur returns a fresh Float64Array.
  const work = opts.meanWindow && opts.meanWindow > 1
    ? boxBlur2D(field, W, H, opts.meanWindow)
    : field;

  // Resolve bounds.
  let autoLo = Infinity, autoHi = 0;
  if (opts.usePercentileBounds) {
    const samples = [];
    for (let i = 0; i < N; i++) {
      const v = work[i];
      if (Number.isFinite(v) && (!opts.treatZeroAsTransparent || v > 0)) samples.push(v);
    }
    samples.sort((a, b) => a - b);
    if (samples.length) {
      autoLo = samples[Math.floor(samples.length * 0.10)];
      autoHi = samples[Math.floor(samples.length * 0.90)];
    }
  } else {
    for (let i = 0; i < N; i++) {
      const v = work[i];
      if (Number.isFinite(v) && (!opts.treatZeroAsTransparent || v > 0)) {
        if (v < autoLo) autoLo = v;
        if (v > autoHi) autoHi = v;
      }
    }
  }
  if (opts.autoMin != null) autoLo = opts.autoMin;
  if (opts.autoMax != null) autoHi = opts.autoMax;

  const userPinned = opts.userMin != null || opts.userMax != null;
  let lo = opts.userMin != null ? opts.userMin : autoLo;
  let hi = opts.userMax != null ? opts.userMax : autoHi;
  // Sqrt stretch only on the raw min/max auto path. Percentile-clipped or
  // user-pinned bounds get a plain linear mapping.
  const useSqrt = !userPinned && !opts.usePercentileBounds;
  if (!Number.isFinite(lo)) lo = 0;
  if (!Number.isFinite(hi) || hi <= lo) hi = lo + 1;
  const span = hi - lo;
  const gammaExp = Math.max(0.01, opts.gamma ?? 1);

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(W, H);

  for (let i = 0; i < N; i++) {
    const v = work[i];
    const unsettled =
      !Number.isFinite(v) || (opts.treatZeroAsTransparent && v === 0);
    if (unsettled) {
      img.data[4 * i + 3] = 0;
      continue;
    }
    let t;
    if (useSqrt) {
      t = Math.sqrt(Math.max(0, v / hi));
    } else {
      t = (v - lo) / span;
    }
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    // Gamma adjustment: t' = t^(1+γ). γ=0 leaves the mapping unchanged.
    if (gammaExp !== 1) t = Math.pow(t, gammaExp);
    let r2, g2, b2, a2;
    if (opts.useGreyscale) {
      const g = Math.round(t * 255);
      r2 = g2 = b2 = g;
      // For additive-style blends (plus-lighter, screen, multiply, etc.)
      // alpha=brightness makes black cells contribute nothing while bright
      // cells fully add. For "normal" blend that trick reads wrong (dark
      // cells become transparent and the energy field bleeds through), so
      // we use full alpha and let the slider do the dimming. The flag is
      // set by the renderer based on the active blend mode.
      a2 = opts.solidAlpha ? 255 : g;
    } else {
      [r2, g2, b2] = colormap(t);
      // Fully opaque on the canvas; user-facing dimming comes from the
      // L.imageOverlay opacity slider so that 100% on the slider really
      // means 100% opaque.
      a2 = 255;
    }
    img.data[4 * i + 0] = r2;
    img.data[4 * i + 1] = g2;
    img.data[4 * i + 2] = b2;
    img.data[4 * i + 3] = a2;
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL();
}

// Linearly interpolate the p-th percentile (0..100) from a sorted ascending
// array. Returns NaN if the array is empty.
function percentileFromSorted(sorted, p) {
  const n = sorted.length;
  if (!n) return NaN;
  const t = Math.max(0, Math.min(100, p)) / 100;
  const f = t * (n - 1);
  const i0 = Math.floor(f);
  const i1 = Math.min(n - 1, i0 + 1);
  const frac = f - i0;
  return sorted[i0] + (sorted[i1] - sorted[i0]) * frac;
}

// Build the energy-layer Leaflet imageOverlay from the cached dataURL.
function applyEnergyOverlay() {
  if (state.energyOverlay) { state.energyOverlay.remove(); state.energyOverlay = null; }
  if (!state.dem || !state.dem.isGeographic || !state.energyDataUrl) return;
  const { H, W, originX, originY, dx, dy } = state.dem;
  const bounds = [[originY - H * dy, originX], [originY, originX + W * dx]];
  state.energyOverlay = L.imageOverlay(state.energyDataUrl, bounds, { opacity: 0.85 }).addTo(map);
}

// Build the passes-layer Leaflet imageOverlay (always above energy).
function applyPassesOverlay() {
  if (state.passesOverlay) { state.passesOverlay.remove(); state.passesOverlay = null; }
  if (!state.dem || !state.dem.isGeographic || !state.passesDataUrl) return;
  const { H, W, originX, originY, dx, dy } = state.dem;
  const bounds = [[originY - H * dy, originX], [originY, originX + W * dx]];
  state.passesOverlay = L.imageOverlay(state.passesDataUrl, bounds, { opacity: 0.7 }).addTo(map);
  // Bump the passes overlay to the top of the imageOverlay pane so it sits
  // visually above the energy overlay.
  state.passesOverlay.bringToFront();
}

// Apply the live UI controls (visibility, opacity, blend mode) to whichever
// overlays exist. Cheap — no canvas re-render. Also drives the tilemap
// add/remove cycle (we only fetch tiles when the user makes it visible).
function applyLayerControls() {
  // rmsampa-v2 tile overlay
  const tileVis = document.getElementById("tile-visible")?.checked ?? false;
  const tileOpRaw = parseFloat(document.getElementById("tile-opacity")?.value);
  const tileOp = Number.isFinite(tileOpRaw) ? tileOpRaw : 0.85;
  if (tileVis && !state.tileOverlayActive) {
    state.tileOverlay.addTo(map);
    state.tileOverlayActive = true;
  } else if (!tileVis && state.tileOverlayActive) {
    state.tileOverlay.remove();
    state.tileOverlayActive = false;
  }
  if (state.tileOverlayActive) {
    state.tileOverlay.setOpacity(tileOp);
  }

  if (state.energyOverlay) {
    const visible = document.getElementById("energy-visible")?.checked ?? true;
    const opacity = parseFloat(document.getElementById("energy-opacity")?.value);
    const op = Number.isFinite(opacity) ? opacity : 0.85;
    state.energyOverlay.setOpacity(visible ? op : 0);
  }
  if (state.passesOverlay) {
    const visible = document.getElementById("passes-visible")?.checked ?? true;
    const opacity = parseFloat(document.getElementById("passes-opacity")?.value);
    const op = Number.isFinite(opacity) ? opacity : 0.7;
    state.passesOverlay.setOpacity(visible ? op : 0);
    const blend = document.getElementById("passes-blend")?.value || "normal";
    const el = state.passesOverlay.getElement();
    if (el) el.style.mixBlendMode = blend;
  }
}

function updateLegendTicks() {
  // The legend reflects the energy layer's mapping (passes uses percentile
  // bounds, which are in 0–100 space and meaningless on the swatch).
  const lo = document.getElementById("legend-lo");
  const mid = document.getElementById("legend-mid");
  const hi = document.getElementById("legend-hi");
  if (!lo || !mid || !hi) return;
  const userMin = readRangeInput("vmin", null);
  const userMax = readRangeInput("vmax", null);
  if (userMin != null || userMax != null) {
    // Linear mapping: midpoint of swatch ↔ midpoint of value range.
    const a = userMin != null ? userMin : (state.lastAutoMin ?? 0);
    const b = userMax != null ? userMax : (state.lastAutoMax ?? 1);
    lo.textContent = formatEnergy(a);
    mid.textContent = formatEnergy(0.5 * (a + b));
    hi.textContent = formatEnergy(b);
  } else {
    // sqrt stretch: visible swatch midpoint ↔ v = maxE/4, not maxE/2.
    const maxE = state.lastAutoMax ?? 0;
    lo.textContent = "0";
    mid.textContent = formatEnergy(maxE * 0.25);
    hi.textContent = formatEnergy(maxE);
  }
}

function readRangeInput(id, fallback) {
  const el = document.getElementById(id);
  if (!el) return fallback;
  const raw = el.value.trim();
  if (raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function isUserPinned(id) {
  const el = document.getElementById(id);
  if (!el) return false;
  const raw = el.value.trim();
  if (raw === "") return false;
  const n = Number(raw);
  return Number.isFinite(n);
}

function syncRangePlaceholders() {
  const lo = document.getElementById("vmin");
  const hi = document.getElementById("vmax");
  if (lo && state.lastAutoMin != null) lo.placeholder = formatEnergy(state.lastAutoMin);
  if (hi && state.lastAutoMax != null) hi.placeholder = formatEnergy(state.lastAutoMax);
  // Passes absolute inputs — placeholders show the auto bounds.
  const pLo = document.getElementById("passes-vmin");
  const pHi = document.getElementById("passes-vmax");
  if (pLo && state.lastPassesAutoMin != null) pLo.placeholder = formatEnergy(state.lastPassesAutoMin);
  if (pHi && state.lastPassesAutoMax != null) pHi.placeholder = formatEnergy(state.lastPassesAutoMax);
}

// ------- Compute-time estimation -------
// Empirical rates on the 553k-cell test DEM:
//   JS forward Dijkstra ≈ 170 ms  → ~3,300 cells/ms.
//   wasm forward Dijkstra ≈ 30–50 ms → ~12,000 cells/ms (when built).
// Mode round-trip = 2 passes. Passes adds ~10%. Each top-N iteration is
// ~0.5× of a Dijkstra (A* terminates at goal). Distance-transform-based
// repulsion modes add ~0.3× per iteration.
const RATE_CELLS_PER_MS_JS   = 3300;
const RATE_CELLS_PER_MS_WASM = 12000;

function estimateRunTime() {
  const out = document.getElementById("time-estimate");
  if (!out) return;
  if (!state.dem) { out.textContent = ""; return; }

  const N = state.dem.H * state.dem.W;
  // We don't await wasmAvailable here (this fires from input events that
  // are synchronous). Use the last-known engine; default to JS estimate.
  const useWasm = state.engine === "wasm";
  const wantPasses = !!document.getElementById("want-passes")?.checked;
  const wantTopN   = !!document.getElementById("want-topn")?.checked;
  // Wasm worker doesn't yet implement passes/top-N → forced JS path.
  const eff = (useWasm && !wantPasses && !wantTopN) ? "wasm" : "js";
  const rate = eff === "wasm" ? RATE_CELLS_PER_MS_WASM : RATE_CELLS_PER_MS_JS;

  let ms = N / rate;
  const mode = document.getElementById("mode")?.value || "from";
  if (mode === "round") ms *= 2;
  if (wantPasses) ms *= 1.1;

  if (wantTopN) {
    const k = Math.max(1, Math.min(20, parseInt(document.getElementById("n-routes")?.value, 10) || 3));
    const rep = document.getElementById("repulsion-mode")?.value || "per-cell";
    const perIter = rep === "per-cell" ? 0.5 : 0.8;
    ms += (N / rate) * perIter * k;
  }
  // Multi-reference density runs one (or two for round-trip) Dijkstras per
  // reference, each with passes tracking.
  const wantDensity = !!document.getElementById("want-density")?.checked;
  if (wantDensity) {
    const refs = state.refPoints?.length || 0;
    // Density direction now follows the global mode select.
    const dmode = document.getElementById("mode")?.value || "from";
    const dijkstrasPerRef = dmode === "round" ? 2 : 1;
    ms += (N / rate) * 1.1 * dijkstrasPerRef * refs;
  }
  out.textContent = `≈ ${formatDuration(ms)} (${eff})`;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) return "—";
  if (ms < 950) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms / 1000)} s`;
}

function formatEnergy(v) {
  if (!Number.isFinite(v) || v === 0) return "0";
  const a = Math.abs(v);
  if (a >= 1000 || a < 0.01) return v.toExponential(1);
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

// ------- DEM metadata formatters -------
function formatCellSize(dx, dy, originY, H, isGeographic) {
  if (isGeographic) {
    const latRef = originY - (H * dy) / 2;
    const dxM = dx * 111320 * Math.cos((latRef * Math.PI) / 180);
    const dyM = dy * 110574;
    return `<span class="v">${dxM.toFixed(1)} × ${dyM.toFixed(1)} m</span> <span style="opacity:0.6">(${dx.toExponential(2)}° × ${dy.toExponential(2)}°)</span>`;
  }
  return `<span class="v">${dx.toFixed(1)} × ${dy.toFixed(1)} m</span>`;
}

function formatCoverage(W, H, dx, dy, originY, isGeographic) {
  let xKm, yKm;
  if (isGeographic) {
    const latRef = originY - (H * dy) / 2;
    xKm = (W * dx * 111320 * Math.cos((latRef * Math.PI) / 180)) / 1000;
    yKm = (H * dy * 110574) / 1000;
  } else {
    xKm = (W * dx) / 1000;
    yKm = (H * dy) / 1000;
  }
  return `<span class="v">${xKm.toFixed(2)} × ${yKm.toFixed(2)} km</span> coverage`;
}

// ------- ColorCET colormaps -------
// Auto-generated from the python `colorcet` package — full set, ~75 maps.
// Each entry: 17 anchor RGB triples sampled evenly from the 256-stop palette
// (Kovesi 2015, https://colorcet.com/). Maps are designed to be uniform under
// CIECAM02 rather than the simpler L* CIELab metric matplotlib uses, so they
// hold up better at the extremes.
const COLORMAPS = {
  CET_L1: [[0,0,0],[19,19,19],[32,32,32],[45,45,45],[59,59,59],[73,73,73],[88,88,88],[103,103,103],[119,119,119],[134,134,134],[150,150,150],[167,167,167],[184,184,184],[201,201,201],[219,219,219],[236,236,236],[254,255,255]],
  CET_L2: [[27,27,27],[38,38,38],[49,49,49],[61,61,61],[73,73,73],[86,86,86],[99,99,99],[112,112,112],[125,125,125],[138,138,138],[152,152,152],[166,166,166],[180,180,180],[195,195,195],[210,210,210],[225,225,225],[240,240,240]],
  CET_L3: [[0,0,0],[50,0,0],[74,0,0],[99,1,0],[125,2,0],[152,3,0],[180,5,0],[209,9,0],[237,20,0],[251,61,0],[254,102,0],[255,135,0],[255,164,1],[255,191,3],[255,217,9],[255,241,30],[255,255,255]],
  CET_L4: [[0,0,0],[49,0,0],[73,0,0],[97,1,0],[122,2,0],[148,3,0],[175,5,0],[203,8,0],[231,16,0],[246,54,0],[250,95,0],[252,127,0],[253,156,0],[254,182,0],[254,207,0],[254,231,0],[255,255,0]],
  CET_L5: [[0,21,5],[9,33,5],[8,47,4],[10,61,4],[14,76,5],[18,91,6],[22,106,7],[26,122,9],[31,138,11],[34,153,13],[39,170,14],[43,187,16],[47,204,18],[52,222,20],[83,238,21],[150,249,21],[216,255,20]],
  CET_L6: [[0,0,78],[5,2,110],[15,1,144],[10,4,181],[12,16,213],[31,34,238],[43,59,249],[47,85,251],[45,108,253],[43,129,253],[51,149,253],[53,169,252],[43,189,252],[41,209,250],[73,227,249],[128,242,247],[179,254,245]],
  CET_L7: [[0,2,75],[0,5,108],[5,5,143],[4,8,179],[22,15,212],[54,24,238],[101,28,250],[147,28,253],[186,28,253],[217,39,253],[239,65,254],[251,97,253],[254,130,252],[254,159,252],[254,186,253],[254,210,254],[254,234,254]],
  CET_L8: [[0,14,92],[14,21,118],[45,26,138],[86,24,146],[124,16,144],[157,10,140],[186,11,133],[212,24,125],[232,51,112],[243,79,96],[248,108,82],[248,136,71],[250,160,61],[252,182,55],[252,205,59],[249,226,67],[245,248,77]],
  CET_L9: [[5,0,171],[11,33,176],[13,55,180],[12,74,180],[6,93,173],[25,112,151],[43,130,120],[49,147,84],[65,161,55],[89,173,33],[121,185,12],[155,194,2],[188,203,8],[217,213,26],[239,224,50],[250,239,102],[249,249,249]],
  CET_L10: [[101,154,143],[113,158,136],[125,161,129],[139,164,123],[155,166,117],[176,165,113],[194,165,111],[206,167,108],[211,171,105],[214,176,105],[216,181,112],[216,187,125],[215,192,143],[215,197,160],[214,202,177],[213,207,194],[212,212,212]],
  CET_L11: [[111,172,91],[132,174,93],[151,175,95],[168,175,97],[184,176,99],[199,177,101],[213,178,104],[224,180,106],[230,184,109],[231,189,114],[231,195,124],[231,200,138],[230,206,156],[229,211,173],[228,216,191],[227,221,208],[226,226,226]],
  CET_L12: [[240,240,240],[228,233,239],[216,225,238],[203,217,236],[191,210,235],[179,203,232],[167,195,229],[156,188,225],[146,180,220],[138,173,214],[129,166,207],[121,158,199],[112,151,193],[101,144,188],[89,137,184],[75,130,180],[58,123,177]],
  CET_L13: [[0,0,0],[27,5,0],[43,8,0],[55,10,0],[67,12,0],[79,15,0],[92,17,0],[105,19,0],[118,22,0],[130,24,0],[144,27,0],[157,29,0],[171,32,0],[186,35,0],[200,37,0],[214,40,0],[229,43,0]],
  CET_L14: [[0,0,0],[0,14,0],[0,23,0],[0,30,0],[0,37,0],[0,44,0],[0,51,0],[0,58,0],[0,65,0],[0,72,0],[0,79,0],[0,87,0],[0,95,0],[0,103,0],[0,111,0],[0,119,0],[0,127,0]],
  CET_L15: [[0,0,0],[2,9,28],[4,15,48],[6,20,62],[7,25,75],[8,29,89],[10,34,103],[11,38,117],[13,43,132],[14,48,145],[16,53,160],[17,58,176],[19,63,191],[20,68,207],[22,73,222],[23,78,238],[25,84,255]],
  CET_L16: [[16,16,16],[32,19,69],[33,21,119],[22,29,161],[8,48,181],[6,71,183],[5,95,172],[32,117,143],[47,138,103],[57,156,66],[84,172,37],[122,185,11],[163,196,2],[201,207,15],[232,220,40],[248,236,87],[249,249,249]],
  CET_L17: [[254,255,255],[246,242,210],[242,228,175],[242,211,149],[243,192,130],[244,173,116],[245,153,107],[243,132,103],[239,111,105],[233,90,108],[222,69,115],[207,50,124],[189,34,134],[164,24,144],[133,28,154],[91,35,161],[0,42,167]],
  CET_L18: [[254,255,255],[245,247,213],[237,238,181],[233,228,157],[231,216,136],[229,204,116],[228,192,98],[228,179,82],[227,166,67],[226,153,55],[225,139,43],[224,124,35],[223,109,28],[221,92,24],[219,73,24],[216,51,26],[212,15,29]],
  CET_L19: [[254,255,255],[234,247,253],[216,238,253],[200,229,253],[190,218,254],[185,206,254],[184,192,251],[190,178,245],[199,162,235],[209,146,222],[220,127,203],[228,108,179],[234,87,152],[235,67,122],[231,49,89],[222,37,55],[208,33,14]],
  CET_L20: [[48,48,48],[60,53,88],[66,60,127],[66,69,161],[62,80,188],[55,96,200],[40,118,182],[37,138,149],[65,154,117],[104,164,89],[147,172,59],[187,178,30],[228,182,19],[247,193,20],[254,209,18],[253,228,15],[248,248,9]],
  CET_D1: [[32,80,218],[81,98,222],[112,117,225],[137,136,228],[160,156,231],[181,176,234],[201,197,236],[221,218,238],[237,231,233],[241,214,208],[240,190,177],[236,165,147],[231,140,118],[223,114,90],[214,87,63],[203,57,36],[191,2,5]],
  CET_D1A: [[23,41,113],[28,58,161],[40,78,207],[81,100,230],[119,125,243],[153,151,252],[185,180,250],[213,209,245],[238,226,230],[250,202,191],[252,165,146],[248,126,104],[232,91,70],[212,53,39],[184,6,15],[143,3,9],[102,7,2]],
  CET_D2: [[56,150,14],[85,162,51],[110,173,79],[133,184,106],[155,196,132],[176,207,158],[198,218,185],[219,229,212],[235,234,235],[234,221,239],[229,203,238],[222,185,237],[215,166,235],[208,148,233],[200,129,232],[192,109,230],[183,89,228]],
  CET_D3: [[56,150,14],[85,162,51],[110,173,79],[133,184,106],[155,196,132],[176,207,158],[198,218,185],[219,229,212],[238,234,230],[245,220,216],[248,201,194],[250,181,171],[250,161,150],[248,140,128],[245,119,108],[241,96,87],[236,71,68]],
  CET_D4: [[24,129,250],[40,115,219],[47,101,188],[49,88,159],[49,75,130],[46,62,102],[41,50,76],[35,38,51],[34,31,32],[51,35,32],[75,42,36],[99,49,41],[124,56,46],[149,62,51],[175,68,55],[202,74,60],[230,79,65]],
  CET_D6: [[14,147,250],[36,131,218],[44,114,188],[47,99,158],[48,83,130],[45,68,102],[41,54,76],[35,40,51],[33,32,32],[45,39,29],[63,52,31],[81,65,32],[100,79,33],[119,94,33],[138,108,32],[158,123,29],[179,138,25]],
  CET_D7: [[19,49,193],[59,60,187],[80,72,182],[96,84,176],[108,96,170],[119,108,164],[129,120,157],[137,132,151],[145,144,144],[160,154,135],[174,164,124],[189,174,113],[202,184,101],[215,195,88],[228,206,72],[240,216,51],[252,227,9]],
  CET_D8: [[0,42,215],[37,50,200],[62,57,185],[76,65,171],[86,72,157],[92,79,142],[96,86,128],[99,93,114],[101,100,99],[124,98,90],[147,94,80],[167,90,70],[187,84,59],[205,77,48],[224,67,36],[242,52,21],[255,24,0]],
  CET_D9: [[36,127,254],[89,141,254],[121,155,254],[147,170,253],[170,185,253],[191,200,252],[211,216,251],[230,232,250],[248,246,246],[252,228,222],[253,208,197],[253,188,172],[251,167,147],[247,147,123],[243,126,100],[237,104,77],[230,80,54]],
  CET_D10: [[0,216,255],[82,221,255],[119,226,255],[148,231,255],[172,236,255],[195,241,255],[216,245,255],[236,250,255],[254,254,254],[254,245,253],[254,235,251],[254,225,249],[253,214,247],[253,204,245],[252,194,243],[251,184,242],[249,173,240]],
  CET_D11: [[0,182,255],[61,180,247],[91,179,236],[112,178,225],[128,176,214],[141,175,203],[152,173,192],[162,172,181],[172,170,171],[182,168,163],[193,165,155],[203,162,147],[212,158,140],[221,155,132],[230,151,124],[238,148,116],[246,144,108]],
  CET_D12: [[0,200,255],[57,198,246],[92,196,237],[115,194,228],[133,192,219],[149,190,210],[162,188,202],[174,186,193],[184,184,187],[191,181,189],[198,178,195],[205,175,200],[212,172,206],[218,169,211],[224,166,216],[231,162,222],[237,158,227]],
  CET_D13: [[16,44,103],[32,65,138],[46,87,171],[54,112,202],[50,140,228],[66,169,245],[120,195,251],[182,217,247],[223,235,236],[174,223,208],[108,205,176],[56,182,138],[36,157,95],[31,130,59],[21,105,33],[8,81,15],[0,57,1]],
  CET_R1: [[0,47,245],[25,94,190],[38,122,138],[62,143,89],[71,163,36],[114,177,16],[160,188,23],[204,198,30],[241,202,36],[249,185,33],[248,159,28],[244,133,23],[240,105,20],[241,85,47],[251,101,110],[255,123,178],[253,145,250]],
  CET_R2: [[0,51,245],[0,88,200],[0,114,157],[49,131,118],[62,148,77],[66,164,26],[106,175,17],[145,184,25],[180,193,32],[213,200,39],[245,204,44],[253,186,37],[255,164,28],[255,141,19],[255,116,10],[254,87,2],[252,48,0]],
  CET_R3: [[8,92,248],[22,124,187],[49,146,121],[63,164,49],[103,175,29],[142,184,26],[177,193,21],[212,201,15],[244,204,31],[252,185,74],[254,161,105],[254,136,131],[252,107,154],[248,76,166],[241,54,119],[229,34,66],[214,4,0]],
  CET_R4: [[3,0,108],[5,0,156],[11,24,193],[16,48,224],[29,79,234],[5,124,169],[47,154,79],[81,177,8],[137,193,4],[184,208,2],[230,222,1],[250,204,11],[251,171,19],[252,135,20],[254,91,15],[244,38,12],[214,5,13]],
  CET_I1: [[54,183,236],[63,184,222],[71,185,207],[79,186,193],[87,186,178],[96,187,163],[106,186,147],[119,186,131],[135,184,117],[151,181,107],[167,177,100],[183,172,95],[197,167,93],[211,162,94],[224,156,97],[235,150,102],[246,144,108]],
  CET_I2: [[111,209,255],[112,210,245],[114,212,232],[117,213,219],[120,214,205],[125,214,191],[132,214,177],[142,214,162],[156,212,148],[170,210,137],[186,206,129],[202,202,122],[216,198,118],[230,193,117],[242,188,119],[254,183,123],[255,178,129]],
  CET_I3: [[19,185,229],[62,183,231],[85,180,233],[104,177,235],[121,174,235],[136,171,236],[151,168,235],[165,164,233],[178,161,228],[190,157,223],[201,154,216],[211,151,210],[221,147,202],[230,143,195],[238,140,188],[246,136,180],[253,132,172]],
  CET_C1: [[248,132,247],[249,104,196],[234,67,136],[207,36,75],[181,26,21],[189,67,4],[204,105,4],[213,143,4],[207,170,39],[164,160,95],[94,140,144],[33,108,193],[59,63,238],[104,76,249],[146,106,250],[202,124,254],[247,133,249]],
  CET_C2: [[239,85,241],[251,132,206],[251,175,161],[252,212,113],[240,237,53],[198,229,22],[150,211,16],[97,193,11],[49,172,40],[66,145,96],[62,115,151],[41,80,197],[43,36,232],[96,34,245],[142,56,250],[193,67,250],[237,82,243]],
  CET_C3: [[224,215,218],[237,187,173],[239,147,122],[235,104,73],[218,61,33],[173,50,26],[123,45,28],[76,38,28],[41,33,38],[42,46,78],[48,66,134],[42,87,194],[47,110,245],[111,136,250],[157,165,243],[194,195,235],[223,215,220]],
  CET_C4: [[222,213,216],[230,181,167],[225,136,112],[213,88,59],[201,48,22],[212,85,57],[224,133,109],[230,179,165],[220,209,215],[187,188,228],[145,153,229],[91,119,229],[25,99,228],[92,120,229],[146,153,229],[188,189,228],[221,213,218]],
  CET_C5: [[119,119,119],[141,141,141],[163,163,163],[187,187,187],[202,202,202],[185,185,185],[162,162,162],[139,139,139],[117,117,117],[97,97,97],[77,77,77],[57,57,57],[45,45,45],[57,57,57],[76,76,76],[97,97,97],[118,118,118]],
  CET_C6: [[246,54,26],[252,116,1],[255,179,0],[225,209,0],[152,184,0],[76,155,18],[43,167,81],[49,206,161],[37,232,234],[48,200,255],[40,150,255],[88,129,255],[170,158,255],[234,189,251],[255,165,185],[255,104,99],[246,53,29]],
  CET_C7: [[232,228,25],[250,197,104],[255,157,157],[255,111,204],[251,62,246],[227,122,254],[195,172,253],[147,213,252],[59,243,242],[46,230,195],[51,209,141],[39,189,86],[35,174,24],[97,186,0],[146,203,0],[191,218,0],[231,228,18]],
  CET_C8: [[232,148,149],[239,166,131],[237,185,115],[228,205,101],[204,221,99],[167,221,123],[134,212,149],[98,201,172],[61,187,193],[24,174,209],[6,158,222],[42,141,231],[97,124,231],[155,119,213],[190,123,191],[215,132,170],[232,146,150]],
  CET_C9: [[194,127,116],[205,157,108],[209,187,101],[205,218,97],[182,239,105],[144,230,129],[112,208,148],[81,183,163],[52,158,172],[27,133,178],[7,107,179],[21,80,177],[67,55,168],[117,53,152],[150,72,138],[175,97,127],[193,125,117]],
  CET_C10: [[217,144,132],[207,150,118],[190,157,110],[171,164,108],[148,170,115],[125,174,131],[102,177,151],[79,178,173],[65,177,193],[81,174,207],[111,168,214],[141,162,216],[170,154,210],[193,148,195],[208,144,175],[217,142,154],[217,144,133]],
  CET_C11: [[71,48,241],[95,86,203],[106,124,158],[94,160,109],[72,183,52],[114,161,17],[145,124,4],[164,80,0],[180,21,17],[203,17,64],[227,52,122],[246,79,184],[250,98,241],[217,86,254],[173,67,253],[123,50,251],[72,47,242]],
  CET_CBL1: [[16,16,16],[19,28,47],[13,40,76],[0,52,103],[1,65,125],[31,77,140],[66,91,140],[97,104,129],[121,118,118],[142,132,106],[163,146,92],[182,161,89],[198,176,103],[212,191,128],[224,207,160],[234,223,197],[240,240,240]],
  CET_CBL2: [[16,16,16],[22,28,44],[20,41,73],[16,53,100],[15,66,125],[14,80,150],[11,94,175],[6,108,202],[0,123,228],[54,136,241],[126,151,211],[172,167,161],[204,182,112],[229,198,56],[248,214,56],[255,231,158],[251,249,243]],
  CET_CBL3: [[16,16,16],[25,28,38],[30,40,61],[35,52,85],[37,64,110],[37,77,136],[35,91,163],[28,105,192],[12,119,220],[24,132,242],[77,147,250],[116,161,249],[146,176,248],[172,192,246],[196,208,244],[219,224,242],[240,240,240]],
  CET_CBL4: [[16,16,16],[33,28,14],[47,40,10],[61,52,5],[76,64,1],[91,77,1],[106,90,1],[122,104,1],[138,118,1],[154,131,1],[171,146,1],[188,161,1],[205,176,1],[223,191,0],[241,207,16],[254,222,99],[244,240,231]],
  CET_CBD1: [[58,144,254],[97,155,252],[125,166,251],[148,178,250],[168,190,248],[188,202,246],[206,215,244],[223,227,242],[237,236,236],[233,227,212],[226,214,185],[218,202,159],[209,190,132],[200,178,106],[189,166,79],[179,154,50],[167,143,8]],
  CET_CBD2: [[4,136,252],[69,141,243],[97,146,234],[116,151,225],[132,157,216],[146,162,206],[158,167,197],[169,173,188],[179,179,178],[190,184,169],[200,189,159],[210,194,149],[220,199,138],[229,205,127],[238,210,115],[246,216,103],[254,221,89]],
  CET_CBC1: [[62,134,234],[118,159,240],[164,185,242],[204,213,243],[235,233,233],[223,211,181],[203,184,127],[180,157,72],[154,132,17],[127,109,24],[98,85,33],[70,62,38],[47,46,46],[52,62,86],[59,84,134],[59,108,185],[59,133,232]],
  CET_CBC2: [[238,237,236],[226,214,183],[206,186,126],[182,159,67],[162,139,1],[181,158,64],[205,185,123],[225,213,181],[235,234,235],[204,214,245],[162,186,247],[112,159,248],[54,140,248],[113,159,248],[163,186,247],[205,214,245],[237,237,238]],
  CET_CBTL1: [[16,16,16],[52,18,14],[85,12,12],[114,1,14],[139,2,19],[163,5,26],[189,11,32],[215,17,39],[241,28,46],[251,67,67],[231,119,112],[188,161,166],[111,195,219],[41,218,250],[132,230,252],[196,239,251],[249,249,249]],
  CET_CBTL2: [[16,16,16],[47,21,17],[73,24,21],[95,30,26],[115,40,35],[127,56,49],[130,77,70],[127,98,94],[119,119,121],[105,138,147],[77,158,176],[26,177,204],[29,194,223],[84,208,234],[137,221,241],[189,231,242],[240,240,240]],
  CET_CBTL3: [[16,16,16],[23,29,31],[27,42,46],[31,56,62],[33,70,78],[35,84,95],[36,99,112],[36,114,130],[35,130,148],[34,145,166],[31,161,185],[29,177,203],[31,194,222],[47,210,240],[109,224,249],[175,234,249],[240,240,240]],
  CET_CBTL4: [[16,16,16],[46,22,18],[73,24,20],[100,25,23],[127,24,25],[154,23,29],[180,24,34],[205,31,41],[227,45,50],[242,67,64],[248,97,86],[252,124,110],[254,148,135],[254,172,160],[252,195,186],[247,218,213],[240,240,240]],
  CET_CBTD1: [[41,201,230],[89,207,233],[120,213,235],[145,219,237],[168,225,240],[190,231,242],[210,237,244],[229,243,246],[247,246,246],[251,237,235],[253,226,222],[254,215,210],[254,204,197],[255,193,184],[254,182,172],[253,171,160],[252,160,148]],
  CET_CBTC1: [[38,187,214],[110,204,226],[163,220,235],[209,237,245],[248,247,248],[253,225,221],[250,198,191],[244,172,162],[233,147,136],[202,134,125],[167,121,114],[132,108,104],[100,99,100],[92,117,124],[83,140,154],[64,163,184],[35,186,213]],
  CET_CBTC2: [[251,250,250],[254,228,224],[252,201,193],[247,175,164],[243,154,142],[247,173,163],[252,200,192],[254,227,222],[248,248,249],[210,238,246],[163,222,237],[108,206,228],[43,194,222],[109,206,228],[164,222,237],[211,238,246],[249,250,250]],
  // cmocean.phase — cyclic perceptually-uniform colormap by Thyng et al. 2016.
  // https://matplotlib.org/cmocean/#phase
  cmo_phase: [[168,120,13],[190,104,40],[207,86,67],[219,64,102],[223,42,147],[213,41,196],[192,65,229],[162,92,243],[125,115,240],[82,133,220],[44,144,188],[25,149,156],[12,152,124],[36,154,82],[94,148,32],[139,134,13],[168,120,13]],
};

// Class metadata for the dropdown <optgroup>s.
const COLORCET_GROUPS = [
  { label: "cmocean", keys: ["cmo_phase"] },
  { label: "Linear", keys: ["CET_L1","CET_L2","CET_L3","CET_L4","CET_L5","CET_L6","CET_L7","CET_L8","CET_L9","CET_L10","CET_L11","CET_L12","CET_L13","CET_L14","CET_L15","CET_L16","CET_L17","CET_L18","CET_L19","CET_L20"] },
  { label: "Diverging", keys: ["CET_D1","CET_D1A","CET_D2","CET_D3","CET_D4","CET_D6","CET_D7","CET_D8","CET_D9","CET_D10","CET_D11","CET_D12","CET_D13"] },
  { label: "Rainbow", keys: ["CET_R1","CET_R2","CET_R3","CET_R4"] },
  { label: "Isoluminant", keys: ["CET_I1","CET_I2","CET_I3"] },
  { label: "Cyclic", keys: ["CET_C1","CET_C2","CET_C3","CET_C4","CET_C5","CET_C6","CET_C7","CET_C8","CET_C9","CET_C10","CET_C11"] },
  { label: "Colour-blind safe linear", keys: ["CET_CBL1","CET_CBL2","CET_CBL3","CET_CBL4"] },
  { label: "Colour-blind safe diverging", keys: ["CET_CBD1","CET_CBD2"] },
  { label: "Colour-blind safe cyclic", keys: ["CET_CBC1","CET_CBC2"] },
  { label: "Tritan-safe linear", keys: ["CET_CBTL1","CET_CBTL2","CET_CBTL3","CET_CBTL4"] },
  { label: "Tritan-safe diverging", keys: ["CET_CBTD1"] },
  { label: "Tritan-safe cyclic", keys: ["CET_CBTC1","CET_CBTC2"] },
];

let activeColormap = "cmo_phase"; // cmocean.phase — cyclic, perceptually uniform

// Sample a CET colormap at evenly-spaced positions for top-N route colours.
// route i of n → t = (i + 0.5) / n so we land in the middle of each band
// rather than at the saturated endpoints.
function routeColour(i, n) {
  const name = document.getElementById("routes-colormap")?.value || "CET_R2";
  const anchors = COLORMAPS[name] || COLORMAPS.CET_R2;
  const t = n > 1 ? (i + 0.5) / n : 0.5;
  const m = anchors.length - 1;
  const f = t * m;
  const j = Math.floor(f);
  const frac = f - j;
  const a = anchors[Math.min(j, m)];
  const b = anchors[Math.min(j + 1, m)];
  const r = Math.round(a[0] + (b[0] - a[0]) * frac);
  const g = Math.round(a[1] + (b[1] - a[1]) * frac);
  const bl = Math.round(a[2] + (b[2] - a[2]) * frac);
  return `rgb(${r},${g},${bl})`;
}

function colormap(t) {
  const anchors = COLORMAPS[activeColormap] || COLORMAPS.viridis;
  t = Math.max(0, Math.min(1, t));
  const n = anchors.length - 1;
  const f = t * n;
  const i = Math.floor(f);
  const frac = f - i;
  const a = anchors[Math.min(i, n)];
  const b = anchors[Math.min(i + 1, n)];
  return [
    Math.round(a[0] + (b[0] - a[0]) * frac),
    Math.round(a[1] + (b[1] - a[1]) * frac),
    Math.round(a[2] + (b[2] - a[2]) * frac),
  ];
}

// Build a CSS linear-gradient string for the swatch.
function colormapToCss(name) {
  const anchors = COLORMAPS[name];
  const stops = anchors.map((rgb, i) => {
    const pct = ((i / (anchors.length - 1)) * 100).toFixed(1);
    return `rgb(${rgb[0]},${rgb[1]},${rgb[2]}) ${pct}%`;
  });
  return `linear-gradient(to right, ${stops.join(", ")})`;
}

function applyColormapToLegend() {
  const swatch = document.querySelector(".swatch");
  if (swatch) swatch.style.background = colormapToCss(activeColormap);
}

// ------- Bundle download / reload -------
// `metadata.jsonld` captures everything needed to reproduce the run from the
// same DEM: timestamps, engine, all compute parameters, source/destination
// pixel coordinates, and the visualisation knobs. Output arrays are written
// alongside as raw little-endian binaries (energy.bin, passes.bin) plus
// GeoJSON line layers for routes/path. JSON-LD `@context` is inlined so
// the file is self-describing without a network fetch.

const SIMU_CONTEXT = {
  "@vocab": "https://pedalhidrografi.co/vocab/simujoules#",
  "schema": "https://schema.org/",
  "geo": "http://www.opengis.net/ont/geosparql#",
  "qudt": "http://qudt.org/schema/qudt/",
};

function pixelToLonLat(idx, dem) {
  const r = (idx / dem.W) | 0;
  const c = idx - r * dem.W;
  return [dem.originX + (c + 0.5) * dem.dx, dem.originY - (r + 0.5) * dem.dy];
}

function pathFCFromIndices(path, dem, props = {}) {
  const coords = path.map((i) => pixelToLonLat(i, dem));
  return {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      geometry: { type: "LineString", coordinates: coords },
      properties: props,
    }],
  };
}

function routesFCFromList(routes, dem) {
  return {
    type: "FeatureCollection",
    features: routes.map((r, i) => ({
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: r.path.map((idx) => pixelToLonLat(idx, dem)),
      },
      properties: {
        rank: i + 1,
        energy: r.energy,
        length_m: r.length,
        shared_cells: r.shared,
      },
    })),
  };
}

function buildMetadata(result, withOutputs = true) {
  const dem = state.dem;
  const params = {
    mode:          document.getElementById("mode")?.value,
    alpha:         parseFloat(document.getElementById("alpha")?.value),
    beta:          parseFloat(document.getElementById("beta")?.value),
    eta:           parseFloat(document.getElementById("eta")?.value),
    src:           state.src,
    dst:           state.dst,
    wantPasses:    !!document.getElementById("want-passes")?.checked,
    wantTopN:      !!document.getElementById("want-topn")?.checked,
    nRoutes:       parseInt(document.getElementById("n-routes")?.value, 10) || 3,
    penalty:       parseFloat(document.getElementById("penalty")?.value) || 2.0,
    repulsionMode: document.getElementById("repulsion-mode")?.value || "per-cell",
  };
  const viz = {
    fieldColormap:  activeColormap,
    routesColormap: document.getElementById("routes-colormap")?.value || "CET_R2",
    energy: {
      vmin:    readRangeInput("vmin", null),
      vmax:    readRangeInput("vmax", null),
      opacity: parseFloat(document.getElementById("energy-opacity")?.value),
      visible: !!document.getElementById("energy-visible")?.checked,
    },
    passes: {
      vmin:    readRangeInput("passes-vmin", null),
      vmax:    readRangeInput("passes-vmax", null),
      opacity: parseFloat(document.getElementById("passes-opacity")?.value),
      visible: !!document.getElementById("passes-visible")?.checked,
      blend:   document.getElementById("passes-blend")?.value || "plus-lighter",
    },
    tile: {
      url:     RMSAMPA_URL,
      opacity: parseFloat(document.getElementById("tile-opacity")?.value),
      visible: !!document.getElementById("tile-visible")?.checked,
    },
  };

  const md = {
    "@context":           SIMU_CONTEXT,
    "@type":              "EnergyFieldComputation",
    "schema:dateCreated": new Date().toISOString(),
    timestamp:            new Date().toISOString(),
    schemaVersion:        1,
    engine:               state.engine || "js",
    elapsedMs:            result?.elapsedMs ?? null,
    dem: {
      label:        state.demLabel || null,
      sourceUrl:    state.demSourceUrl || null,
      H:            dem.H,
      W:            dem.W,
      originX:      dem.originX,
      originY:      dem.originY,
      dx:           dem.dx,
      dy:           dem.dy,
      dxM:          dem.dxM,
      dyM:          dem.dyM,
      isGeographic: dem.isGeographic,
    },
    params,
    viz,
    stats: {
      maxE:        state.lastAutoMax ?? null,
      maxPasses:   state.lastPassesAutoMax ?? null,
      pathEnergy:  result?.pathEnergy ?? null,
      pathLengthM: result?.pathLengthM ?? null,
    },
  };

  if (withOutputs && result) {
    md.outputs = {
      energy: result.energy ? {
        type: "Float32Array",
        shape: [dem.H, dem.W],
        file: "energy.bin",
        byteOrder: "little-endian",
      } : null,
      passes: result.passes ? {
        type: "Float64Array",
        shape: [dem.H, dem.W],
        file: "passes.bin",
        byteOrder: "little-endian",
      } : null,
      routes: result.routes && result.routes.length ? {
        type: "GeoJSON",
        file: "routes.geojson",
      } : null,
      path: result.path && result.path.length ? {
        type: "GeoJSON",
        file: "path.geojson",
      } : null,
    };
  }
  return md;
}

async function downloadBundle() {
  console.info("[bundle] download click — lastResult?", !!state.lastResult, "dem?", !!state.dem, "JSZip?", typeof JSZip);
  if (!state.dem) {
    status.innerHTML = '<span style="color:#ff6b6b">Load a DEM first, then run Compute, then download.</span>';
    return;
  }
  if (!state.lastResult) {
    status.innerHTML = '<span style="color:#ff6b6b">Nothing to download yet — click Compute first.</span>';
    return;
  }
  if (typeof JSZip === "undefined") {
    status.innerHTML = '<span style="color:#ff6b6b">JSZip didn\'t load — check the network/console.</span>';
    return;
  }
  status.textContent = "Building bundle…";
  try {
    const r = state.lastResult;
    const dem = state.dem;
    const md = buildMetadata(r, true);

    const zip = new JSZip();
    zip.file("metadata.jsonld", JSON.stringify(md, null, 2));
    // Use Uint8Array views so JSZip stores exactly the typed-array bytes
    // regardless of byteOffset / shared underlying buffers.
    if (r.energy) zip.file("energy.bin", new Uint8Array(r.energy.buffer, r.energy.byteOffset, r.energy.byteLength));
    if (r.passes) zip.file("passes.bin", new Uint8Array(r.passes.buffer, r.passes.byteOffset, r.passes.byteLength));
    if (r.routes && r.routes.length) {
      zip.file("routes.geojson", JSON.stringify(routesFCFromList(r.routes, dem), null, 2));
    }
    if (r.path && r.path.length) {
      zip.file("path.geojson", JSON.stringify(pathFCFromIndices(r.path, dem, {
        energy: r.pathEnergy,
        length_m: r.pathLengthM,
      }), null, 2));
    }

    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const ts = new Date().toISOString().replace(/[:.]/g, "-").replace(/-Z?$/, "");
    const slug = state.demLabel ? state.demLabel.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9._-]/g, "_") + "-" : "";
    const a = document.createElement("a");
    a.href = url;
    a.download = `simujoules-${slug}${ts}.zip`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
    status.textContent = `Saved bundle (${(blob.size / 1024 / 1024).toFixed(1)} MB).`;
  } catch (err) {
    console.error("[bundle] download failed:", err);
    status.innerHTML = `<span style="color:#ff6b6b">Download failed: ${err.message}</span>`;
  }
}

// Read a bundle (.zip with metadata.jsonld + arrays) or a bare .jsonld and
// restore as much UI/state as possible. After restoration: if a matching
// DEM is already loaded, src/dst markers are placed and the user can click
// Compute to reproduce. If no DEM, the status nudges them to load one.
async function loadBundleFile(file) {
  try {
    let md;
    let bin = {}; // { energy: Float32Array, passes: Float64Array, ... }
    if (/\.zip$/i.test(file.name)) {
      if (typeof JSZip === "undefined") throw new Error("JSZip didn't load");
      const zip = await JSZip.loadAsync(await file.arrayBuffer());
      const mdEntry = zip.file("metadata.jsonld") || zip.file("metadata.json");
      if (!mdEntry) throw new Error("No metadata.jsonld inside the archive.");
      md = JSON.parse(await mdEntry.async("string"));
      const eEntry = zip.file("energy.bin");
      if (eEntry) bin.energy = new Float32Array(await eEntry.async("arraybuffer"));
      const pEntry = zip.file("passes.bin");
      if (pEntry) bin.passes = new Float64Array(await pEntry.async("arraybuffer"));
      // GeoJSON route/path geometry doesn't get re-rasterised — when no DEM
      // is loaded yet we couldn't draw it anyway. After the user loads a
      // matching DEM and clicks Compute, the routes are regenerated.
    } else if (/\.jsonld?$|\.json$/i.test(file.name)) {
      md = JSON.parse(await file.text());
    } else {
      throw new Error("Unrecognised file — pass a .zip bundle or .jsonld.");
    }
    applyMetadataToUI(md, bin);
  } catch (err) {
    console.error(err);
    status.innerHTML = `<span style="color:#ff6b6b">Reload failed: ${err.message}</span>`;
  }
}

function applyMetadataToUI(md, bin = {}) {
  const p = md.params || {};
  const set = (id, v) => { const el = document.getElementById(id); if (el && v != null) el.value = v; };
  const check = (id, v) => { const el = document.getElementById(id); if (el && v != null) el.checked = !!v; };

  set("mode", p.mode);
  set("alpha", p.alpha);
  set("beta", p.beta);
  set("eta", p.eta);
  check("want-passes", p.wantPasses);
  check("want-topn", p.wantTopN);
  set("n-routes", p.nRoutes);
  set("penalty", p.penalty);
  set("repulsion-mode", p.repulsionMode);

  const v = md.viz || {};
  if (v.fieldColormap && COLORMAPS[v.fieldColormap]) {
    activeColormap = v.fieldColormap;
    const sel = document.getElementById("colormap"); if (sel) sel.value = v.fieldColormap;
    applyColormapToLegend();
  }
  if (v.routesColormap && COLORMAPS[v.routesColormap]) {
    set("routes-colormap", v.routesColormap);
  }
  if (v.energy) {
    set("vmin", v.energy.vmin);
    set("vmax", v.energy.vmax);
    set("energy-opacity", v.energy.opacity);
    check("energy-visible", v.energy.visible);
  }
  if (v.passes) {
    set("passes-vmin", v.passes.vmin);
    set("passes-vmax", v.passes.vmax);
    set("passes-opacity", v.passes.opacity);
    check("passes-visible", v.passes.visible);
    set("passes-blend", v.passes.blend);
  }
  if (v.tile) {
    set("tile-opacity", v.tile.opacity);
    check("tile-visible", v.tile.visible);
  }

  // Trigger any UI sync that depends on these (top-N reveal, etc.)
  const topnCheck = document.getElementById("want-topn");
  if (topnCheck) {
    const evt = new Event("change");
    topnCheck.dispatchEvent(evt);
  }

  // Restore src/dst pixel positions. If a DEM is loaded that matches the
  // bundle's DEM dimensions, place markers right away; otherwise hold the
  // values for when the DEM gets loaded.
  if (Array.isArray(p.src)) state.src = p.src.slice(0, 2);
  if (Array.isArray(p.dst)) state.dst = p.dst.slice(0, 2);

  function placeMarker(point, label) {
    if (!state.dem || !point) return null;
    const [r, c] = point;
    const { originX, originY, dx, dy } = state.dem;
    const latlng = L.latLng(originY - (r + 0.5) * dy, originX + (c + 0.5) * dx);
    return L.marker(latlng, { icon: makeSrcDstIcon(label === "Source" ? "src" : "dst") })
      .addTo(map).bindTooltip(label);
  }
  if (state.dem && state.src) {
    if (state.srcMarker) state.srcMarker.remove();
    state.srcMarker = placeMarker(state.src, "Source");
    document.getElementById("src-display").textContent = `r=${state.src[0]}, c=${state.src[1]}`;
    document.getElementById("src-display").classList.add("set");
  }
  if (state.dem && state.dst) {
    if (state.dstMarker) state.dstMarker.remove();
    state.dstMarker = placeMarker(state.dst, "Destination");
    document.getElementById("dst-display").textContent = `r=${state.dst[0]}, c=${state.dst[1]}`;
    document.getElementById("dst-display").classList.add("set");
  }

  applyLayerControls();
  estimateRunTime();

  // If we got the binary outputs back, render them straight away — no
  // recompute needed. Skip if the DEM dimensions don't match (or no DEM
  // is loaded yet).
  let restored = false;
  if (state.dem && bin.energy) {
    const N = state.dem.H * state.dem.W;
    if (bin.energy.length === N && (!bin.passes || bin.passes.length === N)) {
      const synth = {
        energy:      bin.energy,
        passes:      bin.passes || null,
        path:        null,
        pathEnergy:  md.stats?.pathEnergy ?? null,
        pathLengthM: md.stats?.pathLengthM ?? null,
        routes:      null,
        elapsedMs:   md.elapsedMs ?? 0,
      };
      renderResult(synth);
      restored = true;
    }
  }

  updateRunButtonState();
  if (restored) {
    status.textContent = "Bundle restored from cache. Click Compute to re-derive routes/path.";
  } else if (state.dem && state.src) {
    status.textContent = "Bundle parameters loaded. Click Compute to reproduce.";
  } else if (!state.dem) {
    const hint = md.dem?.sourceUrl ? ` (try ${md.dem.sourceUrl})` : "";
    status.innerHTML = `<span style="opacity:0.85">Bundle loaded. Now load the matching DEM${hint} and click Compute.</span>`;
  } else {
    status.textContent = "Bundle loaded. Click on the map to set source point.";
  }
}
