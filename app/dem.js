// DEM loading: file / URL / example DEMs, the FABDEM viewport loader,
// crop + downsample, loadDemFromArrayBuffer().
import "./dom.js"; // evaluation order — see ../app.js
import { smoothHeightsInPlace } from "../lib/dem-smoothing.js";
import { t } from "./i18n.js";
import { setGroupOpen, syncLoadedHighlights } from "./panel.js";
import { map } from "./map.js";
import { escapeHtml, state } from "./state.js";
import { cancelActiveCompute } from "./compute-source.js";
import { demFile, demMeta, progress, progressBar, resultMeta, status } from "./dom.js";
import { loadVectorNetwork } from "./network.js";
import { updateBridgeMeta } from "./bridges.js";
import {
  applyBridgeOverlay, clearVectorNetwork, rasterizeRingsToMask, reappendDrawnPortals,
  updateDrawMeta,
} from "./draw.js";
import {
  loadImpassableMaskFromFile, updateCorridorAvailability, updateImpassableMeta,
} from "./water.js";
import {
  kpiInvalidate, refHistoryReset, syncRefDisplay, updateRunButtonState,
} from "./points.js";
import {
  applyDemReliefOverlay, applyLayerControls, computeSlope, renderReliefToDataURL,
} from "./render.js";
import {
  estimateRunTime, formatCellSize, formatCoverage, startCalibrationProbe,
} from "./estimate.js";
import { writeRasterAsGeoTIFF } from "./geotiff.js";
import { applyMetadataToUI, bundleDemMatch } from "./bundle.js";

// ------- DEM loading -------
// Construct the rmsampa-v2 XYZ tile layer once. Add/remove on visibility
// toggle so we don't pay tile fetches when it's hidden.
export const RMSAMPA_URL = "https://telhas.pedalhidrografi.co/rmsampa-v2/{z}/{x}/{y}.png";
state.tileOverlay = L.tileLayer(RMSAMPA_URL, {
  // 21, above the map's z20 ceiling, because detectRetina (below) drops a layer's
  // maxZoom by 1 on HiDPI — at 19 that capped the layer at z18 and the hydrography
  // VANISHED when zoomed past it. 21→20 (retina) keeps it visible (upscaled from
  // z16) across the whole zoomable range.
  maxZoom: 21,
  // rmsampa-v2 only has tiles up to z16. With detectRetina (below) this Leaflet
  // build adds the +1 retina offset AFTER clamping to maxNativeZoom, so a flat
  // cap of 16 fetched z17 on HiDPI (404 → blank hydrography when zoomed in). On
  // retina cap at 15 so the +1 lands exactly on z16; on non-retina (no offset)
  // keep 16 so it still gets full z16 detail. Either way: crisp where real tiles
  // exist, upscaled (never 404) above it.
  maxNativeZoom: L.Browser.retina ? 15 : 16,
  // HiDPI/retina: fetch one zoom higher and draw at half size so the hydrography
  // is crisp instead of 2× upscaled+blurred (capped at z16 by maxNativeZoom 15).
  detectRetina: true,
  opacity: 0.85,
  // Keep the hydrography overlay ABOVE the basemap within the tile pane,
  // regardless of add order (the basemap is re-added on the persistence
  // refire AFTER this layer, which would otherwise bury it until toggled).
  zIndex: 10,
  attribution: 'pedalhidrografi.co',
});

demFile.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const gen = ++state.demLoadGen;
  status.textContent = t("status.loading_dem");
  try {
    const buf = await file.arrayBuffer();
    if (gen !== state.demLoadGen) return; // a newer DEM load started while we were reading — last click wins
    state.demSourceUrl = null;
    await loadDemFromArrayBuffer(buf, file.name, gen);
  } catch (err) {
    console.error(err);
    status.innerHTML = `<span style="color:#ff6b6b">${t("status.error_generic", escapeHtml(err.message))}</span>`;
  }
});

// Three example DEMs hosted alongside the rmsampa-v2 tiles. Wired below.
export const DEM_EXAMPLES = [
  { id: "ex-aguapreta", label: "Entorno da Água Preta", size: "instantâneo",
    url: "https://simujaules.pedalhidrografi.co/dem/sampa_aguapreta.tif" },
  { id: "ex-centro",    label: "Sampa Centro Expandido", size: "rápido",
    url: "https://simujaules.pedalhidrografi.co/dem/sampa_centro.tif" },
  { id: "ex-geral",     label: "Sampa Sítio Urbano",    size: "lento",
    url: "https://simujaules.pedalhidrografi.co/dem/sampa_geral.tif" },
];

export async function loadDemFromUrl(url, label) {
  const gen = ++state.demLoadGen;
  status.textContent = t("status.fetching", label);
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
    const buf = await resp.arrayBuffer();
    if (gen !== state.demLoadGen) return; // a newer DEM load started while we were fetching — last click wins
    state.demSourceUrl = url;
    await loadDemFromArrayBuffer(buf, label, gen);
  } catch (err) {
    console.error(err);
    status.innerHTML = `<span style="color:#ff6b6b">${t("status.error_generic", escapeHtml(err.message))}</span>`;
  }
}

// Cloud-hosted example datasets: fetch the file → hand it to the normal File
// loader (which gates on a loaded DEM and shows its own progress). Used by the
// "Viário RMSampa" (1B network) and water-mask (1C) example buttons.
export async function loadVectorFromUrl(url, label) {
  status.textContent = t("status.fetching", label);
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
    await loadVectorNetwork(new File([await resp.blob()], "sampa-viario.gpkg"));
  } catch (err) {
    console.error(err);
    status.innerHTML = `<span style="color:#ff6b6b">${t("status.gpkg_failed", escapeHtml(err.message))}</span>`;
  }
}
export async function loadImpassableFromUrl(url, label) {
  status.textContent = t("status.fetching", label);
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
    await loadImpassableMaskFromFile(new File([await resp.blob()], "water_mask.tif"));
  } catch (err) {
    console.error(err);
    status.innerHTML = `<span style="color:#ff6b6b">${t("status.error_generic", escapeHtml(err.message))}</span>`;
  }
}

// ------- FABDEM viewport loader -------
// Pulls FABDEM 1°×1° tiles that intersect the current map viewport,
// crops each to the visible extent, and stitches them into a single
// in-memory GeoTIFF that we hand to loadDemFromArrayBuffer. Tiles are
// COGs hosted at https://fabdem.pedalhidrografi.co/ (Cloudflare R2 —
// tiles at the ROOT, no /fabdem/ path segment; the old gs://telhas
// mirror is retired for FABDEM, though telhas still serves the rmsampa
// tiles and the viário FGBs) and named
// in the original Bristol convention `{LAT}{NS}{LON}{EW}_FABDEM_V1-2.tif`
// keyed by the SW corner. geotiff.js's fromUrl uses HTTP Range requests
// so we never download more than the visible cells (the FABDEM_MAX_BYTES
// cap is enforced as decompressed pixel-bytes, since that's what we
// allocate).
//
// CAUTION (bicycling-energy-model journal Entry 19): FABDEM is NOT adequate
// for energy work on flat/urban terrain. Its per-pixel noise inflates h₊ by
// +57% median (up to +135% on flat corpora), and v2Edge's per-grade ε
// amplifies that noise (pooled 17.6% vs 7.1% med |Δ%| against the validated
// local IGC 30 m survey). The IGC-SP DTM (loaded elsewhere in this app) is
// the load-bearing, validated source for São Paulo; treat FABDEM here as a
// convenience for terrain OUTSIDE that coverage, not a substitute for it.

const FABDEM_BASE_URL = "https://fabdem.pedalhidrografi.co/";
const FABDEM_TILE_DEG = 1;          // 1° per tile, keyed by SW corner
export const FABDEM_ARCSEC = 1 / 3600;     // ~30 m at the equator
// Teto da janela em graus² (v72: era 50 MB ≈ 1°²; agora 10°² a pedido —
// ~129,6 M células ≈ 494 MiB de Float32, na casa do teto honesto de RAM do
// app: um DEM de 135 M células roda a densidade com 1 worker em 16 GB).
// FGB_PULL_MAX_DEG2 deriva de FABDEM_MAX_BYTES, então os pulls FGB
// (viário/água/pontes) sobem pra 10°² junto.
const FABDEM_MAX_DEG2 = 10;
export const FABDEM_MAX_BYTES = (FABDEM_MAX_DEG2 / (FABDEM_ARCSEC * FABDEM_ARCSEC)) * 4;

function fabdemTileName(lat, lon) {
  // Naming convention used by this deploy: hemisphere prefix BEFORE digits,
  // e.g. S24W047_FABDEM_V1-2.tif for the tile keyed by SW corner -24, -47.
  const ns = lat >= 0 ? "N" : "S";
  const ew = lon >= 0 ? "E" : "W";
  return `${ns}${String(Math.abs(lat)).padStart(2, "0")}${ew}${String(Math.abs(lon)).padStart(3, "0")}_FABDEM_V1-2.tif`;
}

// Browser geolocation → pan the map to the user's coordinates without
// touching the zoom. The user typically frames their area before
// clicking, so we respect whatever zoom they're already at.
export function centerOnUserLocation() {
  // Trace point for the "nothing happens when I click" reports — a single
  // log here isolates click-routing problems from geolocation failures.
  console.info("[locate] click handler invoked");
  if (!navigator.geolocation) {
    status.innerHTML = `<span style="color:#ff6b6b">${t("locate.unsupported")}</span>`;
    return;
  }
  status.textContent = t("locate.requesting");
  const btn = document.getElementById("locate-btn");
  if (btn) btn.disabled = true;
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      if (btn) btn.disabled = false;
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      const acc = pos.coords.accuracy; // metres
      // Drop a marker + accuracy circle at the located point (replace any prior).
      if (state.locateMarker) { state.locateMarker.remove(); state.locateMarker = null; }
      if (state.locateCircle) { state.locateCircle.remove(); state.locateCircle = null; }
      state.locateMarker = L.circleMarker([lat, lng], {
        radius: 6, color: "#1f6fd0", weight: 2, fillColor: "#4ea3ff", fillOpacity: 0.9,
      }).addTo(map);
      if (Number.isFinite(acc) && acc > 0) {
        state.locateCircle = L.circle([lat, lng], {
          radius: acc, color: "#1f6fd0", weight: 1, fillColor: "#4ea3ff", fillOpacity: 0.12,
        }).addTo(map);
      }
      // panTo keeps the current zoom; setView would force a zoom change.
      map.panTo([lat, lng]);
      status.textContent = t("locate.centered", lat.toFixed(4), lng.toFixed(4));
    },
    (err) => {
      if (btn) btn.disabled = false;
      // err.code: 1 PERMISSION_DENIED, 2 POSITION_UNAVAILABLE, 3 TIMEOUT
      let key = "locate.error";
      if (err.code === 1) key = "locate.denied";
      else if (err.code === 2) key = "locate.unavailable";
      else if (err.code === 3) key = "locate.timeout";
      status.innerHTML = `<span style="color:#ff6b6b">${t(key)}</span>`;
    },
    { enableHighAccuracy: false, timeout: 15000, maximumAge: 60000 },
  );
}

export async function loadFabdemForView() {
  const gen = ++state.demLoadGen;
  if (!map) {
    status.innerHTML = `<span style="color:#ff6b6b">${t("status.map_not_ready")}</span>`;
    return;
  }
  const bounds = map.getBounds();
  const south = bounds.getSouth();
  const north = bounds.getNorth();
  const west  = bounds.getWest();
  const east  = bounds.getEast();
  if (!Number.isFinite(south) || north <= south || east <= west) {
    status.innerHTML = `<span style="color:#ff6b6b">${t("status.map_bounds_failed")}</span>`;
    return;
  }

  // Snap the output extent to FABDEM's 1-arcsec grid so the synthetic
  // GeoTIFF we hand off has integer-cell origin and dimensions.
  const outWest  = Math.floor(west  * 3600) / 3600;
  const outEast  = Math.ceil (east  * 3600) / 3600;
  const outSouth = Math.floor(south * 3600) / 3600;
  const outNorth = Math.ceil (north * 3600) / 3600;
  const outW = Math.round((outEast  - outWest)  * 3600);
  const outH = Math.round((outNorth - outSouth) * 3600);

  // Cap by allocated pixel-bytes (Float32) — FABDEM_MAX_DEG2 (10°²) worth of
  // 1-arcsec cells, ~129.6 M cells ≈ 494 MiB. Beyond that we ask the user to
  // zoom in.
  const estBytes = outW * outH * 4;
  if (estBytes > FABDEM_MAX_BYTES) {
    status.innerHTML =
      `<span style="color:#ff6b6b">${t("status.fabdem_too_large", (estBytes / 1024 / 1024).toFixed(0), outW, outH, Math.round(FABDEM_MAX_BYTES / 1024 / 1024))}</span>`;
    return;
  }

  // Enumerate 1° tiles whose SW corner lat ∈ [floor(south)..ceil(north)-1]
  // and lon ∈ [floor(west)..ceil(east)-1]. The tiny epsilon on the upper
  // bounds avoids fetching an extra tile when the viewport edge sits
  // exactly on an integer degree.
  const eps = 1e-9;
  const latLo = Math.floor(south);
  const latHi = Math.floor(north - eps);
  const lonLo = Math.floor(west);
  const lonHi = Math.floor(east - eps);
  const tileSpecs = [];
  for (let lat = latLo; lat <= latHi; lat++) {
    for (let lon = lonLo; lon <= lonHi; lon++) {
      tileSpecs.push({
        lat, lon,
        url: FABDEM_BASE_URL + fabdemTileName(lat, lon),
      });
    }
  }

  status.textContent = t("status.fabdem_fetching", tileSpecs.length);
  const fabBtn = document.getElementById("ex-fabdem-view");
  if (fabBtn) fabBtn.disabled = true;
  progress.classList.add("active");
  progressBar.style.width = "0%";

  try {
    // Open each tile (small IFD fetch only — geotiff.js doesn't pull pixels
    // until readRasters is called). 404s are common: oceans and polar
    // strips fall outside FABDEM coverage. We log and skip.
    const opened = [];
    for (let i = 0; i < tileSpecs.length; i++) {
      const tile = tileSpecs[i];
      try {
        const tiff = await GeoTIFF.fromUrl(tile.url);
        const image = await tiff.getImage();
        opened.push({ ...tile, image });
      } catch (e) {
        console.info(`[fabdem] skipping ${tile.url}: ${e.message}`);
      }
      progressBar.style.width = `${((i + 1) / tileSpecs.length * 30).toFixed(1)}%`;
    }

    if (!opened.length) {
      status.innerHTML =
        `<span style="color:#ff6b6b">${t("status.fabdem_none")}</span>`;
      return;
    }

    // Allocate the mosaic. NaN-fill so unwritten cells (gaps between tiles
    // or outside FABDEM coverage) read as nodata in the downstream mask
    // construction (Number.isFinite check in loadDemFromArrayBuffer).
    const mosaic = new Float32Array(outW * outH);
    mosaic.fill(NaN);

    // Read each tile's intersection with the viewport. readRasters({bbox})
    // fetches only the relevant strips/tiles within the COG over HTTP
    // Range requests — that's where the bandwidth saving comes from.
    let placed = 0; // tiles successfully read into the mosaic
    for (let i = 0; i < opened.length; i++) {
      const tile = opened[i];
      const tileSouth = tile.lat;
      const tileNorth = tile.lat + FABDEM_TILE_DEG;
      const tileWest  = tile.lon;
      const tileEast  = tile.lon + FABDEM_TILE_DEG;

      // Snap the intersection to the same arcsec grid as the mosaic so
      // pixel offsets line up exactly.
      const interWest  = Math.max(outWest,  tileWest);
      const interEast  = Math.min(outEast,  tileEast);
      const interSouth = Math.max(outSouth, tileSouth);
      const interNorth = Math.min(outNorth, tileNorth);
      if (interEast <= interWest || interNorth <= interSouth) continue;

      // A single tile's range-read can fail (transient network / partial COG);
      // skip just that tile instead of letting the whole mosaic abort.
      try {
      // Per-tile nodata sentinel — FABDEM uses GDAL_NODATA, varies by tile.
      // Math.fround rounds the sentinel through float32 to match the f32
      // widening the raster values below go through (same rationale as
      // loadDemFromArrayBuffer's mask build).
      const nodataRaw = tile.image.fileDirectory.getValue("GDAL_NODATA");
      const nodata = nodataRaw ? Math.fround(parseFloat(nodataRaw)) : null;

      // Convert the geographic intersection to a pixel window. NB:
      // image.readRasters({bbox}) does NOT exist on GeoTIFFImage — only
      // the top-level tiff.readRasters supports bbox. Passing it to the
      // image-level call silently falls back to "read full image", which
      // would blow the FABDEM_MAX_BYTES cap AND scramble the mosaic
      // placement below.
      // We compute the pixel window ourselves from the source's origin
      // and resolution so geotiff.js issues Range requests for just the
      // strips overlapping the viewport.
      const [oX, oY] = tile.image.getOrigin();
      const [rX, rY] = tile.image.getResolution(); // rX > 0 east, rY < 0 down
      const wnd = [
        Math.round((interWest  - oX) / rX),
        Math.round((interNorth - oY) / rY),
        Math.round((interEast  - oX) / rX),
        Math.round((interSouth - oY) / rY),
      ];
      const raster = await tile.image.readRasters({
        window: wnd,
        samples: [0], // FABDEM tiles are single-band — explicit for consistency with loadDemFromArrayBuffer
        interleave: true,
      });
      const rW = wnd[2] - wnd[0];
      const rH = wnd[3] - wnd[1];

      // Place into mosaic. Mosaic origin is (outWest, outNorth) at row 0,
      // col 0; rows count southward.
      const colOffset = Math.round((interWest - outWest)  * 3600);
      const rowOffset = Math.round((outNorth - interNorth) * 3600);
      for (let r = 0; r < rH; r++) {
        const mr = rowOffset + r;
        if (mr < 0 || mr >= outH) continue;
        for (let c = 0; c < rW; c++) {
          const mc = colOffset + c;
          if (mc < 0 || mc >= outW) continue;
          const v = raster[r * rW + c];
          if (Number.isFinite(v) && (nodata === null || v !== nodata)) {
            mosaic[mr * outW + mc] = v;
          }
        }
      }
      placed++;
      } catch (err) {
        console.warn(`[fabdem] tile ${fabdemTileName(tile.lat, tile.lon)} read failed — skipping:`, err);
      }
      progressBar.style.width = `${(30 + (i + 1) / opened.length * 70).toFixed(1)}%`;
      status.textContent = t("status.fabdem_mosaic", i + 1, opened.length);
    }
    if (placed === 0) {
      progress.classList.remove("active");
      status.innerHTML = `<span style="color:#ff6b6b">${t("status.fabdem_all_failed")}</span>`;
      return;
    }
    // Some (but not all) tiles failed to read — the mosaic still loads, but
    // with NaN gaps where those tiles should be. Surface that beyond the
    // console.warn above so the user doesn't mistake the gap for FABDEM
    // coverage.
    const failed = opened.length - placed;

    // Wrap the mosaic as a GeoTIFF in memory so loadDemFromArrayBuffer
    // can ingest it like any other DEM. Same writer we use for bundle
    // outputs — Float32, EPSG:4326, north-up.
    const tiffMd = {
      width:  outW,
      height: outH,
      BitsPerSample:    [32],
      SampleFormat:     [3],
      SamplesPerPixel:  [1],
      ModelPixelScale:  [FABDEM_ARCSEC, FABDEM_ARCSEC, 0],
      ModelTiepoint:    [0, 0, 0, outWest, outNorth, 0],
      GeographicTypeGeoKey: 4326,
      GTModelTypeGeoKey: 2,
      GTRasterTypeGeoKey: 1,
    };
    const buf = GeoTIFF.writeArrayBuffer(mosaic, tiffMd);

    if (gen !== state.demLoadGen) return; // a newer DEM load started while we were fetching/mosaicking — last click wins
    state.demSourceUrl = `FABDEM viewport ${outWest.toFixed(2)},${outSouth.toFixed(2)} → ${outEast.toFixed(2)},${outNorth.toFixed(2)} (${placed} tile${placed === 1 ? "" : "s"})`;
    await loadDemFromArrayBuffer(buf, `FABDEM ${outW}×${outH} (${placed} tile${placed === 1 ? "" : "s"})`, gen);
    if (failed > 0) {
      status.innerHTML = `<span style="color:#ff9d3d">${t("status.fabdem_partial", failed, opened.length)}</span>`;
    }
  } catch (err) {
    console.error(err);
    status.innerHTML = `<span style="color:#ff6b6b">${t("status.fabdem_failed", escapeHtml(err.message))}</span>`;
  } finally {
    progress.classList.remove("active");
    if (fabBtn) fabBtn.disabled = false;
  }
}

// Static DEM pre-smoothing (v55, journal Entry 20) — smoothHeightsInPlace lives
// in lib/dem-smoothing.js (shared with test-dem-smoothing.mjs and mcp/lib.mjs);
// it runs app-side at DEM load only, before heights ship to any engine.

// 1A — crop the loaded DEM to the current map viewport. Implemented as an
// in-memory export→reimport: writeRasterAsGeoTIFF on the sub-grid window, then
// the standard loadDemFromArrayBuffer path — so compute cancellation, the mask
// rebuild (GDAL_NODATA round-trip; nodata cells still hold the raw sentinel in
// state.dem.height), CRS GeoKeys, layer/graph invalidation, the calibration
// probe AND the smoothing tag guard (an already-smoothed DEM is not
// re-smoothed; the cumulative σ tag travels with the crop) are all inherited
// from the one battle-tested load path instead of re-implemented here.
export async function cropDemToViewport() {
  const dem = state.dem;
  if (!dem) { status.innerHTML = `<span style="color:#ff6b6b">${escapeHtml(t("io.no_dem"))}</span>`; return; }
  // The map (and this viewport read) is EPSG:4326-only — same guard as the
  // OSM pulls: on a projected DEM lon/lat would map to garbage cells.
  if (!dem.isGeographic) { status.innerHTML = `<span style="color:#ff6b6b">${escapeHtml(t("status.crop_need_geo"))}</span>`; return; }
  const b = map.getBounds();
  // Viewport ∩ DEM extent (degrees), then cell indices (row 0 = north edge).
  const west  = Math.max(b.getWest(),  dem.bbox.xmin);
  const east  = Math.min(b.getEast(),  dem.bbox.xmax);
  const north = Math.min(b.getNorth(), dem.bbox.ymax);
  const south = Math.max(b.getSouth(), dem.bbox.ymin);
  if (!(west < east && south < north)) { status.innerHTML = `<span style="color:#ff6b6b">${escapeHtml(t("status.crop_no_overlap"))}</span>`; return; }
  const c0 = Math.max(0, Math.floor((west - dem.originX) / dem.dx));
  const c1 = Math.min(dem.W, Math.ceil((east - dem.originX) / dem.dx));
  const r0 = Math.max(0, Math.floor((dem.originY - north) / dem.dy));
  const r1 = Math.min(dem.H, Math.ceil((dem.originY - south) / dem.dy));
  const Wc = c1 - c0, Hc = r1 - r0;
  if (Wc < 2 || Hc < 2) { status.innerHTML = `<span style="color:#ff6b6b">${escapeHtml(t("status.crop_too_small"))}</span>`; return; }
  if (Wc === dem.W && Hc === dem.H) { status.textContent = t("status.crop_noop"); return; }
  const vals = new Float32Array(Hc * Wc);
  for (let r = 0; r < Hc; r++) {
    const src = (r0 + r) * dem.W + c0;
    vals.set(dem.height.subarray(src, src + Wc), r * Wc);
  }
  const demLike = {
    H: Hc, W: Wc,
    dx: dem.dx, dy: dem.dy,
    originX: dem.originX + c0 * dem.dx,
    originY: dem.originY - r0 * dem.dy,
    isGeographic: dem.isGeographic,
    geoKeys: dem.geoKeys,
  };
  const extraMd = {};
  if (dem.nodata != null) extraMd.GDAL_NODATA = String(dem.nodata);
  if (dem.smoothCumSigmaM > 0) extraMd.ImageDescription = `simujaules:demSmoothSigmaM=${dem.smoothCumSigmaM}`;
  const label = t("dem.crop_label", state.demLabel || "DEM", Wc, Hc);
  const gen = ++state.demLoadGen;
  // A crop is a local derivation — the source URL (if any) describes the FULL
  // raster and would mislabel bundles made from the crop. Same convention as
  // the file-picker path.
  state.demSourceUrl = null;
  try {
    const buf = writeRasterAsGeoTIFF(vals, demLike, "float32", Object.keys(extraMd).length ? extraMd : undefined);
    await loadDemFromArrayBuffer(buf, label, gen);
  } catch (e) {
    status.innerHTML = `<span style="color:#ff6b6b">${escapeHtml(e.message)}</span>`;
  }
}

// 1A — downsample the loaded DEM by an integer factor via mask-aware N×N
// block averaging (each output cell = mean of its block's VALID cells; a
// block with none stays nodata). This is the same transform as
// `gdalwarp -r average` — on the 5 m IGC-SP rasters a 6× reduction lands at
// ~30 m, the regime where the v2 model is most accurate (journal Entries
// 19/21). Same export→reimport tail as cropDemToViewport, so the standard
// load path (mask rebuild, GeoKeys, invalidations, smoothing-tag guard)
// is inherited. Works on projected DEMs too (no viewport involved).
export async function downsampleDem(factor) {
  const dem = state.dem;
  if (!dem) { status.innerHTML = `<span style="color:#ff6b6b">${escapeHtml(t("io.no_dem"))}</span>`; return; }
  const N = Math.max(2, factor | 0);
  const W2 = Math.ceil(dem.W / N), H2 = Math.ceil(dem.H / N);
  if (W2 < 2 || H2 < 2) { status.innerHTML = `<span style="color:#ff6b6b">${escapeHtml(t("status.downsample_too_small", W2, H2))}</span>`; return; }
  status.textContent = t("status.downsampling", N);
  await new Promise((r) => setTimeout(r, 0)); // let the status line paint before the sync pass
  const vals = new Float32Array(H2 * W2);
  // Masked output cells get the source sentinel (loader rebuilds the mask from
  // GDAL_NODATA below) or NaN when the source had none (loader masks
  // non-finite values).
  const sentinel = dem.nodata != null ? dem.nodata : NaN;
  for (let R = 0; R < H2; R++) {
    const rmax = Math.min(dem.H, (R + 1) * N);
    for (let C = 0; C < W2; C++) {
      const cmax = Math.min(dem.W, (C + 1) * N);
      let sum = 0, n = 0;
      for (let r = R * N; r < rmax; r++) {
        const base = r * dem.W;
        for (let c = C * N; c < cmax; c++) {
          if (dem.mask[base + c]) { sum += dem.height[base + c]; n++; }
        }
      }
      vals[R * W2 + C] = n > 0 ? sum / n : sentinel;
    }
  }
  const demLike = {
    H: H2, W: W2,
    dx: dem.dx * N, dy: dem.dy * N,
    originX: dem.originX,
    originY: dem.originY,
    isGeographic: dem.isGeographic,
    geoKeys: dem.geoKeys,
  };
  const extraMd = {};
  if (dem.nodata != null) extraMd.GDAL_NODATA = String(dem.nodata);
  // The cumulative-smoothing tag travels (block averaging is a resampling,
  // not a Gaussian — the tag tracks σ only). Note the auto-smoothing rule
  // won't re-fire anyway once the pixel grows past 10 m.
  if (dem.smoothCumSigmaM > 0) extraMd.ImageDescription = `simujaules:demSmoothSigmaM=${dem.smoothCumSigmaM}`;
  const label = t("dem.downsample_label", state.demLabel || "DEM", N, W2, H2);
  const gen = ++state.demLoadGen;
  state.demSourceUrl = null; // local derivation, same convention as the crop
  try {
    const buf = writeRasterAsGeoTIFF(vals, demLike, "float32", Object.keys(extraMd).length ? extraMd : undefined);
    await loadDemFromArrayBuffer(buf, label, gen);
  } catch (e) {
    status.innerHTML = `<span style="color:#ff6b6b">${escapeHtml(e.message)}</span>`;
  }
}

export async function loadDemFromArrayBuffer(buf, label, gen) {
  // A compute still running against the previous DEM would render arrays
  // sized to the old H×W onto the new grid — kill it before anything else.
  cancelActiveCompute();
  status.textContent = t("status.loading_label", label);
  const tiff = await GeoTIFF.fromArrayBuffer(buf);
  const image = await tiff.getImage();
  const W = image.getWidth();
  const H = image.getHeight();
  // geotiff.js 3.x: getTiePoints() is async and fileDirectory is an
  // ImageFileDirectory object — values are read via getValue('TagName').
  const tiePoints = await image.getTiePoints();
  const fileDirectory = image.fileDirectory;
  const pixelScale = fileDirectory.getValue("ModelPixelScale");
  if (!pixelScale || !tiePoints?.length) {
    throw new Error(t("status.dem_no_geotransform"));
  }
  const dx = pixelScale[0];
  const dy = pixelScale[1];
  const originX = tiePoints[0].x;
  const originY = tiePoints[0].y;

  // Read elevation as Float32Array. samples: [0] selects band 0 explicitly —
  // without it, geotiff.js's interleave:true on a multi-band GeoTIFF (RGB
  // terrain render, elevation+mask stack, …) returns ALL bands pixel-
  // interleaved and this loader would silently read 1/k of the image's
  // bands smeared across the whole grid as "elevation".
  const raster = await image.readRasters({ samples: [0], interleave: true });
  const height = raster instanceof Float32Array ? raster : Float32Array.from(raster);

  // Build mask: anything finite and != nodata. Math.fround rounds the
  // sentinel through float32 BEFORE comparing — height[] is always the f64
  // widening of an f32 value, so an unrounded f64 parse of GDAL_NODATA can
  // silently fail to match the stored sentinel (e.g. a Float64 source whose
  // nodata isn't f32-representable, or a truncated-precision GDAL_NODATA
  // string), letting nodata cells slip through as "valid" elevations.
  const nodataRaw = fileDirectory.getValue("GDAL_NODATA");
  const nodata = nodataRaw ? Math.fround(parseFloat(nodataRaw)) : null;
  const mask = new Uint8Array(H * W);
  for (let i = 0; i < H * W; i++) {
    const v = height[i];
    mask[i] = (Number.isFinite(v) && (nodata === null || v !== nodata)) ? 1 : 0;
  }

  // Pull the source TIFF's GeoKeys up front: they declare the real CRS (so a
  // COARSE geographic DEM with dx ≥ 0.01° isn't mis-read as projected by the
  // magnitude heuristic), and they're also stamped onto exported GeoTIFFs.
  let geoKeys = null;
  try {
    geoKeys = image.getGeoKeys ? image.getGeoKeys() : null;
  } catch { /* getGeoKeys throws on some malformed tiffs — fine to skip */ }

  // The map, overlays and click-to-pick are EPSG:4326-only. Prefer the TIFF's
  // declared model type (GTModelTypeGeoKey: 1=projected, 2=geographic); fall
  // back to a coordinate-magnitude heuristic only when GeoKeys are absent.
  const modelType = geoKeys && geoKeys.GTModelTypeGeoKey;
  const isProbablyGeographic =
    modelType === 2 ? true
      : modelType === 1 ? false
      : (Math.abs(originX) < 360 && Math.abs(originY) < 90 && dx < 0.01);
  if (isProbablyGeographic) {
    status.innerHTML = `<span style="opacity:0.7">${t("status.dem_lonlat")}</span>`;
  }

  // Convert degrees → metres for geographic DEMs using a flat-earth
  // approximation centred on the DEM's middle latitude. For a 5–50 km
  // extent this is good to ~0.3%.
  const latRef = isProbablyGeographic ? originY - (H * dy) / 2 : 0;
  const dxM = isProbablyGeographic
    ? dx * 111320 * Math.cos((latRef * Math.PI) / 180)
    : dx;
  const dyM = isProbablyGeographic ? dy * 110574 : dy;

  // (geoKeys was read above, before CRS classification. It's stamped onto any
  // GeoTIFFs we export later — energy.tif / passes.tif / network.tif — so
  // projected DEMs round-trip with their real CRS, not a bare 4326.)

  // Re-check the caller's generation token HERE, right before the
  // point-of-no-return: every caller only checks ONCE, right after its own
  // fetch/read completes and before calling this function — but GeoTIFF
  // parsing above (fromArrayBuffer/getImage/getTiePoints/readRasters) is
  // itself async, so a SECOND, newer load can start and finish (bumping
  // state.demLoadGen) while an OLDER call is still in here. Without this,
  // whichever parse finishes last installs its DEM — last-FINISHER, not
  // last-CLICK — silently overwriting a newer, already-displayed DEM.
  if (gen !== undefined && gen !== state.demLoadGen) {
    status.textContent = t("status.load_superseded");
    return;
  }

  // Static pre-smoothing (v55, journal Entry 20; re-baselined v64 by
  // bicycling-energy-model Entry 74). "auto" applies σ = 30 m to EVERY
  // source — coarse ones (FABDEM 30 m) included: the Entry-74 ε contest
  // showed the deployed grade-local ε wins on σ30-treated chains on both
  // DTMs while raw chains invert the ordering (noise manufactures steep
  // micro-descents the grade-local policy refuses to credit), so the old
  // fine-only σ10 rule under-treated. The ImageDescription tag guard stays:
  // sources already smoothed (our own dem.tif exports carry the tag) are
  // skipped — guards double-smoothing on re-import. An explicit σ choice
  // overrides the guard. Runs AFTER the generation re-check so a superseded
  // load never burns the worst-case pass (~30 s at σ30 on 135 M cells).
  const imgDescRaw = fileDirectory.getValue ? fileDirectory.getValue("ImageDescription") : null;
  const srcSmoothSigmaM = parseFloat((String(imgDescRaw || "").match(/simujaules:demSmoothSigmaM=([0-9.]+)/) || [])[1]) || 0;
  const smoothSel = document.getElementById("dem-smooth")?.value ?? "auto";
  let smoothSigmaM = 0;
  if (smoothSel === "auto") {
    smoothSigmaM = (srcSmoothSigmaM > 0) ? 0 : 30;
  } else {
    smoothSigmaM = Math.max(0, parseFloat(smoothSel) || 0);
  }
  if (smoothSigmaM > 0) {
    status.textContent = t("status.dem_smoothing", smoothSigmaM);
    await new Promise((r) => setTimeout(r, 0)); // let the status line paint before the sync pass
    smoothHeightsInPlace(height, mask, H, W, dxM, dyM, smoothSigmaM);
  }

  // A new DEM invalidates the cached network graph (elevations changed).
  state.networkGraph = null; state.networkGraphToken = null;
  state.dem = {
    height, mask, H, W,
    dx, dy,                  // native CRS units (degrees for geographic)
    dxM, dyM,                // always metres — fed to the worker
    originX, originY,
    // bbox in DEM CRS units (degrees for geographic):
    bbox: { xmin: originX, ymin: originY - H * dy, xmax: originX + W * dx, ymax: originY },
    isGeographic: isProbablyGeographic,
    geoKeys,                 // for GeoTIFF round-trip on export
    nodata,                  // source GDAL_NODATA sentinel (f32-rounded), or null — re-emitted by exportDemTif so the round trip doesn't turn nodata cells into valid terrain
    smoothSigmaM,            // σ applied by THIS load (0 = none)
    // Cumulative smoothing across export/re-import cycles (Gaussians compose
    // in quadrature) — stamped into exported dem.tif's ImageDescription so the
    // auto rule never double-smooths a re-imported export.
    smoothCumSigmaM: Math.hypot(srcSmoothSigmaM, smoothSigmaM),
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

  // Clear any prior energy / passes / relief overlay + clicked points so
  // we don't leave stale visuals from the previous DEM hanging around.
  if (state.energyOverlay)     { state.energyOverlay.remove();     state.energyOverlay = null; }
  if (state.passesOverlay)     { state.passesOverlay.remove();     state.passesOverlay = null; }
  if (state.demReliefOverlay)  { state.demReliefOverlay.remove();  state.demReliefOverlay = null; }
  state.demSlope = null;
  state.demReliefDataUrl = null;
  if (state.pathLine)      { state.pathLine.remove();      state.pathLine = null; }
  if (state.routeLines)    { for (const ln of state.routeLines) ln.remove(); state.routeLines = []; }
  if (state.srcMarker)     { state.srcMarker.remove();     state.srcMarker = null; }
  if (state.dstMarker)     { state.dstMarker.remove();     state.dstMarker = null; }
  if (state.refMarkers && state.refMarkers.length) {
    for (const m of state.refMarkers) m.remove();
  }
  state.refMarkers = [];
  state.refPoints = [];
  state.qmcIndex = 0;
  state.refPopM = null;
  kpiInvalidate();
  refHistoryReset();   // snapshots index the OLD grid's cells
  state.src = null;
  state.dst = null;
  state.lastResult = null;
  // New DEM → previous calibration is meaningless; invalidate it and any
  // in-flight probe (gen bump) so the estimate shows "estimating…" until a
  // fresh probe lands.
  state.calibration = null;
  state.calibrationGen++;
  state.calibrationFailed = false;
  if (state.probeWorker) { state.probeWorker.terminate(); state.probeWorker = null; }
  // Drop any previously loaded vector network — its rasterised mask is
  // sized to the *previous* DEM's H×W and would corrupt the next compute
  // (or crash) if reused. The user re-uploads the .gpkg if they want it.
  // Drop the impassable mask + corridors BEFORE clearing the network: they're
  // sized to the previous DEM's grid, and clearVectorNetwork →
  // onNetworkCorridorsChanged would otherwise recalibrate against a stale,
  // wrong-sized mask. No dirty cascade — the loader already cancelled compute
  // and starts its own probe below.
  state.impassable = null;
  state.impassableRaster = null;
  state.impassableMeta = null;
  state.corridorCells = null; state.corridorBase = null; state.corridorRamp = null;
  state.corridorSet = null;
  state.osmWaterGeom = null; // grid-bound geometry is stale for a new DEM
  if (state.impassableOverlay) { state.impassableOverlay.remove(); state.impassableOverlay = null; }
  const impInputReset = document.getElementById("impassable-file");
  if (impInputReset) impInputReset.value = "";
  clearVectorNetwork();
  updateImpassableMeta();
  updateCorridorAvailability();
  // Bridges too — endA/endB are cell indices sized to the previous DEM's grid.
  state.bridges = null;
  state.bridgesMeta = null;
  if (state.bridgesLayer) { state.bridgesLayer.remove(); state.bridgesLayer = null; }
  updateBridgeMeta();
  syncRefDisplay();
  document.getElementById("src-display").textContent = t("pts.click_map");
  document.getElementById("dst-display").textContent = t("pts.optional");
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
    ${t("dem.meta_size", W, H, cellLabel)}<br/>
    ${t("dem.meta_origin", originLabel)}<br/>
    ${coverLabel}
  `;
  demMeta.removeAttribute("data-i18n"); // live content — don't let a lang toggle wipe it
  if (state.dem.isGeographic) {
    status.textContent = t("status.dem_loaded", label);
  } else {
    // Projected/unknown CRS: Leaflet is EPSG:4326-only, so the DEM can't be
    // placed on the map — overlays, click-to-pick and relief are all
    // unavailable (don't claim "click to set source"). Tell the user plainly.
    status.innerHTML = `<span style="color:#ff9d3d">${t("status.dem_projected", escapeHtml(label))}</span>`;
  }
  updateRunButtonState();
  syncLoadedHighlights(); // light up group 1A (and 1B was just cleared above)
  // Auto-expand: a fresh DEM opens the next input step (1B) + the compute setup.
  setGroupOpen("network-group", true);
  setGroupOpen("group-3", true);
  setGroupOpen("params-group", true);
  setGroupOpen("pick-points-group", true);
  setGroupOpen("execution-group", true);
  estimateRunTime();
  // Re-grid any drawn geometry against the new DEM (it may have been restored
  // from a config import before a DEM was loaded, or the DEM just changed).
  if ((state.drawnImpassable && state.drawnImpassable.length) ||
      (state.drawnPassable && state.drawnPassable.length) ||
      (state.drawnPortals && state.drawnPortals.length)) {
    state.drawnImpassableMask = rasterizeRingsToMask(state.drawnImpassable);
    state.drawnPassableMask = rasterizeRingsToMask(state.drawnPassable);
    state.bridges = (state.bridges || []).filter((b) => !b.drawn);
    reappendDrawnPortals();
    applyBridgeOverlay(); // the bridge layer was just cleared on DEM load — redraw drawn portal decks
    if (typeof updateDrawMeta === "function") updateDrawMeta();
  }

  // Build the cmocean.phase + slope hillshade for the new DEM. Renders
  // synchronously — for a 12 M-cell viewport (the FABDEM cap) this takes
  // about a second; the user already paid for the DEM load so the extra
  // delay is rolled into that. The relief overlay is wired into the
  // standard layer-controls; it stays hidden until the user toggles it.
  // Skip the (expensive) relief build on non-geographic DEMs — the
  // imageOverlay path is gated on isGeographic too, so we'd just be
  // burning a few seconds of slope/render compute and a 5–20 MB
  // PNG that never gets displayed.
  if (state.dem.isGeographic) {
    try {
      // Slope array is 4·H·W bytes — for a 135 M-cell DEM that's 540 MB.
      // We compute it, hand it to the renderer once, then drop the reference
      // immediately. The render output is a tiny PNG dataURL; the raw slope
      // grid is never read again unless the user reloads the DEM.
      const slopeArr = computeSlope(height, mask, H, W,
                                    state.dem.dxM, state.dem.dyM);
      state.demReliefDataUrl = renderReliefToDataURL(state.dem, slopeArr);
      state.demSlope = null;  // free the float buffer after render
      applyDemReliefOverlay();
    } catch (err) {
      console.warn("[relief] failed to build hillshade:", err);
      state.demSlope = null;
      state.demReliefDataUrl = null;
    }
  }
  // Reveal the layer-block now that the data exists.
  const reliefRow = document.getElementById("relief-row");
  if (reliefRow) reliefRow.style.display = state.demReliefDataUrl ? "" : "none";
  applyLayerControls();

  // Calibrate the compute-time estimate for this DEM (async, off-thread).
  startCalibrationProbe();

  // A bundle was loaded before this DEM (or against a mismatched one) and
  // is waiting in state.pendingBundle. If this DEM matches its grid,
  // re-apply it now — parameters, src/dst/ref markers, and the cached
  // rasters all come back without a recompute.
  if (state.pendingBundle) {
    const pb = state.pendingBundle;
    const bH = pb.md.dem?.H, bW = pb.md.dem?.W;
    // bundleDemMatch also checks the geotransform (not just H×W) — a
    // same-size DEM from a different tile must NOT replay the pending
    // bundle's binaries onto it (see the function's own comment).
    if (bundleDemMatch(pb.md.dem, state.dem) !== false) {
      state.pendingBundle = null; // applyMetadataToUI re-stashes only on mismatch
      applyMetadataToUI(pb.md, pb.bin);
    } else {
      status.innerHTML =
        `<span style="color:#ff9d3d">${t("status.bundle_dem_mismatch_pending", W, H, bW, bH)}</span>`;
    }
  }
}
