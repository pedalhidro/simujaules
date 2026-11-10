// Bundle export/import: metadata.jsonld, route GeoJSON, rendered images,
// downloadBundle(), loadBundleFile(), applyMetadataToUI().
import "./grid.js"; // evaluation order — see ../app.js
import { t } from "./i18n.js";
import { applyConfig, collectConfig, setGroupOpen } from "./panel.js";
import { map } from "./map.js";
import { escapeHtml, state } from "./state.js";
import { cancelActiveCompute } from "./compute-source.js";
import { status } from "./dom.js";
import { RMSAMPA_URL } from "./dem.js";
import { installBridgesFromWays } from "./bridges.js";
import { bridgeOverlayOpacity, bridgesToFC } from "./draw.js";
import { updateCorridorAvailability, updateImpassableMeta } from "./water.js";
import {
  networkLineOpacity, networkLineWidthM, updateNetworkLineStyle,
} from "./network-view.js";
import { graphJunctionMode } from "./graph-mode.js";
import {
  addRefPoint, makeSrcDstIcon, refHistoryPush, refHistorySettle, syncRefDisplay,
  updateRunButtonState,
} from "./points.js";
import { renderResult } from "./run.js";
import {
  applyImpassableOverlay, applyLayerControls, impassableOverlayOpacity, overlayCanvasDims,
  readRangeInput,
} from "./render.js";
import { estimateRunTime } from "./estimate.js";
import {
  COLORMAPS, activeColormap, applyColormapToLegend, setActiveColormap,
} from "./colormaps.js";
import { readRasterFromGeoTIFF, writeRasterAsGeoTIFF } from "./geotiff.js";
import {
  bridgesEnabled, corridorOffsetMetres, impassableEnabled, recomputeCorridors,
} from "./grid.js";

// ------- Bundle download / reload -------
// `metadata.jsonld` captures everything needed to reproduce the run from the
// same DEM: timestamps, engine, all compute parameters, source/destination
// pixel coordinates, and the visualisation knobs. Output rasters are written
// as GeoTIFFs (energy.tif / passes.tif / network.tif) so they drop straight
// into QGIS without needing the metadata to interpret them. Routes and the
// path are GeoJSON. JSON-LD `@context` is inlined so the file is self-
// describing without a network fetch.

// Vocab IRI deliberately points at the actual deployed file rather than an
// abstract namespace. Trade-off: bundles tie themselves to this serving URL,
// but in exchange the @vocab term resolves to a real document instead of a
// 404. If you ever move the deploy, set up a redirect from this URL or bump
// schemaVersion + ship a migration that rewrites the context.
const SIMU_CONTEXT = {
  "@vocab": "https://telhas.pedalhidrografi.co/simujoules/vocab/simujoules.jsonld#",
  "schema": "https://schema.org/",
  "geo": "http://www.opengis.net/ont/geosparql#",
  "qudt": "http://qudt.org/schema/qudt/",
};

function pixelToLonLat(idx, dem) {
  const r = (idx / dem.W) | 0;
  const c = idx - r * dem.W;
  return [dem.originX + (c + 0.5) * dem.dx, dem.originY - (r + 0.5) * dem.dy];
}

// Exact inverse of pixelToLonLat — recover the cell index from a [lon,lat]
// pair. Only safe when the DEM matches the one the coords were written
// against (callers gate on bundleDemMatch(...) === true, below — dims AND
// georeferencing, not just H×W). Used to rebuild the route/path index
// arrays from a bundle's GeoJSON on reload, so restored lines render and
// recolor identically to a fresh compute.
function lonLatToPixel(lon, lat, dem) {
  const c = Math.round((lon - dem.originX) / dem.dx - 0.5);
  const r = Math.round((dem.originY - lat) / dem.dy - 0.5);
  return r * dem.W + c;
}

// Combined dims+georeferencing check for bundle binary replay (rasters,
// routes/path conversion via lonLatToPixel above, src/dst/ref markers,
// network/impassable masks, bridges). Same H×W is NOT enough to prove a
// bundle's DEM is the loaded DEM — many DEM products (e.g. all 1° SRTM/
// FABDEM tiles) share pixel dimensions while covering a different area, so
// a dims-only gate would silently stretch tile-A rasters over tile-B's
// extent. Returns true (safe to replay), false (mismatch — dims OR
// georeferencing differ), or null (unknown: no DEM loaded yet, or mdDem
// lacks dims — old-bundle behaviour is preserved as "unknown", not "false").
export function bundleDemMatch(mdDem, dem) {
  if (!dem || !mdDem) return null;
  const { H, W } = mdDem;
  if (!Number.isFinite(H) || !Number.isFinite(W)) return null;
  if (dem.H !== H || dem.W !== W) return false;
  // Dims match — also compare the geotransform when the bundle recorded one
  // (older bundles predate dem.originX/originY/dx/dy — treat as unknown
  // extent there, i.e. dims-only, same as before this check existed).
  const { originX, originY, dx, dy } = mdDem;
  if (![originX, originY, dx, dy].every(Number.isFinite)) return true;
  return (
    Math.abs(originX - dem.originX) <= 0.5 * dem.dx &&
    Math.abs(originY - dem.originY) <= 0.5 * dem.dy &&
    Math.abs(dx - dem.dx) <= 1e-6 * dem.dx &&
    Math.abs(dy - dem.dy) <= 1e-6 * dem.dy
  );
}

// Rebuild a top-N `routes` list ({path, energy, length, shared}) from the
// routes.geojson FeatureCollection a bundle was exported with.
function routesFromFC(fc, dem) {
  if (!fc || !Array.isArray(fc.features)) return null;
  const routes = fc.features
    .filter((f) => f.geometry?.type === "LineString")
    .map((f) => {
      const p = f.properties || {};
      return {
        path:   f.geometry.coordinates.map(([lon, lat]) => lonLatToPixel(lon, lat, dem)),
        energy: p.energy ?? 0,
        length: p.length_m ?? 0,
        shared: p.shared_cells ?? 0,
      };
    });
  // Features are written in rank order (routesFCFromList), so the array is
  // already ordered best-first — no re-sort needed.
  return routes.length ? routes : null;
}

// Rebuild a `path` index array from a path GeoJSON (path.geojson or its
// compare-partner twin).
function pathFromFC(fc, dem) {
  const feat = fc?.features?.find((f) => f.geometry?.type === "LineString");
  if (!feat) return null;
  return feat.geometry.coordinates.map(([lon, lat]) => lonLatToPixel(lon, lat, dem));
}

// direction documents the relationship between the LineString's coordinate
// order (always written reference/source → destination, in A*-search order)
// and the direction the energy was actually scored in. Mode "to" scores
// destination→reference (energy-worker.js's reverse:true branch), so its
// routes/paths are the one case where coordinate order and travel direction
// disagree — external consumers (QGIS, scripts) reading the geometry in
// coordinate order would otherwise silently attribute the energy to the
// wrong direction.
function routeDirectionLabel(mode) {
  return mode === "to"
    ? "destination→source (energy direction; coordinates written source→destination)"
    : "source→destination";
}

function pathFCFromIndices(path, dem, props = {}, mode) {
  const coords = path.map((i) => pixelToLonLat(i, dem));
  return {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      geometry: { type: "LineString", coordinates: coords },
      properties: { ...props, direction: routeDirectionLabel(mode) },
    }],
  };
}

function routesFCFromList(routes, dem, mode) {
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
        direction: routeDirectionLabel(mode),
      },
    })),
  };
}

// Graph-mode result → GeoJSON FeatureCollection (one LineString per edge with
// passes/energy/length). Node coords are fractional cells → [lng,lat] via the
// raw inverse (no +0.5; matches cellFracToLatLng).
function graphEdgesFC(graph, result, dem) {
  const lonlat = (r, c) => [dem.originX + c * dem.dx, dem.originY - r * dem.dy];
  const passes = result.edgePasses, energy = result.edgeEnergy;
  return {
    type: "FeatureCollection",
    features: Array.from({ length: graph.nEdges }, (_, e) => ({
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: [
          lonlat(graph.nodeR[graph.edgeA[e]], graph.nodeC[graph.edgeA[e]]),
          lonlat(graph.nodeR[graph.edgeB[e]], graph.nodeC[graph.edgeB[e]]),
        ],
      },
      properties: {
        passes: passes ? passes[e] : 0,
        energy: energy && Number.isFinite(energy[e]) ? energy[e] : null,
        length_m: graph.edgeLenM[e],
      },
    })),
  };
}

function buildMetadata(result, withOutputs = true) {
  const dem = state.dem;
  const params = {
    mode:          document.getElementById("mode")?.value,
    // v2 physics inputs (the cost bundle is derived from these — see readCost).
    mass:          parseFloat(document.getElementById("mass")?.value),
    crr:           parseFloat(document.getElementById("crr")?.value),
    cda:           parseFloat(document.getElementById("cda")?.value),
    rho:           parseFloat(document.getElementById("rho")?.value),
    keff:          parseFloat(document.getElementById("keff")?.value),
    pFlat:         parseFloat(document.getElementById("pflat")?.value),
    kSmooth:       parseFloat(document.getElementById("ksmooth")?.value),
    deadbandM:     parseFloat(document.getElementById("deadband")?.value),
    // DEM pre-smoothing (v55): the knob setting AND the σ actually applied to
    // the loaded DEM (0 = none) — replay disclosure; results were computed on
    // the smoothed surface, and the auto rule is deterministic per DEM+knob.
    demSmooth:     document.getElementById("dem-smooth")?.value ?? "auto",
    demSmoothAppliedSigmaM: state.dem?.smoothSigmaM ?? 0,
    climbThr:      parseFloat(document.getElementById("climb-thr")?.value) / 100,
    eMax:          parseFloat(document.getElementById("e-max")?.value) || 0,
    eMaxMode:      document.getElementById("e-max-mode")?.value || "leg",
    src:           state.src,
    dst:           state.dst,
    // Sempre true desde o v68 (checkbox removido) — mantido no bundle para
    // que versões antigas do app importem com o checkbox marcado.
    wantPasses:    true,
    wantTopN:      !!document.getElementById("want-topn")?.checked,
    nRoutes:       parseInt(document.getElementById("n-routes")?.value, 10) || 3,
    penalty:       parseFloat(document.getElementById("penalty")?.value) || 2.0,
    repulsionMode: document.getElementById("repulsion-mode")?.value || "per-cell",
    wantDensity:   !!document.getElementById("want-density")?.checked,
    nRefs:         parseInt(document.getElementById("n-refs")?.value, 10) || 10,
    refSource:     document.getElementById("ref-sampling")?.value || "random",
    // The engines still implement maximize, but the app never asks for it —
    // kept as constants so the bundle schema is unchanged.
    maximize:      false,
    maximizeLength: 0,
    nDirs:         parseInt(document.getElementById("n-dirs")?.value, 10) || 8,
    stringPull:    !!document.getElementById("string-pull")?.checked,
    kpiCorr:       parseFloat(document.getElementById("kpi-corr")?.value) || 1,
    // refPoints carries the actual placed points so reload can re-stamp
    // the green markers exactly where they were.
    refPoints:     Array.isArray(state.refPoints) ? state.refPoints.slice() : [],
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
      vmin:       readRangeInput("passes-vmin", null),
      vmax:       readRangeInput("passes-vmax", null),
      opacity:    parseFloat(document.getElementById("passes-opacity")?.value),
      visible:    !!document.getElementById("passes-visible")?.checked,
      blend:      document.getElementById("passes-blend")?.value || "plus-lighter",
      gamma:      parseFloat(document.getElementById("passes-gamma")?.value),
      meanWindow: parseInt(document.getElementById("passes-mean-window")?.value, 10) || 1,
    },
    tile: {
      url:     RMSAMPA_URL,
      opacity: parseFloat(document.getElementById("tile-opacity")?.value),
      visible: !!document.getElementById("tile-visible")?.checked,
    },
    relief: {
      opacity: parseFloat(document.getElementById("relief-opacity")?.value),
      visible: !!document.getElementById("relief-visible")?.checked,
    },
  };
  // Vector network constraint, if loaded. The actual rasterised mask is
  // saved separately as `network.bin` (see downloadBundle).
  const network = {
    enabled:           !!state.networkMask,
    constrain:         !!document.getElementById("vec-constrain")?.checked,
    compare:           !!document.getElementById("vec-compare")?.checked,
    graphMode:         !!document.getElementById("vec-graph-mode")?.checked,
    junctionMode:      graphJunctionMode(),
    srsId:             state.networkSrsId || null,
    featureCount:      state.networkFeatureCount || 0,
    lineWidth:         parseInt(document.getElementById("vec-width")?.value, 10) || 1,
    snapRadius:        parseInt(document.getElementById("vec-snap")?.value, 10) || 10,
    renderWidthM:      networkLineWidthM(),
    renderOpacity:     networkLineOpacity(),
    wantInterp:        !!document.getElementById("net-interp")?.checked,
    interpMaxDistance: parseInt(document.getElementById("net-interp-max-dist")?.value, 10) || 50,
    interpSmoothing:   parseInt(document.getElementById("net-interp-smoothing")?.value, 10) || 0,
  };
  // Impassable mask + bridge-corridor settings (the resampled mask raster is
  // saved separately as impassable.tif — see downloadBundle).
  const impassable = {
    enabled:          !!state.impassable,
    apply:            impassableEnabled(),
    corridorOverride: !!document.getElementById("imp-corridor")?.checked,
    elevationOffset:  corridorOffsetMetres(),
    invert:           !!document.getElementById("impassable-invert")?.checked,
    show:             !!document.getElementById("imp-show")?.checked,
    opacity:          impassableOverlayOpacity(),
    sourceName:       state.impassableMeta?.name || null,
    srcWidth:         state.impassableMeta?.width || null,
    srcHeight:        state.impassableMeta?.height || null,
    srs:              state.impassableMeta?.srs || null,
    cells:            state.impassableMeta?.cellsImpassable || 0,
  };
  // OSM bridges & tunnels (geometry saved separately as bridges.geojson).
  const bridges = {
    enabled:  !!(state.bridges && state.bridges.length),
    apply:    bridgesEnabled(),
    count:    state.bridges ? state.bridges.length : 0,
    source:   state.bridgesMeta?.source || null,
    tunnels:  !!document.getElementById("bridge-tunnels")?.checked,
    show:     !!document.getElementById("bridge-show")?.checked,
    opacity:  bridgeOverlayOpacity(),
  };

  const md = {
    "@context":           SIMU_CONTEXT,
    "@type":              "EnergyFieldComputation",
    "schema:dateCreated": new Date().toISOString(),
    timestamp:            new Date().toISOString(),
    // schemaVersion 3: outputs are GeoTIFFs (energy.tif/passes.tif/network.tif)
    // instead of raw .bin dumps, so the unzipped bundle drops directly into
    // QGIS. v2 bundles with .bin still load — see loadBundleFile fallback.
    schemaVersion:        3,
    // engine is always "js" now (wasm removed). Kept in the metadata for
    // round-trip compatibility with older bundle readers.
    engine:               "js",
    // Full control state (every persisted toggle/value + layer order, compute
    // source, max-workers, language) so a bundle round-trips the WHOLE UI, not
    // just the params/viz subset below. applyMetadataToUI applies it first.
    // forBundle:true strips connection settings (backend/orchestrator URL,
    // cloud-keep-warm) and computeSource — a shared bundle must not leak the
    // exporter's endpoints or repoint the importer's compute source.
    config:               collectConfig({ forBundle: true }),
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
    network,
    impassable,
    bridges,
    stats: {
      maxE:        state.lastAutoMax ?? null,
      maxPasses:   state.lastPassesAutoMax ?? null,
      pathEnergy:  result?.pathEnergy ?? null,
      pathLengthM: result?.pathLengthM ?? null,
      pathAltEnergy:  result?.pathAltEnergy ?? null,
      pathAltLengthM: result?.pathAltLengthM ?? null,
    },
  };

  if (withOutputs) {
    // Each raster output is a GeoTIFF — same CRS / extent / pixel grid as
    // the source DEM, so QGIS can stack them on top without reprojection.
    // The "type" hint encodes the pixel datatype so the loader knows which
    // typed array to read into; "format" disambiguates from older v2 .bin.
    // network/impassable/bridges reflect state (not the grid `result`) and
    // are unconditionally present here — a graph-mode bundle's zip carries
    // them too (downloadBundle), so they must not be gated on `result` or a
    // null-result (graph) call would wrongly drop their descriptors.
    md.outputs = {
      network: state.networkMask ? {
        format: "GeoTIFF",
        type:   "Uint8",
        shape:  [dem.H, dem.W],
        file:   "network.tif",
      } : null,
      impassable: state.impassable ? {
        format: "GeoTIFF",
        type:   "Uint8",
        shape:  [dem.H, dem.W],
        file:   "impassable.tif",
      } : null,
      bridges: (state.bridges && state.bridges.length) ? {
        format: "GeoJSON",
        file:   "bridges.geojson",
      } : null,
    };
    // The rest describe grid-compute outputs — gate the whole set on
    // `result` so the metadata never claims a file the zip omits (a caller
    // passing result:null, e.g. downloadBundle in graph mode, gets none of
    // these; the zip writers there are gated on !graphMode too).
    if (result) {
      md.outputs.energy = result.energy ? {
        format: "GeoTIFF",
        type:   "Float32",
        shape:  [dem.H, dem.W],
        file:   "energy.tif",
      } : null;
      md.outputs.passes = result.passes ? {
        format: "GeoTIFF",
        type:   "Float64",
        shape:  [dem.H, dem.W],
        file:   "passes.tif",
      } : null;
      // Alternate ("compare with the unconstrained / no-network") scenario: the
      // unconstrained energy + passes and the precomputed (network-masked, interp-
      // filled) difference field — what the difference/unconstrained views render.
      // Only the GRID compare path writes these (graph-mode alt lives on
      // state.lastGraphResult, not exported yet) — kept as a redundant guard,
      // harmless now that the caller already passes result:null for graph mode.
      md.outputs.energyUnconstrained = (!state.lastGraphResult && result.energyAlt?.unconstrained) ? {
        format: "GeoTIFF", type: "Float32", shape: [dem.H, dem.W], file: "energy_unconstrained.tif",
      } : null;
      md.outputs.energyDifference = (!state.lastGraphResult && result.energyAlt?.difference) ? {
        format: "GeoTIFF", type: "Float32", shape: [dem.H, dem.W], file: "energy_difference.tif",
      } : null;
      md.outputs.passesUnconstrained = (!state.lastGraphResult && result.passesAlt?.unconstrained) ? {
        format: "GeoTIFF", type: "Float64", shape: [dem.H, dem.W], file: "passes_unconstrained.tif",
      } : null;
      md.outputs.routes = result.routes && result.routes.length ? {
        format: "GeoJSON",
        file:   "routes.geojson",
      } : null;
      md.outputs.path = result.path && result.path.length ? {
        format: "GeoJSON",
        file:   "path.geojson",
      } : null;
      md.outputs.pathAlt = result.pathAlt && result.pathAlt.length ? {
        format: "GeoJSON",
        file:   "path_alt.geojson",
      } : null;
    }
  }
  return md;
}

// Export the already-rendered energy / passes PNGs (colormap, range, gamma
// and mean filter baked in — byte-identical to what the map overlays show)
// as a zip with ESRI world files (.pgw) + .prj, so they drop into QGIS
// georeferenced. Complements the bundle export, which carries the RAW
// fields as GeoTIFFs.
//
// Deliberately excluded: the relief render (stride-downsampled on huge
// DEMs, so the DEM's dx/dy world file would be wrong for it), and CSS
// blend effects (plus-lighter etc. happen at compositing time in the
// browser, not in the PNG — the "energy color" passes mode IS baked in,
// since that one is painted into the canvas).
export const WGS84_WKT =
  'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],' +
  'PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433],AUTHORITY["EPSG","4326"]]';

export async function exportRenderedImages() {
  try {
    if (!state.dem || (!state.lastResult && !state.lastGraphResult)) {
      status.textContent = t("status.nothing_rendered");
      return;
    }
    const items = [];
    if (state.energyDataUrl) items.push(["energy_rendered", state.energyDataUrl]);
    if (state.passesDataUrl) items.push(["passes_rendered", state.passesDataUrl]);
    if (!items.length) {
      status.textContent = t("status.no_layers_export");
      return;
    }
    if (typeof JSZip === "undefined") throw new Error("JSZip didn't load");

    const { dx, dy, originX, originY, isGeographic } = state.dem;
    // World file: pixel size, rotation terms, centre of the top-left pixel.
    // The dataURLs come from renderFieldToDataURL/renderDualPassesToDataURL,
    // which stride-downsample the canvas via overlayCanvasDims above
    // RELIEF_MAX_CANVAS_PX cells — the world file must use the same strided
    // pixel size or the exported PNG is mis-georeferenced on huge DEMs.
    const { stride } = overlayCanvasDims(state.dem.W, state.dem.H);
    const sdx = dx * stride;
    const sdy = dy * stride;
    const worldFile =
      `${sdx}\n0\n0\n${-sdy}\n${originX + sdx / 2}\n${originY - sdy / 2}\n`;

    const zip = new JSZip();
    for (const [name, url] of items) {
      zip.file(`${name}.png`, url.split(",")[1], { base64: true });
      zip.file(`${name}.pgw`, worldFile);
      // Only stamp a CRS we actually know. Projected DEMs still get the
      // world file (correct pixel grid); assign the CRS manually in QGIS.
      if (isGeographic) zip.file(`${name}.prj`, WGS84_WKT);
    }

    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const ts = new Date().toISOString().replace(/[:.]/g, "-").replace(/-Z?$/, "");
    const slug = state.demLabel
      ? state.demLabel.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9._-]/g, "_") + "-"
      : "";
    const a = document.createElement("a");
    a.href = url;
    a.download = `simujoules-rendered-${slug}${ts}.zip`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
    status.textContent =
      t("status.exported_layers", items.length, (blob.size / 1024 / 1024).toFixed(1));
  } catch (err) {
    console.error("[export-rendered] failed:", err);
    status.innerHTML = `<span style="color:#ff6b6b">${t("status.export_failed", escapeHtml(err.message))}</span>`;
  }
}

export async function downloadBundle() {
  console.info("[bundle] download click — lastResult?", !!state.lastResult, "dem?", !!state.dem, "JSZip?", typeof JSZip);
  if (!state.dem) {
    status.innerHTML = `<span style="color:#ff6b6b">${t("status.download_need_dem")}</span>`;
    return;
  }
  if (!state.lastResult && !state.lastGraphResult) {
    status.innerHTML = `<span style="color:#ff6b6b">${t("status.download_need_compute")}</span>`;
    return;
  }
  if (typeof JSZip === "undefined") {
    status.innerHTML = `<span style="color:#ff6b6b">${t("status.jszip_failed")}</span>`;
    return;
  }
  status.textContent = t("status.building_bundle");
  try {
    const graphMode = !!state.lastGraphResult;
    const r = state.lastResult || {}; // graph-only bundles carry no grid result
    const dem = state.dem;
    // A graph run does NOT clear state.lastResult, so a session that ran a
    // grid compute before a graph compute would otherwise have buildMetadata
    // describe (stats/elapsedMs/outputs) the STALE grid result while the zip
    // below (all gated on !graphMode) omits those files entirely. Passing
    // null in graph mode makes buildMetadata skip the result-dependent
    // descriptors/stats altogether (network/impassable/bridges still show).
    const md = buildMetadata(graphMode ? null : state.lastResult, true);
    if (graphMode) {
      md.outputs = md.outputs || {};
      md.outputs.graphEdges = { format: "GeoJSON", file: "graph_edges.geojson", junctionMode: graphJunctionMode() };
      // Graph runs carry their own timing separately from md.elapsedMs (which
      // is null now that result is null) — restore it from the graph result.
      md.elapsedMs = state.lastGraphResult.result?.elapsedMs ?? null;
    }

    const zip = new JSZip();
    zip.file("metadata.jsonld", JSON.stringify(md, null, 2));
    // Output rasters as GeoTIFFs — the unzipped bundle drops straight into
    // QGIS / any GIS, no .bin-plus-metadata gymnastics. CRS and pixel grid
    // are inherited from the source DEM via tiffMetadataForDem.
    // Unreachable cells store +Infinity in the energy fields (worker init);
    // tag GDAL_NODATA so GDAL/QGIS report finite min/max/mean instead of
    // inf/nan and don't render a washed-out default stretch. geotiff.js
    // writes it as an ASCII tag and GDAL accepts the literal "inf". Passes
    // rasters are untouched — 0 there is a legitimate "no passes" value, not
    // nodata. Pixel values themselves stay Infinity (bundle reload keeps
    // reconstructing them as-is).
    const ENERGY_NODATA_MD = { GDAL_NODATA: "inf" };
    if (r.energy && !graphMode) {
      zip.file("energy.tif",  new Uint8Array(writeRasterAsGeoTIFF(r.energy, dem, "float32", ENERGY_NODATA_MD)));
    }
    if (r.passes && !graphMode) {
      zip.file("passes.tif",  new Uint8Array(writeRasterAsGeoTIFF(r.passes, dem, "float64")));
    }
    // Alternate scenario for a "Comparar com cenário sem rede" (compare) run:
    // the unconstrained energy/passes and the saved difference field, so the
    // difference / unconstrained views survive a reload (not just the toggle).
    if (r.energyAlt?.unconstrained && !graphMode) {
      zip.file("energy_unconstrained.tif", new Uint8Array(writeRasterAsGeoTIFF(r.energyAlt.unconstrained, dem, "float32", ENERGY_NODATA_MD)));
    }
    if (r.energyAlt?.difference && !graphMode) {
      zip.file("energy_difference.tif", new Uint8Array(writeRasterAsGeoTIFF(r.energyAlt.difference, dem, "float32", ENERGY_NODATA_MD)));
    }
    if (r.passesAlt?.unconstrained && !graphMode) {
      zip.file("passes_unconstrained.tif", new Uint8Array(writeRasterAsGeoTIFF(r.passesAlt.unconstrained, dem, "float64")));
    }
    // The rasterised network mask reproduces the constrained compute even
    // when the source .gpkg isn't handy at reload. Stored as a 1-byte-per-
    // cell GeoTIFF (uint8) so QGIS can also display it as a raster mask.
    if (state.networkMask) {
      zip.file("network.tif", new Uint8Array(writeRasterAsGeoTIFF(state.networkMask, dem, "uint8")));
    }
    // The resampled impassable mask (DEM-aligned uint8) reproduces the blocked
    // water + bridge corridors on reload without re-uploading the source raster.
    if (state.impassable) {
      zip.file("impassable.tif", new Uint8Array(writeRasterAsGeoTIFF(state.impassable, dem, "uint8")));
    }
    // OSM/loaded bridges/tunnels as GeoJSON — re-derived into decks on reload.
    // EXCLUDE user-drawn portals: they round-trip via config.drawn.portals, and
    // including them here would double-add on restore (reappend + reinstall).
    const exportBridges = (state.bridges || []).filter((b) => !b.drawn);
    if (exportBridges.length) {
      zip.file("bridges.geojson", JSON.stringify(bridgesToFC(exportBridges), null, 2));
    }
    if (r.routes && r.routes.length && !graphMode) {
      zip.file("routes.geojson", JSON.stringify(routesFCFromList(r.routes, dem, md.params.mode), null, 2));
    }
    if (r.path && r.path.length && !graphMode) {
      zip.file("path.geojson", JSON.stringify(pathFCFromIndices(r.path, dem, {
        energy: r.pathEnergy,
        length_m: r.pathLengthM,
      }, md.params.mode), null, 2));
    }
    // Compare run: the unconstrained best TERRAIN route, so the scenario picker's
    // route comparison comes back on import without a recompute (mirrors energyAlt).
    if (r.pathAlt && r.pathAlt.length && !graphMode) {
      zip.file("path_alt.geojson", JSON.stringify(pathFCFromIndices(r.pathAlt, dem, {
        scenario: "terrain",
        energy: r.pathAltEnergy,
        length_m: r.pathAltLengthM,
      }, md.params.mode), null, 2));
    }
    // "Follow the vectors" result → per-edge GeoJSON (passes/energy/length).
    if (state.lastGraphResult) {
      zip.file("graph_edges.geojson", JSON.stringify(
        graphEdgesFC(state.lastGraphResult.graph, state.lastGraphResult.result, dem), null, 2));
    }

    // KNOWN LIMITATION (documented, not fixed here): for a huge compare run
    // (e.g. 135M cells with passes) the GeoTIFF copies above (~4 GB: energy
    // f32 + passes f64 + the three *_unconstrained/*_difference variants)
    // are all held in `zip` at once, and generateAsync({type:"blob"}) then
    // accumulates the whole archive into a second in-memory buffer on top of
    // that — plus state.lastResult's own ~3.8 GB. `streamFiles: true` does
    // NOT fix this (it only changes how each entry's data descriptor is
    // written, not whether generateAsync's accumulate() buffers the output
    // blob) — don't add it here as if it were a mitigation. A real fix needs
    // to never materialise the full zip as one JS buffer at all, e.g.
    // zip.generateInternalStream(...) piped chunk-by-chunk into a
    // showSaveFilePicker() FileSystemWritableFileStream (with a fallback to
    // this Blob path where the File System Access API is unavailable) — out
    // of scope for this pass; revisit if 100M+-cell compare exports become
    // a routine workflow.
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
    status.textContent = t("status.bundle_saved", (blob.size / 1024 / 1024).toFixed(1));
  } catch (err) {
    console.error("[bundle] download failed:", err);
    status.innerHTML = `<span style="color:#ff6b6b">${t("status.download_failed", escapeHtml(err.message))}</span>`;
  }
}

// Read a bundle (.zip with metadata.jsonld + arrays) or a bare .jsonld and
// restore as much UI/state as possible. After restoration: if a matching
// DEM is already loaded, src/dst markers are placed and the user can click
// Compute to reproduce. If no DEM, the status nudges them to load one.
export async function loadBundleFile(file) {
  try {
    let md;
    let bin = {}; // { energy: Float32Array, passes: Float64Array, ... }
    if (/\.zip$/i.test(file.name)) {
      if (typeof JSZip === "undefined") throw new Error("JSZip didn't load");
      const zip = await JSZip.loadAsync(await file.arrayBuffer());
      const mdEntry = zip.file("metadata.jsonld") || zip.file("metadata.json");
      if (!mdEntry) throw new Error("No metadata.jsonld inside the archive.");
      // Zip-bomb guard: JSZip's central-directory parse is cheap, but each
      // .async() call below fully decompresses that entry into memory — zip
      // compresses ~1000:1, so a crafted few-hundred-KB bundle could declare
      // multi-GB members and OOM the tab before any H×W/length check further
      // down ever runs. `_data.uncompressedSize` is JSZip-internal — guard
      // with optional chaining so a JSZip upgrade degrades to no-cap rather
      // than breaking legitimate imports.
      const entrySize = (e) => e?._data?.uncompressedSize ?? 0;
      const capEntry = (e, label, cap) => {
        if (e && entrySize(e) > cap) {
          throw new Error(`${label}: decompressed size exceeds the safety cap — refusing to load (corrupt or hostile bundle?).`);
        }
      };
      const TEXT_CAP = 64 * 1024 * 1024; // 64 MiB — metadata.jsonld / each .geojson is plain text, never legitimately this big
      capEntry(mdEntry, "metadata.jsonld", TEXT_CAP);
      md = JSON.parse(await mdEntry.async("string"));
      // Raster cap: derive the expected cell count from the bundle's OWN
      // declared dims (parsed above, before any raster .async() call) rather
      // than whatever DEM happens to be loaded in this tab — a hostile
      // bundle could otherwise just lie about md.dem.H/W to dodge a
      // DEM-derived cap. A hard absolute ceiling bounds it even if it lies
      // about its own dims too. The flagship DEM is ~135M cells (passes.tif
      // ≈1.08 GB float64) — size generously above that, not from a small
      // constant, or a legit huge bundle would get rejected.
      const HARD_CELL_CEILING = 200e6; // generous headroom over the ~135M-cell flagship DEM
      const bundleCells =
        Number.isFinite(md?.dem?.H) && Number.isFinite(md?.dem?.W) ? md.dem.H * md.dem.W : null;
      const cellCap = Math.min(bundleCells ?? (state.dem ? state.dem.H * state.dem.W : 50e6), HARD_CELL_CEILING);
      const RASTER_CAP = cellCap * 8 + 65536; // float64/passes worst case + TIFF header overhead
      // v3 bundles use GeoTIFFs for the rasters; v2 used raw little-endian
      // .bin dumps. Try .tif first, fall back to .bin so old bundles still
      // load after this change.
      const eTif = zip.file("energy.tif"),  eBin = zip.file("energy.bin");
      capEntry(eTif, "energy.tif", RASTER_CAP); capEntry(eBin, "energy.bin", RASTER_CAP);
      if (eTif) {
        bin.energy = await readRasterFromGeoTIFF(await eTif.async("arraybuffer"), "float32");
      } else if (eBin) {
        bin.energy = new Float32Array(await eBin.async("arraybuffer"));
      }
      const pTif = zip.file("passes.tif"),  pBin = zip.file("passes.bin");
      capEntry(pTif, "passes.tif", RASTER_CAP); capEntry(pBin, "passes.bin", RASTER_CAP);
      if (pTif) {
        bin.passes = await readRasterFromGeoTIFF(await pTif.async("arraybuffer"), "float64");
      } else if (pBin) {
        bin.passes = new Float64Array(await pBin.async("arraybuffer"));
      }
      // Alternate-scenario rasters (compare view): unconstrained energy/passes +
      // the saved difference field. Held on `bin` so the pending-DEM replay picks
      // them up too; reconstructed onto state.lastResult.energyAlt/passesAlt below.
      const euTif = zip.file("energy_unconstrained.tif");
      capEntry(euTif, "energy_unconstrained.tif", RASTER_CAP);
      if (euTif) bin.energyUnconstrained = await readRasterFromGeoTIFF(await euTif.async("arraybuffer"), "float32");
      const edTif = zip.file("energy_difference.tif");
      capEntry(edTif, "energy_difference.tif", RASTER_CAP);
      if (edTif) bin.energyDifference = await readRasterFromGeoTIFF(await edTif.async("arraybuffer"), "float32");
      const puTif = zip.file("passes_unconstrained.tif");
      capEntry(puTif, "passes_unconstrained.tif", RASTER_CAP);
      if (puTif) bin.passesUnconstrained = await readRasterFromGeoTIFF(await puTif.async("arraybuffer"), "float64");
      const nTif = zip.file("network.tif"), nBin = zip.file("network.bin");
      capEntry(nTif, "network.tif", RASTER_CAP); capEntry(nBin, "network.bin", RASTER_CAP);
      if (nTif) {
        bin.network = await readRasterFromGeoTIFF(await nTif.async("arraybuffer"), "uint8");
      } else if (nBin) {
        bin.network = new Uint8Array(await nBin.async("arraybuffer"));
      }
      const iTif = zip.file("impassable.tif");
      capEntry(iTif, "impassable.tif", RASTER_CAP);
      if (iTif) bin.impassable = await readRasterFromGeoTIFF(await iTif.async("arraybuffer"), "uint8");
      const brGeo = zip.file("bridges.geojson");
      capEntry(brGeo, "bridges.geojson", TEXT_CAP);
      if (brGeo) { try { bin.bridgesFC = JSON.parse(await brGeo.async("string")); } catch {} }
      // Route/path vector geometry. These ride alongside the rasters and get
      // re-rendered (converted back to cell indices) once a matching DEM is
      // present — no recompute needed. Held in `bin` so the pending-bundle
      // replay (loadDemFromArrayBuffer) picks them up too.
      const rGeo = zip.file("routes.geojson");
      capEntry(rGeo, "routes.geojson", TEXT_CAP);
      if (rGeo) { try { bin.routesFC = JSON.parse(await rGeo.async("string")); } catch {} }
      const pGeo = zip.file("path.geojson");
      capEntry(pGeo, "path.geojson", TEXT_CAP);
      if (pGeo) { try { bin.pathFC = JSON.parse(await pGeo.async("string")); } catch {} }
      const paGeo = zip.file("path_alt.geojson");
      capEntry(paGeo, "path_alt.geojson", TEXT_CAP);
      if (paGeo) { try { bin.pathAltFC = JSON.parse(await paGeo.async("string")); } catch {} }
    } else if (/\.jsonld?$|\.json$/i.test(file.name)) {
      md = JSON.parse(await file.text());
    } else {
      throw new Error("Unrecognised file — pass a .zip bundle or .jsonld.");
    }
    applyMetadataToUI(md, bin);
  } catch (err) {
    console.error(err);
    status.innerHTML = `<span style="color:#ff6b6b">${t("status.reload_failed", escapeHtml(err.message))}</span>`;
  }
}

export function applyMetadataToUI(md, bin = {}) {
  // Bundle import mutates the compute grid (networkMask/impassable below) —
  // per the invariant, cancel any in-flight run BEFORE anything a result
  // would render against changes. Importing a bundle supersedes it anyway.
  cancelActiveCompute();
  const p = md.params || {};
  const set = (id, v) => { const el = document.getElementById(id); if (el && v != null) el.value = v; };
  const check = (id, v) => { const el = document.getElementById(id); if (el && v != null) el.checked = !!v; };

  // Restore the FULL control state first (every persisted toggle/value + layer
  // order, compute source, max-workers, language). The result-specific blocks
  // below (src/dst, refPoints, energy/passes ranges, DEM-gated binaries) then
  // refine on top. Older bundles without md.config fall through unchanged.
  // persist:false — a bundle restores the session UI but must not overwrite the
  // user's saved language / params / layer order / max-workers on disk.
  if (md.config) { try { applyConfig(md.config, { persist: false }); } catch (e) { console.warn("[bundle] applyConfig failed", e); } }

  // Graph-mode bundles (network.graphMode / outputs.graphEdges) can't restore
  // their result — graph_edges.geojson needs the full graph object, not just
  // edge geometry (see CHANGELOG) — and the vector network LINES themselves
  // don't travel in the bundle either (only the rasterised network.tif
  // mask does). Detected here so the final status cascade below can warn
  // instead of silently letting the next Compute click fall back to the
  // raster engine (dispatchCompute only takes the graph path when
  // state.networkLines is populated).
  const graphBundle = !!(md.outputs?.graphEdges || md.network?.graphMode);

  // ---- DEM dimension + georeferencing check ------------------------------
  // Binary outputs (energy/passes/network) are sized to the bundle's DEM.
  // Replaying them onto a different DEM would corrupt the visualisation,
  // so we gate the binary path on a strict match. Parameters/UI still get
  // applied — the user is told to re-Compute.
  const bundleH = md.dem?.H, bundleW = md.dem?.W;
  const demDimsMatch =
    state.dem && Number.isFinite(bundleH) && Number.isFinite(bundleW)
      ? state.dem.H === bundleH && state.dem.W === bundleW
      : null; // null = unknown (no DEM loaded yet, or bundle didn't record dims)
  // demMatch additionally checks the geotransform (bundleDemMatch) — same
  // H×W is not proof of the same DEM: many DEM products (all 1° SRTM/FABDEM
  // tiles, say) share pixel dimensions while covering a different area, and
  // replaying tile-A rasters/routes over tile-B's extent renders silently
  // wrong (lonLatToPixel's own comment flags this same invariant).
  const demMatch = bundleDemMatch(md.dem, state.dem);
  // True only when dims matched but the geotransform didn't — used below to
  // pick the right status message (a dims mismatch already has its own).
  const demExtentMismatch = !!state.dem && demDimsMatch === true && demMatch === false;
  if (state.dem && demDimsMatch === false) {
    console.warn(
      `[bundle] DEM dimension mismatch: bundle ${bundleW}×${bundleH}, ` +
      `loaded ${state.dem.W}×${state.dem.H}. Skipping binary replay.`
    );
  } else if (demExtentMismatch) {
    console.warn(
      `[bundle] DEM extent mismatch despite matching ${bundleW}×${bundleH} dims ` +
      `— likely a different tile at the same size. Skipping binary replay.`
    );
  }

  // No DEM yet (or the wrong one, dims OR georeferencing): hold the full
  // bundle — rasters included — so loadDemFromArrayBuffer can re-apply it
  // when a matching DEM lands. A successful full application clears the slot.
  state.pendingBundle = (!state.dem || demMatch === false) ? { md, bin } : null;

  set("mode", p.mode);
  // v2 physics inputs (older bundles carried α/β/η, which no longer map cleanly —
  // they're ignored, the defaults stand).
  set("mass", p.mass);
  set("crr", p.crr);
  set("cda", p.cda);
  set("rho", p.rho);
  set("keff", p.keff);
  set("pflat", p.pFlat);
  set("ksmooth", p.kSmooth);
  set("deadband", p.deadbandM);
  // DEM pre-smoothing knob (v55). Old bundles (< v55) carry no demSmooth —
  // leave the current selection alone rather than resetting it.
  if (p.demSmooth != null) set("dem-smooth", p.demSmooth);
  set("climb-thr", p.climbThr != null ? p.climbThr * 100 : p.climbThr); // bundle stores grade; input is %
  set("e-max", p.eMax);
  set("e-max-mode", p.eMaxMode);
  // p.wantPasses é ignorado desde o v68 — passes sempre são calculadas.
  check("want-topn", p.wantTopN);
  set("n-routes", p.nRoutes);
  set("penalty", p.penalty);
  set("repulsion-mode", p.repulsionMode);
  check("want-density", p.wantDensity);
  // v57 additions — old bundles carry none of these; leave the UI alone then.
  if ([4, 8, 16, 32, 64, 128].includes(p.nDirs)) set("n-dirs", p.nDirs);
  if (p.stringPull != null) check("string-pull", p.stringPull);
  if (Number.isFinite(p.kpiCorr)) set("kpi-corr", Math.min(1.5, Math.max(1, p.kpiCorr)));
  set("n-refs", p.nRefs);
  // Legacy bundles may carry the pre-rename "click" value (or any other
  // stale string) — only accept values the current #ref-sampling select
  // actually has, so we never write garbage into the UI.
  if (["random", "sobol", "halton", "census"].includes(p.refSource)) {
    set("ref-sampling", p.refSource);
  }

  const v = md.viz || {};
  if (v.fieldColormap && COLORMAPS[v.fieldColormap]) {
    setActiveColormap(v.fieldColormap);
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
    set("passes-gamma", v.passes.gamma);
    set("passes-mean-window", v.passes.meanWindow);
  }
  if (v.tile) {
    set("tile-opacity", v.tile.opacity);
    check("tile-visible", v.tile.visible);
  }
  if (v.relief) {
    set("relief-opacity", v.relief.opacity);
    check("relief-visible", v.relief.visible);
  }

  // ---- Vector network params ---------------------------------------------
  // Slider/checkbox values from the bundle's `network` section. Mask
  // restoration happens further down once we've also confirmed DEM dims.
  const net = md.network || {};
  set("vec-width", net.lineWidth);
  set("vec-snap", net.snapRadius);
  check("net-interp", net.wantInterp);
  check("vec-constrain", net.constrain);
  check("vec-compare", net.compare);
  check("vec-graph-mode", net.graphMode);
  if (net.junctionMode) set("vec-junction-mode", net.junctionMode);
  set("net-interp-max-dist", net.interpMaxDistance);
  set("net-interp-smoothing", net.interpSmoothing);
  set("vec-render-width", net.renderWidthM);
  set("vec-render-opacity", net.renderOpacity);
  updateNetworkLineStyle();

  // ---- Impassable mask params (mask restore happens further down) --------
  const imp = md.impassable || {};
  check("imp-enabled", imp.apply);
  check("impassable-invert", imp.invert);
  set("imp-offset", Number.isFinite(imp.elevationOffset) ? imp.elevationOffset : 0);
  set("imp-opacity", Number.isFinite(imp.opacity) ? imp.opacity : 0.5);
  check("imp-corridor", imp.corridorOverride);
  check("imp-show", imp.show);
  // Reveal the dependent rows to match the restored toggles (without firing the
  // change handlers — corridors are recomputed once the mask is restored below).
  { const r = document.getElementById("imp-offset-row");
    if (r) r.style.display = document.getElementById("imp-corridor")?.checked ? "" : "none"; }
  { const r = document.getElementById("imp-opacity-row");
    if (r) r.style.display = document.getElementById("imp-show")?.checked ? "" : "none"; }

  // ---- Bridge/tunnel params (geometry restore happens further down) -------
  const br = md.bridges || {};
  check("bridge-enabled", br.apply);
  check("bridge-tunnels", br.tunnels);
  check("bridge-show", br.show);
  set("bridge-opacity", Number.isFinite(br.opacity) ? br.opacity : 0.9);

  // (Engine preference is no longer user-selectable — JS only.
  // md.enginePreference from older bundles is read but ignored.)

  // Trigger UI sync for toggles that reveal/hide their option groups —
  // top-N exposes the routes-count + repulsion controls, density swaps
  // src/dst for the multi-ref UI and disables/enables the energy layer.
  const topnCheck = document.getElementById("want-topn");
  if (topnCheck) topnCheck.dispatchEvent(new Event("change"));
  const densityCheck = document.getElementById("want-density");
  if (densityCheck) densityCheck.dispatchEvent(new Event("change"));
  // #mode toggles the "Budget applies to" (e-max-mode) row's visibility —
  // v3 app-exported bundles get this for free via applyConfig's
  // PERSIST_REFIRE, but bundles with no md.config (census/CLI bundles,
  // pre-v40-era bundles) restore set("mode", ...) above with no change
  // event, leaving the row's visibility stale. Idempotent to re-fire even
  // when applyConfig already did (just toggles a style, no recompute).
  const modeSel = document.getElementById("mode");
  if (modeSel) modeSel.dispatchEvent(new Event("change"));

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
  // Don't drop markers onto a mismatched DEM — they'd land on bogus pixels.
  // Also skip in density mode — the "Pick points" UI is hidden / disabled
  // there and stale src/dst markers would just clutter the map.
  const densityOnNow = !!document.getElementById("want-density")?.checked;
  if (state.dem && state.src && demMatch !== false && !densityOnNow) {
    if (state.srcMarker) state.srcMarker.remove();
    state.srcMarker = placeMarker(state.src, "Source");
    document.getElementById("src-display").textContent = `r=${state.src[0]}, c=${state.src[1]}`;
    document.getElementById("src-display").classList.add("set");
  }
  if (state.dem && state.dst && demMatch !== false && !densityOnNow) {
    if (state.dstMarker) state.dstMarker.remove();
    state.dstMarker = placeMarker(state.dst, "Destination");
    document.getElementById("dst-display").textContent = `r=${state.dst[0]}, c=${state.dst[1]}`;
    document.getElementById("dst-display").classList.add("set");
  }

  // ---- Reference points (multi-ref density) ------------------------------
  // Re-stamp the FIFO ring exactly as it was. addRefPoint pushes + numbers
  // the markers and respects enforceRefCap, so the cap field set above
  // governs how many actually survive.
  if (Array.isArray(p.refPoints) && state.dem && demMatch !== false) {
    refHistoryPush();   // the import replaces the set as ONE undoable step
    // Clear whatever is on the map from a previous bundle / run.
    if (state.refMarkers) for (const m of state.refMarkers) m.remove();
    state.refMarkers = [];
    state.refPoints = [];
    for (const rc of p.refPoints) {
      if (Array.isArray(rc) && rc.length >= 2) addRefPoint([rc[0] | 0, rc[1] | 0]);
    }
    syncRefDisplay();
    refHistorySettle();
  }

  // ---- Network mask restore ---------------------------------------------
  // Only when we have a DEM, dims match, and the byte length matches H*W.
  // Otherwise leave the slot empty — better to recompute than to load a
  // mask that points at the wrong cells.
  if (bin.network && state.dem && demMatch === true) {
    const N = state.dem.H * state.dem.W;
    if (bin.network.length === N) {
      state.networkMask = bin.network;
      state.networkSrsId = net.srsId || null;
      state.networkFeatureCount = net.featureCount || 0;
      const meta = document.getElementById("vec-meta");
      if (meta) {
        // srsId / featureCount come from the bundle's metadata.jsonld, which a
        // shared/crafted bundle controls — escape before innerHTML (stored XSS).
        meta.innerHTML =
          `Restored from bundle: <span class="v">${escapeHtml(String(state.networkFeatureCount))}</span> ` +
          `features (SRS ${escapeHtml(String(state.networkSrsId ?? "?"))}).`;
      }
    } else {
      console.warn(
        `[bundle] network.bin size mismatch: ${bin.network.length} bytes vs H*W=${N}. Discarded.`
      );
    }
  }

  // ---- Impassable mask restore -------------------------------------------
  // After the network mask (corridors depend on it) and under the same dim
  // check. We only have the DEM-aligned resampled mask here, not the source
  // raster, so the Invert toggle won't re-resample (already baked in).
  if (bin.impassable && state.dem && demMatch === true) {
    const N = state.dem.H * state.dem.W;
    if (bin.impassable.length === N) {
      let cells = 0;
      for (let i = 0; i < N; i++) if (bin.impassable[i]) cells++;
      state.impassable = bin.impassable;
      state.impassableMeta = {
        name: imp.sourceName || "mask", width: imp.srcWidth || null,
        height: imp.srcHeight || null, srs: imp.srs || null, cellsImpassable: cells,
      };
      recomputeCorridors();
      updateImpassableMeta();
      updateCorridorAvailability();
      applyImpassableOverlay();
    } else {
      console.warn(`[bundle] impassable.tif size mismatch: ${bin.impassable.length} vs H*W=${N}. Discarded.`);
    }
  }

  // ---- Bridges/tunnels restore -------------------------------------------
  // Re-derive decks from the saved GeoJSON (endA/endB depend on the grid, so
  // only under a dimension match). installBridgesFromWays handles overlay +
  // invalidation, mirroring a fresh OSM pull.
  if (bin.bridgesFC && state.dem && demMatch === true) {
    const ways = (bin.bridgesFC.features || [])
      .filter((f) => f.geometry?.type === "LineString" && Array.isArray(f.geometry.coordinates))
      .map((f) => ({
        latlngs: f.geometry.coordinates.map(([lon, lat]) => [lat, lon]),
        kind: f.properties?.kind || "bridge",
        layer: f.properties?.layer || 0,
        name: f.properties?.name || null,
        eleA: Number.isFinite(f.properties?.eleA) ? f.properties.eleA : null,
        eleB: Number.isFinite(f.properties?.eleB) ? f.properties.eleB : null,
      }));
    if (ways.length) installBridgesFromWays(ways, "bundle");
  }

  applyLayerControls();
  estimateRunTime();

  // If we got the cached outputs back, render them straight away — no
  // recompute needed. Skip if the DEM dimensions don't match (or no DEM
  // is loaded yet). Routes/path come back from GeoJSON (converted to cell
  // indices); the energy/passes rasters come back from the GeoTIFFs. Any
  // subset is fine — a destination-path bundle has a path but no top-N
  // routes, a density bundle has neither.
  let restored = false;
  if (state.dem && demMatch === true) {
    const N = state.dem.H * state.dem.W;
    const energyOk = bin.energy && bin.energy.length === N;
    const passesOk = bin.passes && bin.passes.length === N;
    const routes = routesFromFC(bin.routesFC || null, state.dem);
    const path = routes ? null : pathFromFC(bin.pathFC || null, state.dem);
    const pathAlt = pathFromFC(bin.pathAltFC || null, state.dem);
    // Render whenever we recovered anything drawable; routes take precedence
    // over a lone path (renderResult draws one or the other, mirroring a
    // fresh compute, which returns either top-N routes or a single path).
    if (energyOk || passesOk || routes || path || pathAlt) {
      // Rebuild the compare scenarios from the alt rasters so the displayed-
      // scenario picker + the difference/unconstrained views come back (not just
      // the toggle). renderResult shows #energy-source-row when these are present.
      const eu = bin.energyUnconstrained?.length === N ? bin.energyUnconstrained : null;
      const ed = bin.energyDifference?.length === N ? bin.energyDifference : null;
      const pu = bin.passesUnconstrained?.length === N ? bin.passesUnconstrained : null;
      const energyAlt = (eu || ed) ? { unconstrained: eu, difference: ed } : null;
      const passesAlt = pu ? { unconstrained: pu } : null;
      const synth = {
        energy:      energyOk ? bin.energy : null,
        passes:      passesOk ? bin.passes : null,
        path,
        pathEnergy:  md.stats?.pathEnergy ?? null,
        pathLengthM: md.stats?.pathLengthM ?? null,
        routes,
        elapsedMs:   md.elapsedMs ?? 0,
        energyAlt,
        passesAlt,
        pathAlt,
        pathAltEnergy:  md.stats?.pathAltEnergy ?? null,
        pathAltLengthM: md.stats?.pathAltLengthM ?? null,
      };
      renderResult(synth);
      setGroupOpen("result-group", true); // bundle loaded a result → reveal it
      restored = true;
    }
  }

  updateRunButtonState();
  if (restored) {
    status.textContent = t("status.bundle_restored");
  } else if (state.dem && demDimsMatch === false) {
    status.innerHTML =
      `<span style="color:#ff9d3d">${t("status.bundle_dem_mismatch", bundleW, bundleH, state.dem.W, state.dem.H)}</span>`;
  } else if (demExtentMismatch) {
    status.innerHTML =
      `<span style="color:#ff9d3d">${t("status.bundle_dem_extent_mismatch", bundleW, bundleH)}</span>`;
  } else if (graphBundle && !(state.networkLines && state.networkLines.length)) {
    // Graph-mode bundle, no vector network loaded: warn instead of letting
    // the user believe Compute will reproduce the graph result — it won't,
    // it'll silently run the raster engine (see graphBundle's definition).
    status.innerHTML = `<span style="color:#ff9d3d">${t("status.bundle_graph_not_restored")}</span>`;
  } else if (state.dem && (state.src || (p.wantDensity && state.refPoints?.length))) {
    status.textContent = t("status.bundle_params_loaded");
  } else if (!state.dem) {
    const hint = md.dem?.sourceUrl ? ` (try ${escapeHtml(md.dem.sourceUrl)})` : "";
    status.innerHTML = `<span style="opacity:0.85">${t("status.bundle_need_dem", hint)}</span>`;
  } else {
    status.textContent = t("status.bundle_loaded");
  }
}
