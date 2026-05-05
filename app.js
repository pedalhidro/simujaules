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
// Surface engine choice in the UI once the probe resolves.
wasmAvailable.then((ok) => {
  const el = document.getElementById("engine-tag");
  if (el) el.textContent = ok ? "wasm" : "js";
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
  energyOverlay: null,
  pathLine: null,
  srcMarker: null,
  dstMarker: null,
};

// ------- DEM loading -------
const demFile = document.getElementById("dem-file");
const demMeta = document.getElementById("dem-meta");
const status = document.getElementById("status");
const runBtn = document.getElementById("run");
const progress = document.getElementById("progress");
const progressBar = progress.querySelector(".bar");
const resultMeta = document.getElementById("result-meta");

demFile.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  status.textContent = "Loading DEM…";
  try {
    const buf = await file.arrayBuffer();
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
      status.innerHTML = '<span style="color:#ff6b6b">⚠ DEM appears to be in lon/lat. Reproject to UTM for accurate results.</span>';
    }

    state.dem = {
      height, mask, H, W, dx, dy,
      originX, originY,
      // bbox in DEM CRS units (assumed metres):
      bbox: { xmin: originX, ymin: originY - H * dy, xmax: originX + W * dx, ymax: originY },
      isGeographic: isProbablyGeographic,
    };

    // Centre the map on the DEM. If we don't have proj4 we can only do this
    // properly if the DEM is in lon/lat; for UTM we'd need to know the zone.
    // For UX we just print bounds and let the user pan.
    demMeta.innerHTML = `
      <span class="v">${W} × ${H}</span> cells, cell <span class="v">${dx.toFixed(1)} × ${dy.toFixed(1)}</span><br/>
      origin <span class="v">${originX.toFixed(1)}, ${originY.toFixed(1)}</span><br/>
      ${(W * dx / 1000).toFixed(1)} × ${(H * dy / 1000).toFixed(1)} km coverage
    `;
    status.textContent = "DEM loaded. Click on the map to set source point.";
    runBtn.disabled = !state.src;
  } catch (err) {
    console.error(err);
    status.innerHTML = `<span style="color:#ff6b6b">Error: ${err.message}</span>`;
  }
});

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
  if (!state.src) {
    state.src = px;
    if (state.srcMarker) state.srcMarker.remove();
    state.srcMarker = L.circleMarker(e.latlng, {
      radius: 8, color: "#4cc9f0", fillColor: "#4cc9f0", fillOpacity: 1,
    }).addTo(map).bindTooltip("Source");
    document.getElementById("src-display").textContent = `r=${r}, c=${c}`;
    document.getElementById("src-display").classList.add("set");
    status.textContent = "Source set. Click again to set destination, or run.";
    runBtn.disabled = false;
  } else if (!state.dst) {
    state.dst = px;
    if (state.dstMarker) state.dstMarker.remove();
    state.dstMarker = L.circleMarker(e.latlng, {
      radius: 8, color: "#ff8c42", fillColor: "#ff8c42", fillOpacity: 1,
    }).addTo(map).bindTooltip("Destination");
    document.getElementById("dst-display").textContent = `r=${r}, c=${c}`;
    document.getElementById("dst-display").classList.add("set");
    status.textContent = "Both points set. Run to compute.";
  } else {
    // Reset and start over
    state.src = px;
    state.dst = null;
    if (state.srcMarker) state.srcMarker.remove();
    if (state.dstMarker) state.dstMarker.remove();
    state.srcMarker = L.circleMarker(e.latlng, {
      radius: 8, color: "#4cc9f0", fillColor: "#4cc9f0", fillOpacity: 1,
    }).addTo(map).bindTooltip("Source");
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
  runBtn.disabled = true;
});

// ------- Run -------
runBtn.addEventListener("click", async () => {
  if (!state.dem || !state.src) return;

  const mode = document.getElementById("mode").value;
  const alpha = parseFloat(document.getElementById("alpha").value);
  const beta = parseFloat(document.getElementById("beta").value);
  const eta = parseFloat(document.getElementById("eta").value);

  // Tear down old worker if any (we can't re-use after transferred buffers)
  if (state.worker) state.worker.terminate();

  const useWasm = await wasmAvailable;
  state.worker = useWasm
    ? new Worker(WASM_WORKER_URL, { type: "module" })
    : new Worker(JS_WORKER_URL);
  state.engine = useWasm ? "wasm" : "js";

  status.textContent = "Computing…";
  progress.classList.add("active");
  progressBar.style.width = "0%";
  runBtn.disabled = true;

  state.worker.onmessage = (ev) => {
    const m = ev.data;
    if (m.kind === "progress") {
      progressBar.style.width = `${Math.min(100, m.progress * 100).toFixed(1)}%`;
    } else if (m.kind === "done") {
      progress.classList.remove("active");
      runBtn.disabled = false;
      renderResult(m);
      status.textContent = `Done in ${m.elapsedMs.toFixed(0)} ms (${state.engine}).`;
    } else if (m.kind === "error") {
      progress.classList.remove("active");
      runBtn.disabled = false;
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
      dx: state.dem.dx,
      dy: state.dem.dy,
      seedR: state.src[0],
      seedC: state.src[1],
      goalR: state.dst ? state.dst[0] : -1,
      goalC: state.dst ? state.dst[1] : -1,
      mode, alpha, beta, eta,
    },
    [heightCopy.buffer, maskCopy.buffer]
  );
});

// ------- Render -------
function renderResult({ energy, path, pathEnergy, pathLengthM, elapsedMs }) {
  const { H, W, originX, originY, dx, dy, isGeographic } = state.dem;

  // Find finite max for colour scaling
  let maxE = 0;
  for (let i = 0; i < energy.length; i++) {
    const v = energy[i];
    if (Number.isFinite(v) && v > maxE) maxE = v;
  }
  if (maxE === 0) maxE = 1;

  // Build a canvas with the magma-coloured energy field
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(W, H);
  for (let i = 0; i < H * W; i++) {
    const v = energy[i];
    if (!Number.isFinite(v)) {
      img.data[4 * i + 3] = 0; // transparent
    } else {
      const t = Math.sqrt(v / maxE); // sqrt-stretch — energy fields are very long-tailed
      const [r, g, b] = magma(t);
      img.data[4 * i + 0] = r;
      img.data[4 * i + 1] = g;
      img.data[4 * i + 2] = b;
      img.data[4 * i + 3] = 200;
    }
  }
  ctx.putImageData(img, 0, 0);
  const dataUrl = canvas.toDataURL();

  // Place the canvas as an image overlay
  if (state.energyOverlay) state.energyOverlay.remove();
  if (isGeographic) {
    const bounds = [
      [originY - H * dy, originX],
      [originY, originX + W * dx],
    ];
    state.energyOverlay = L.imageOverlay(dataUrl, bounds, { opacity: 0.85 }).addTo(map);
  }

  // Path overlay
  if (state.pathLine) state.pathLine.remove();
  if (path && path.length > 0 && isGeographic) {
    const latlngs = path.map((idx) => {
      const r = (idx / W) | 0;
      const c = idx - r * W;
      return [originY - (r + 0.5) * dy, originX + (c + 0.5) * dx];
    });
    state.pathLine = L.polyline(latlngs, {
      color: "#4cc9f0", weight: 4, opacity: 0.95,
    }).addTo(map);
  }

  // Result panel
  const meta = [];
  meta.push(`max E: <span class="v">${maxE.toExponential(2)}</span>`);
  meta.push(`time: <span class="v">${elapsedMs.toFixed(0)} ms</span>`);
  if (pathEnergy != null) {
    meta.push(`path E: <span class="v">${pathEnergy.toExponential(3)}</span>`);
    meta.push(`length: <span class="v">${(pathLengthM / 1000).toFixed(2)} km</span>`);
  }
  resultMeta.innerHTML = meta.join("<br/>");
}

// ------- Magma colormap (compact lookup) -------
// 256 stops sampled from matplotlib's magma; condensed to 17 anchor points.
const MAGMA_ANCHORS = [
  [0, 0, 4], [16, 11, 47], [38, 16, 92], [66, 13, 117], [93, 23, 124],
  [117, 36, 124], [142, 47, 119], [168, 58, 110], [195, 70, 99], [220, 84, 86],
  [240, 105, 75], [251, 138, 81], [254, 171, 96], [254, 203, 116], [253, 234, 145],
  [252, 253, 191], [255, 255, 220],
];
function magma(t) {
  t = Math.max(0, Math.min(1, t));
  const n = MAGMA_ANCHORS.length - 1;
  const f = t * n;
  const i = Math.floor(f);
  const frac = f - i;
  const a = MAGMA_ANCHORS[Math.min(i, n)];
  const b = MAGMA_ANCHORS[Math.min(i + 1, n)];
  return [
    Math.round(a[0] + (b[0] - a[0]) * frac),
    Math.round(a[1] + (b[1] - a[1]) * frac),
    Math.round(a[2] + (b[2] - a[2]) * frac),
  ];
}
