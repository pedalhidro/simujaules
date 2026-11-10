// app.js — entry point of the Simujaules UI (DEM loading, map, compute
// dispatch, rendering, bundle I/O). It was one 13,000-line module until v82;
// the code now lives under app/, one module per concern, with the pure
// DOM-free helpers in lib/. No build step: the browser imports these files.
//
// EVALUATION ORDER IS PART OF THE CONTRACT. The modules' top-level code (the
// map, its panes, `state`, the DOM handles, every addEventListener) runs in
// the order listed below — the top-to-bottom order of the original file.
// Modules import each other freely (function declarations are hoisted across
// import cycles, exactly as they were inside one file), so that order is
// pinned by a chain instead: every module's FIRST import is its predecessor
// in this list, and this file imports the LAST module first.
//
// To add a module: put it in the list, make its first import the module
// before it, repoint the next module's first import at it, and add it to
// sw.js PRECACHE_URLS. A `let` shared across modules is assigned only through
// a setter in the module that declares it (imports are read-only bindings).
// test-app-shell.mjs checks all of this.
//
//    1  app/i18n.js            PT/EN STRINGS table, t(), applyTranslations(), setLang()
//    2  app/panel.js           group highlights, parameter persistence, readCost(), config I/O
//    3  app/boot.js            worker/engine URLs, the DOMContentLoaded wiring of every control
//    4  app/map.js             the Leaflet map: panes + layer order, address search, basemaps
//    5  app/state.js           the shared `state` object, escapeHtml()
//    6  app/compute-source.js  Browser / Localhost / Cloud: URLs, cancelActiveCompute()
//    7  app/dom.js             shared DOM handles (status line, run button, progress bar…)
//    8  app/dem.js             DEM loading: file / URL / FABDEM viewport, crop, downsample
//    9  app/network.js         vector network: GeoPackage, Overpass + FlatGeobuf street pulls
//   10  app/bridges.js         bridges and tunnels → portal edges (group 1D)
//   11  app/draw.js            on-map drawing (Geoman): impassable polygons, portal bridges
//   12  app/water.js           impassable mask: water pulls (group 1C), mask files
//   13  app/network-view.js    network line overlay, snapToNetwork(), lat/lng ↔ pixel
//   14  app/graph-mode.js      graph mode ("follow the vectors") and its overlay
//   15  app/points.js          map clicks → source / destination / reference points, census
//   16  app/run.js             the Run handler: message build, dispatch, pool merge; renderResult()
//   17  app/kpi.js             accessibility KPIs (3B) and their CSV exports
//   18  app/maxseg.js          max-density segment (3C.c)
//   19  app/render.js          field / relief / impassable overlays, layer controls, legend
//   20  app/refgeom.js         reference geometry: the GPX overlay and its energy
//   21  app/engines.js         memory budget, densityPoolSize(), WebAssembly engine choice
//   22  app/cloud.js           cloud compute: the VM state machine
//   23  app/estimate.js        run-time estimate: probe, predictComputeMs(), formatters
//   24  app/colormaps.js       ColorCET tables, colormap(), route colours, the legend
//   25  app/geotiff.js         GeoTIFF read/write helpers
//   26  app/grid.js            the compute grid: mask resample, corridors, buildPortals()
//   27  app/bundle.js          bundle export/import: metadata.jsonld, GeoJSON, images

// Walks the chain down to app/i18n.js and evaluates the modules in list order.
import "./app/bundle.js";

// Already evaluated by the line above — listed so the browser fetches them in
// parallel instead of discovering them one import at a time.
import "./app/i18n.js";
import "./app/panel.js";
import "./app/boot.js";
import "./app/map.js";
import "./app/state.js";
import "./app/compute-source.js";
import "./app/dom.js";
import "./app/dem.js";
import "./app/network.js";
import "./app/bridges.js";
import "./app/draw.js";
import "./app/water.js";
import "./app/network-view.js";
import "./app/graph-mode.js";
import "./app/points.js";
import "./app/run.js";
import "./app/kpi.js";
import "./app/maxseg.js";
import "./app/render.js";
import "./app/refgeom.js";
import "./app/engines.js";
import "./app/cloud.js";
import "./app/estimate.js";
import "./app/colormaps.js";
import "./app/geotiff.js";
import "./app/grid.js";
