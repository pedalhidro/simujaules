// The shared `state` object, plus escapeHtml().
import "./map.js"; // evaluation order — see ../app.js

// ------- State -------
export const state = {
  dem: null, // { height, mask, H, W, dx, dy, bbox, originX, originY }
  src: null, // [r, c]
  dst: null, // [r, c]
  // All live compute workers (1 for regular runs, N for the density pool).
  // computeGen is bumped on every run start AND every cancellation — a
  // worker message whose captured generation doesn't match is stale (the
  // user loaded a new DEM / network mid-compute) and must be dropped, not
  // rendered against the new grid.
  workers: [],
  computeGen: 0,
  // Compute-time calibration, learned by a one-shot probe at DEM load (see
  // startCalibrationProbe). null until the probe lands. calibrationGen is
  // bumped on every DEM load so a stale in-flight probe's result is dropped.
  // backendCores: cached {url, cores} from a /health ping, for the estimate.
  calibration: null,
  calibrationGen: 0,
  probeWorker: null,
  // Set when the calibration probe errors: estimateRunTime blanks the
  // estimate instead of showing "estimating…" forever (computeDone retries).
  calibrationFailed: false,
  backendCores: null,
  // Snapshot of the last compute's config (engine, refs, budget, mode), taken
  // at run start so the post-compute online correction can compare the
  // estimate it would have made against the real elapsed time.
  lastRun: null,
  // Predicted compute ms for lastRun (corrected) — drives the synthetic
  // progress of wasm jobs, which can't report progress mid-call.
  lastRunPredictedMs: 0,
  // Engine the last grid compute actually ran on ("wasm32"/"wasm64", or null
  // for the JS engine / native backend) — tagged onto the done status.
  lastRunEngine: null,
  // WebAssembly engine modules: loading[engine] = Promise<{module, is64}|null>
  // (compiled once per session); failed[engine] = reason once a module could
  // not be fetched/compiled/instantiated (later runs skip it).
  wasm: { loading: {}, failed: {} },
  // Cloud compute-source state machine (see computeMode()/ensureCloudVm()):
  //   mode           — last computeMode() resolved at run start ("cloud" arms it)
  //   orchestratorUrl — base URL of the orchestrator (a public Cloud Run
  //                    service, reachable from any origin, gated by the shared
  //                    cloud password)
  //   vmState        — last STATE seen from /cloud/status (STOPPED/PROVISIONING/
  //                    RUNNING/STOPPING/ERROR)
  //   keepaliveTimer — interval marking "compute in flight" client-side; its
  //                    /cloud/keepalive traffic ALSO registers a short-lived
  //                    lease on the orchestrator (LEASES[clientId], ~180s TTL)
  //                    so a second browser's default "stop after run" can't
  //                    kill the VM out from under a concurrent compute here
  //   clientId       — stable per-tab id (crypto.randomUUID(), generated once)
  //                    sent as X-Simu-Client on /cloud/keepalive and /cloud/stop
  //                    so the orchestrator can tell concurrent clients apart
  //   pollTimer      — interval polling /cloud/status while booting (unused as a
  //                    stored handle; the boot loop awaits inline, kept for clarity)
  //   dataUrl        — VM's HTTPS data-plane base, learned from the orchestrator
  //                    (/cloud/start|status); where /density,/single,/health go
  cloud: { mode: "browser", orchestratorUrl: "", dataUrl: "", vmState: "STOPPED", keepaliveTimer: null, pollTimer: null, clientId: null },
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
  // Optional rasterised vector network. When non-null, AND'd with the
  // DEM mask before every compute so analysis is constrained to network
  // cells. networkSrsId stamps the source CRS so we can warn on DEM swap.
  networkMask: null,
  networkSrsId: null,
  networkFeatureCount: 0,
  // Parsed network geometry in WGS84 ([[lat,lng], …] per line), kept so the
  // optional "draw network" toggle can render true vector lines at a fixed
  // ground width. null when over the vertex cap (drawing disabled).
  networkLines: null,
  // Per-network-way { deck, layer } tags (parallel to networkLines), captured
  // from the OSM streets pull, for graph-mode bridge/tunnel handling (Phase C:
  // layer-aware junctions + deck flattening). null for .gpkg networks (no tags).
  networkLinesMeta: null,
  // Bridge/tunnel ways extracted from the loaded network (gpkg tags or OSM
  // tags) as [{ latlngs, kind, layer, name }] — fed to the 1d "extract bridges
  // from the loaded network" button (installBridgesFromWays). null if none.
  networkBridgeCandidates: null,
  networkLinesLayer: null,
  // "Follow the vectors" graph mode: the routable graph built from
  // networkLines (cached, keyed by networkGraphToken so a network/junction-mode/
  // DEM change rebuilds it), the last per-edge result, and its map layer.
  networkGraph: null,
  networkGraphToken: null,
  lastGraphResult: null,
  // Graph mode renders as TWO pane-integrated vector layers (energy on
  // energyPane, passes on passesPane) so the existing Energy/Passes visibility
  // + opacity controls drive them, plus a routes/path layer on routesPane.
  graphEnergyLayer: null,
  graphPassesLayer: null,
  graphRoutesLayer: null,
  // Graph energy is shown as an interpolated RASTER (like grid), not vector
  // edges — rasterised from the graph then IDW-filled. Cached for restyle.
  graphEnergyRaster: null,
  // Optional impassable mask (water, etc.). `impassable` is resampled to the
  // DEM grid (1 = impassable); `impassableRaster` keeps the parsed source so
  // the Invert toggle re-resamples without a re-upload. The vector network can
  // carve bridge corridors across it: corridorCells/Base/Ramp cache the
  // reopened cells and their smooth bridge-elevation profile (see
  // recomputeCorridors / buildComputeGrid). impassableToken is bumped on any
  // mask/corridor/offset/invert change so the cached network graph rebuilds.
  impassable: null,
  impassableRaster: null,
  impassableMeta: null,
  corridorCells: null,
  corridorBase: null,
  corridorRamp: null,
  corridorSet: null, // Set of corridor cell indices, for O(1) click-validity lookup
  osmWaterGeom: null, // cached parsed OSM water geometry (grid coords) for re-rasterising on the #imp-rivers toggle
  // Bumped on every rebuildOsmWaterMask() call so overlapping invocations (rapid
  // #imp-rivers toggling) can tell which one is the LAST one started — a
  // superseded call must not apply its (possibly out-of-order-finishing) result.
  waterMaskGen: 0,
  impassableToken: 0,
  impassableOverlay: null,
  // Optional OSM bridges & tunnels modelled as level "decks". Each is a span
  // between two ground abutment cells (endA/endB). In the raster compute they
  // become PORTAL EDGES — a shortcut between the end cells at the flat-deck cost
  // — so the route OVER the bridge and the ground route UNDER it both stay
  // correct (the grid keeps ground elevation everywhere; nothing is overwritten).
  // bridgesToken is bumped on any bridge change so the cached graph + estimate
  // rebuild. See loadOsmBridges / buildPortals / buildComputeGrid.
  bridges: null,       // [{ latlngs, endA, endB, deckLenM, kind, layer, name }]
  bridgesMeta: null,   // { source, count, skipped }
  bridgesToken: 0,
  bridgesLayer: null,  // Leaflet polyline group overlay
  // Multi-reference density: list of [r, c] pixel coords plus their map markers.
  refPoints: [],
  refMarkers: [],
  // Undo/redo stacks of ref-set snapshots (see refHistoryPush). Reset on
  // DEM load — snapshots index cells of the grid they were taken on.
  refHistory: { past: [], future: [] },
  // Total in-extent population the CURRENT refs proxy (Σ setor pop × in-bbox
  // area fraction, from the census sampler). Each census ref is an equal-share
  // proxy of refPopM/K. Nulled on ANY ref-set change (manual click, clear,
  // non-census placement, file load) — only a fresh census placement sets it.
  refPopM: null,
  // Accessibility KPI cache from the last density run that carried the
  // pairwise ref↔ref energy matrix. { mat (Float32 K×K, OUTBOUND rows:
  // mat[i*K+j] = energy for ref i's trip to ref j under the run's mode),
  // K, refs: [{r,c,lat,lng}] (snapshot at run start), popM, eMax, eMaxMode,
  // mode, unavailable } — see installKpiResult / kpiInvalidate. NOT part of
  // state.lastResult: style re-renders must never touch it.
  kpi: null,
  // Max-density segment (3C.c): post-hoc search over the last density/passes
  // field. { worker (in-flight Worker or null), line (Leaflet layerGroup or
  // null), strokes ([{stroke, t}] for live palette recolouring) };
  // maxsegGen invalidates stale worker messages (same pattern as
  // computeGen). Cleared by cancelActiveCompute() — the result derives from
  // the current grid + last result, so any event that invalidates those
  // clears the segments too.
  maxseg: null,
  maxsegGen: 0,
  // Position in the quasi-random (Sobol/Halton) sequence used by "Place
  // random". Persists across clicks so each batch continues the sequence;
  // reset whenever the refs are cleared or the DEM changes.
  qmcIndex: 0,
  // Guards the async "census" sampler so a double-click can't fire two
  // overlapping cloud queries that both clear + re-add reference points.
  censusInFlight: false,
  // Bumped by every DEM initiator (file input, hosted example, FABDEM
  // viewport, Group-0 import) so a slow load that finishes after a newer one
  // was started can detect it's stale and bail before installing (last-CLICK
  // wins) instead of last-FINISHER silently replacing the displayed DEM.
  demLoadGen: 0,
  // Live-ETA bookkeeping (set on Compute, cleared on done/error).
  computeStartedAt: 0,
  estimatedTotalMs: 0,
  // Bundle loaded before (or against the wrong) DEM: held here — including
  // its binary rasters — and re-applied by loadDemFromArrayBuffer once a
  // DEM with matching dimensions arrives. Without this, loading the DEM
  // second wiped everything the bundle had just restored (src/dst, refs)
  // and the rasters were lost, making bundle-then-DEM order useless.
  pendingBundle: null,
};

// Escape user-derived text (file parse errors, worker messages, …) before
// it's interpolated into status.innerHTML — bundles and DEMs are shareable
// artifacts, so error strings echoing their content are attacker-reachable.
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
}
