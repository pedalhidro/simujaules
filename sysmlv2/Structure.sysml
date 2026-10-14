package SimujaulesStructure {
    doc
    /*
     * Logical structure of Simujaules: what the parts are, which file holds
     * each, and how they compose. Two structural facts carry invariants:
     *  - NativeEngineCore (backend/src/main.rs) is composed into BOTH the
     *    NativeBackend and the WasmModule: the wasm engine IS the backend
     *    engine, include!d verbatim (EP-03).
     *  - WasmWorker specialises JsEngine: wasm-worker.js importScripts
     *    energy-worker.js and falls back to it on any failure.
     * The top-level system and its context live in SimujaulesSystemContext.
     */

    private import ScalarValues::*;
    private import SimujaulesDomain::*;
    private import SimujaulesEnergy::*;
    private import SimujaulesInterfaces::*;

    // =====================================================================
    // Source artefacts
    // =====================================================================

    part def SourceArtefact {
        doc /* A file or directory in the repo that implements a part. */
        attribute path : String;
        attribute deployed : Boolean default false;
    }

    // =====================================================================
    // Compute engines
    // =====================================================================

    abstract part def ComputeEngine {
        doc /* Anything that turns a Grid + CostBundle into fields. All share V2Edge. */
        attribute engineKind : EngineKind;
        attribute heap : String;
    }

    part def GraphEngine :> ComputeEngine {
        doc
        /*
         * graph-engine.js (self.GraphEngine UMD): buildGraph, directedCosts,
         * dijkstra (radix heap), topN (per-edge penalty), maximizeWalk,
         * computeGraph, nearestNode. stepCost == v2Edge. Portal-blind (EP-15).
         */
        :>> engineKind = EngineKind::graph;
        :>> heap = "radix";
        part src : SourceArtefact { :>> path = "graph-engine.js"; :>> deployed = true; }
    }

    part def JsEngine :> ComputeEngine {
        doc
        /*
         * energy-worker.js, the REFERENCE implementation, hosted in a Web Worker
         * (or a worker_threads Worker for MCP/census). Algorithms: dijkstra
         * (binary heap, single-source from/to/round, passes, portals, maximize
         * inversion), densityField (radix heap NB = 65, scratch reuse, long-edge
         * tables when >= 3 refs, refCells matrix, maxSettled probe cap), astar
         * (top-N, classic 8), maxCostPathOfLength (layered DP, classic 8),
         * maxDensitySegment, fillAcrossNetwork (IDW), stringPullPath,
         * buildMoves, longEdgeCost, stampLongPasses, buildPortalAdj, v2Edge.
         */
        :>> engineKind = EngineKind::js;
        :>> heap = "binary (single-source, A*) / radix (density)";
        part src : SourceArtefact { :>> path = "energy-worker.js"; :>> deployed = true; }
        part graph : GraphEngine {
            doc /* Served through worker kinds graphBuild / graphRun. */
        }
        port engine : EnginePort;
    }

    part def NativeEngineCore :> ComputeEngine {
        doc
        /*
         * backend/src/main.rs: the Rust PORT of energy-worker.js (EP-01).
         * dijkstra_tree, compute_density_acc (raw Acc + matrix, the JS
         * densityPartial shape), compute_density (normalised), compute_single,
         * parse_grid_body (shared request validation), build_portals,
         * build_moves, long_edge_cost, build_long_table, js_hypot, js_round,
         * RadixHeap, subtree_passes(_f64), accumulate_round.
         * Scratch = 17 B/cell (+1 with long moves); Acc = 20 B/cell (f64, f64,
         * u32); per_slice = 37 N (55 N round) + shared long-edge tables.
         */
        :>> engineKind = EngineKind::native;
        :>> heap = "radix";
        part src : SourceArtefact { :>> path = "backend/src/main.rs"; }
        attribute scratchBytesPerCell : Natural = 17;
        attribute accBytesPerCell : Natural = 20;
        attribute perSliceBytesPerCell : Natural = 37;
        attribute perSliceBytesPerCellRound : Natural = 55;
    }

    part def NativeBackend {
        doc
        /*
         * simujoules-backend 0.2.0 (tiny_http + rayon, fat LTO,
         * target-cpu=native). Single-threaded accept loop; rayon slices bounded
         * by a memory budget: SIMU_MAX_MEM_GB (x 0.8) / --max-mem-gb, else
         * MemAvailable - 3 GB (floor 2 GB); RAYON_NUM_THREADS. n_slices =
         * min(refs, threads, (budget - tables) / per_slice). Output is identical
         * whatever the slice count.
         */
        part core : NativeEngineCore;
        part src : SourceArtefact { :>> path = "backend/"; }
        port http : ComputeHttpPort;
        attribute crateName : String = "simujoules-backend";
        attribute version : String = "0.2.0";
        attribute defaultBind : String = "127.0.0.1:8077";
    }

    part def WasmModule {
        doc
        /*
         * engine32.wasm (wasm32, stable, <= 4 GiB) or engine64.wasm (Memory64,
         * nightly + build-std, --max-memory = 16 GiB, CO-14). Built by
         * wasm/build.sh from wasm/src/lib.rs = include!("../../backend/src/main.rs")
         * + C ABI. Committed build products: deploy stays build-free.
         */
        part core : NativeEngineCore;
        part src : SourceArtefact;
        port abi : WasmAbiPort;
        attribute memory64 : Boolean;
        attribute maxMemoryBytes : Natural;
    }

    part def WasmWorker :> JsEngine {
        doc
        /*
         * wasm-worker.js: SUPERSET of energy-worker.js (importScripts). Serves on
         * wasm only kind "run" with msg.wasm.module set and either a density pool
         * slice (job 0) or a plain from/to/round field without goal, top-N or
         * maximize (job 1, JS IDW afterwards). Everything else, and any wasm
         * failure (engine-fallback), goes to the inherited JS engine.
         */
        part wasmSrc : SourceArtefact { :>> path = "wasm-worker.js"; :>> deployed = true; }
        part module : WasmModule[0..1] {
            doc /* Compiled once on the page (loadWasmEngine) and posted as a WebAssembly.Module. */
        }
    }

    // =====================================================================
    // The browser application (app.js) and its components
    // =====================================================================

    part def AppComponent {
        doc /* A logical responsibility inside app.js (one file, no modules). */
        attribute keyFunctions : String[*];
    }

    part def I18n :> AppComponent {
        doc /* STRINGS (582 keys, {pt, en}), t(key, ...args), applyTranslations, setLang (localStorage simu-lang). */
        :>> keyFunctions = ("t", "applyTranslations", "setLang");
        attribute languages : String[*] = ("pt", "en");
    }
    part def DemLoader :> AppComponent {
        doc
        /*
         * 1A: GeoTIFF file (geotiff.js), bundled examples (dem/sampa_*.tif),
         * FABDEM viewport tiles (fabdem.pedalhidrografi.co, R2), crop/downsample.
         * Calls cancelActiveCompute first (CO-06).
         */
        :>> keyFunctions = ("loadDemFromArrayBuffer", "loadDemFromUrl", "loadFabdemForView",
            "cropDemToViewport", "downsampleDem");
    }
    part def DemSmoother :> AppComponent {
        doc /* #dem-smooth: smoothHeightsInPlace (PP-01..03). */
        :>> keyFunctions = ("smoothHeightsInPlace");
        attribute smoothing : DemSmoothing;
    }
    part def NetworkLoader :> AppComponent {
        doc
        /*
         * 1B: .gpkg via sql.js (getSQL, loadVectorNetwork), Overpass
         * (loadOsmNetwork) or the viario FGB (loadFgbNetwork); both cloud pulls
         * share installNetworkFromLines. Also graph building for graph mode.
         */
        :>> keyFunctions = ("loadVectorNetwork", "loadOsmNetwork", "loadFgbNetwork",
            "fgbStream", "installNetworkFromLines");
    }
    part def WaterMaskBuilder :> AppComponent {
        doc
        /*
         * 1C: loadOsmWater / loadFgbWater -> osmWaterGeom -> rebuildOsmWaterMask
         * (fillRingsEvenOdd, rasterPolylineSupercover, assembleRings,
         * fillSeaFromCoastlines); drawn barriers and corridors.
         */
        :>> keyFunctions = ("loadOsmWater", "loadFgbWater", "rebuildOsmWaterMask",
            "fillSeaFromCoastlines", "recomputeCorridors");
    }
    part def BridgeLoader :> AppComponent {
        doc /* 1D: loadOsmBridges / loadFgbBridges -> installBridgesFromWays; buildPortals for the engines. */
        :>> keyFunctions = ("loadOsmBridges", "loadFgbBridges", "installBridgesFromWays", "buildPortals");
    }
    part def ReferenceManager :> AppComponent {
        doc
        /*
         * 2B: clicked refs, file refs, placeRandomRefPoints (sobol/random;
         * halton on import), placeCensusRefPoints (census FGB, population
         * weighted; sets refPopM).
         */
        :>> keyFunctions = ("addRefPoint", "placeRandomRefPoints", "placeCensusRefPoints",
            "sobolPoint2D", "haltonPoint2D", "loadRefPointsFromFile", "exportRefPoints");
    }
    part def RunEstimator :> AppComponent {
        doc
        /*
         * startCalibrationProbe (kind "probe"), predictComputeMs (single
         * predictor), estimateRunTime, the per-engine online corrections in
         * state.calibration (corrBrowser, corrBackend, corrGraph, corrInterp,
         * corrWasm). Constants mirrored from main.rs: BACKEND_BYTES_PER_CELL
         * {,_ROUND}; NATIVE_SPEEDUP; DIRS_COST_SINGLE/DIRS_COST_DENSITY.
         */
        :>> keyFunctions = ("startCalibrationProbe", "predictComputeMs", "estimateRunTime", "currentRunOpts");
    }
    part def EngineSelector :> AppComponent {
        doc /* densityPoolSize, memBudgetBytes, wasmJobBytes, wasmEngineFor, densityEngine, singleEngine, loadWasmEngine. */
        :>> keyFunctions = ("densityPoolSize", "memBudgetBytes", "wasmJobBytes", "wasmEngineFor",
            "densityEngine", "singleEngine", "loadWasmEngine");
    }
    part def ComputeDispatcher :> AppComponent {
        doc
        /*
         * The #run click handler: baseMsg, dispatchCompute, spawnWorker,
         * startSingleWorker, computeDensityField (pool + f64 merge),
         * startDensityBackend / startSingleBackend, startGraphCompute,
         * startComparePair / startDensityCompare, runInterp, wasmTicker,
         * computeDone, computeFailed; plus cancelActiveCompute (top level).
         */
        :>> keyFunctions = ("cancelActiveCompute", "dispatchCompute", "computeDensityField",
            "startDensityBackend", "startSingleBackend", "startGraphCompute", "computeDone");
    }
    part def BackendClient :> AppComponent {
        doc /* refreshBackendCores (GET /health, 2 s timeout), backendServesNDirs (>= 0.2.0), effectiveBackendUrl, cloudComputeHeaders. */
        :>> keyFunctions = ("refreshBackendCores", "backendServesNDirs", "effectiveBackendUrl", "cloudComputeHeaders");
    }
    part def CloudClient :> AppComponent {
        doc /* ensureCloudVm, cloudFetchJson, start/stopCloudKeepalive, stopCloudVm, beaconStopCloudVm, cloudClientId. */
        :>> keyFunctions = ("ensureCloudVm", "startCloudKeepalive", "stopCloudVm", "beaconStopCloudVm", "cloudClientId");
    }
    part def KpiEvaluator :> AppComponent {
        doc /* 3B Acessibilidade (KPIs 300 kJ): installKpiResult, kpiInvalidate, #kpi-corr, CSV exports (KP-01..04). */
        :>> keyFunctions = ("installKpiResult", "kpiInvalidate", "kpiExportRefsCsv", "kpiExportMatrixCsv");
    }
    part def MapView :> AppComponent {
        doc
        /*
         * Leaflet map + geoman drawing: basemaps (osm, carto-dark, carto-light,
         * esri-satellite, none-black), RMSAMPA hydrography tiles, energy/passes
         * overlays and their style knobs (never recompute, CO-11), routes,
         * layer order popover, legend.
         */
    }
    part def BundleIO :> AppComponent {
        doc /* downloadBundle, loadBundleFile, buildMetadata, applyMetadataToUI, exportRenderedImages, collectConfig/applyConfig. */
        :>> keyFunctions = ("downloadBundle", "loadBundleFile", "buildMetadata", "applyMetadataToUI",
            "exportRenderedImages", "collectConfig", "applyConfig");
    }
    part def ParamStore :> AppComponent {
        doc /* PERSIST_IDS persisted to localStorage; bundles apply with persist:false. */
    }

    part def AppController {
        doc
        /*
         * app.js: the whole UI in one classic script (~13 k lines), loaded by
         * index.html with no build step. Holds the global `state` (workers,
         * computeGen, calibration, calibrationGen, dem, network*, impassable*,
         * bridges*, refPoints, refPopM, kpi, lastRun, lastResult, cloud, ...).
         */
        part src : SourceArtefact { :>> path = "app.js"; :>> deployed = true; }
        part i18n : I18n;
        part demLoader : DemLoader;
        part demSmoother : DemSmoother;
        part networkLoader : NetworkLoader;
        part waterMaskBuilder : WaterMaskBuilder;
        part bridgeLoader : BridgeLoader;
        part referenceManager : ReferenceManager;
        part runEstimator : RunEstimator;
        part engineSelector : EngineSelector;
        part computeDispatcher : ComputeDispatcher;
        part backendClient : BackendClient;
        part cloudClient : CloudClient;
        part kpiEvaluator : KpiEvaluator;
        part mapView : MapView;
        part bundleIO : BundleIO;
        part paramStore : ParamStore;

        attribute computeSource : ComputeSource;
        attribute useWasm : Boolean = true { doc /* #use-wasm "Motor WebAssembly", default ON since v80 */ }
        attribute maxWorkers : Natural[0..1] { doc /* #max-workers override */ }

        port workerPorts : ~EnginePort[0..*];
        port backendPort : ~ComputeHttpPort[0..1];
        port cloudControl : ~CloudControlPort[0..1];
        port overpass : ~OverpassPort;
        port rangeSources : ~HttpRangeSourcePort[0..*];
        port tiles : ~TileSourcePort[0..*];
        port geocoder : ~GeocoderPort;
        port cdnScripts : ~CdnScriptPort[0..*];
    }

    // =====================================================================
    // PWA shell
    // =====================================================================

    part def ServiceWorker {
        doc
        /*
         * sw.js: VERSION v81; caches simu-precache-<V> / simu-runtime-<V>
         * (runtime capped at 30 MiB). Install: cache.addAll(PRECACHE_URLS,
         * reload) + skipWaiting (atomic, WEB-03). Activate: drop other caches,
         * clients.claim. Fetch: non-GET pass-through; .tif/.tiff/.gpkg/.fgb and
         * photon bypass; navigations network-first falling back to index.html;
         * everything else cache-first + stale-while-revalidate (CDN libs).
         */
        part src : SourceArtefact { :>> path = "sw.js"; :>> deployed = true; }
        attribute version : String = "v81";
        attribute precacheUrls : String[*] = ("index.html", "app.js", "energy-worker.js",
            "graph-engine.js", "wasm-worker.js", "engine32.wasm", "manifest.webmanifest",
            "icons/icon-v2.svg", "icons/icon-192-v2.png", "icons/icon-512-v2.png",
            "icons/icon-maskable-192-v2.png", "icons/icon-maskable-512-v2.png",
            "icons/apple-touch-icon-v2.png", "vocab/simujoules.jsonld");
        attribute maxRuntimeBytes : Natural = 31457280;
    }

    part def PageShell {
        doc
        /*
         * index.html: panel UI (groups 0 Importar/Exportar; 1 Dados de entrada
         * 1A-1D; 2 Configuracao 2A Parametros, 2B Pontos, 2C Execucao; 3
         * Resultados 3A-3D), map container, help modal with the changelog
         * <details>, SRI-pinned CDN scripts. manifest.webmanifest: "Simulador
         * bici-geo-energetico" / Simujaules, pt-BR, standalone.
         */
        part html : SourceArtefact { :>> path = "index.html"; :>> deployed = true; }
        part manifest : SourceArtefact { :>> path = "manifest.webmanifest"; :>> deployed = true; }
        part icons : SourceArtefact { :>> path = "icons/"; :>> deployed = true; }
        attribute cdnLibraries : String[*] = ("leaflet@1.9.4", "@geoman-io/leaflet-geoman-free@2.18.3",
            "geotiff@3.0.5", "jszip@3.10.1", "proj4@2.9.0", "sql.js@1.10.3", "flatgeobuf@3.36.0");
    }

    part def BrowserApp {
        doc /* The PWA as it runs in one browser tab. */
        part shell : PageShell;
        part serviceWorker : ServiceWorker;
        part app : AppController;
        part workerPool : WasmWorker[0..*] {
            doc
            /*
             * Regular runs: ONE worker. Density: a pool of densityPoolSize()
             * workers = min(K, cores-1, memCap) (CO-01). Plain energy-worker.js
             * workers when wasm is off; the probe and interp run on JS.
             */
        }
        part examples : SourceArtefact { :>> path = "dem/"; :>> deployed = true; }
        part vocab : SourceArtefact { :>> path = "vocab/simujoules.jsonld"; :>> deployed = true; }
        part paper : SourceArtefact {
            doc /* modelo/: the model paper (PT/EN html + PDFs + figs), served at /modelo/. */
            :>> path = "modelo/"; :>> deployed = true;
        }
        part llms : SourceArtefact { :>> path = "llms.txt"; :>> deployed = true; }

        interface workerChannel : WorkerChannel connect app.workerPorts to workerPool.engine;
    }

    // =====================================================================
    // Headless tooling (never deployed)
    // =====================================================================

    part def CensusHarness {
        doc
        /*
         * census/: IBGE Censo 2022 setores (population v0001).
         * download_census.py (geoftp.ibge.gov.br), build_fgb.py (GDAL join ->
         * setores_br_pop.fgb, uploaded to GCS by hand), sample_census.py
         * (population-weighted Sobol -> points.geojson), census-density.mjs
         * (headless densityPartial run -> v3 bundle zip; exports loadDem,
         * deriveCost, runDensity, writers; hand-copies G_SP).
         */
        part src : SourceArtefact { :>> path = "census/"; }
        part engine : JsEngine;
    }

    part def McpServer {
        doc
        /*
         * mcp/ (simujaules-mcp 0.1.0, stdio). server.mjs registers the tools;
         * lib.mjs buildRunMessage is the headless mirror of baseMsg (no network,
         * bridges or impassable layers yet, CO-13); engine-thread.mjs hosts
         * energy-worker.js in worker_threads; dem-thread.mjs decodes + smooths
         * (sigma 30 m auto) off the main thread. Imports the census harness and
         * the test-dem-smoothing.mjs mirror rather than copying them.
         */
        part src : SourceArtefact { :>> path = "mcp/"; }
        part engineThread : JsEngine;
        ref part census : CensusHarness;
        port stdio : McpStdioPort;
    }

    part def ResearchHarness {
        doc
        /*
         * docs/grid-*.mjs (adaptive, correct, e26, eik, longedge, pull, sens):
         * analysis harnesses behind docs/grid-connectivity-sensitivity-2026-07-11.md.
         * Each self-validates its 8-move engine bit-identical to energy-worker.js.
         */
        part src : SourceArtefact { :>> path = "docs/"; }
    }

    part def BridgeElevationReviewTool {
        doc /* tools/bridge-ele-review: human review of GeoSampa ponto_intervia deck elevations for SP bridges. */
        part src : SourceArtefact { :>> path = "tools/bridge-ele-review/"; }
    }

    // =====================================================================
    // Cloud compute plane (optional)
    // =====================================================================

    part def Orchestrator {
        doc
        /*
         * orchestrator/main.py, Cloud Run service simu-orchestrator
         * (southamerica-east1, scale-to-zero, max 1 instance, gunicorn
         * --workers 1 --threads 8). Lifecycle only: create/start/stop/delete/reap
         * the VM, patch firewall simu-compute-allow-443 to recent client /32s
         * (last X-Forwarded-For hop, 2 h window, <= 8 IPs), rewrite DNS (stop ->
         * 127.0.0.1 placeholder). Secrets: simu-cloud-token, simu-cf-dns-token,
         * simu-reap-token.
         */
        part src : SourceArtefact { :>> path = "orchestrator/"; }
        port control : CloudControlPort;
        port gcp : ~GcpComputeApiPort;
        port dns : ~DnsApiPort;
        attribute serviceName : String = "simu-orchestrator";
        attribute machineTypes : String[*] = ("n2-standard-8", "n2-standard-32", "n2-standard-128");
        attribute leaseSeconds : Natural = 180;
        attribute reapIdleDays : Natural = 30;
    }

    part def CaddyProxy {
        doc /* TLS (DNS-01 via caddy-dns/cloudflare), Bearer check, CORS rewrite, reverse_proxy 127.0.0.1:8077. */
        port publicPort : AuthenticatedComputePort;
        port upstream : ~ComputeHttpPort;
    }

    part def IdleWatchdog {
        doc /* simujoules-watchdog.timer (~1/min): shutdown if /health idle_seconds > 900 or uptime > 7200 s. */
        attribute idleMaxS : Natural = 900;
        attribute maxUptimeS : Natural = 7200;
        port health : ~ComputeHttpPort;
    }

    part def ComputeVm {
        doc
        /*
         * GCE Spot VM simu-compute (southamerica-east1-a; default n2-standard-128:
         * 128 vCPU / 512 GB; termination STOP; max run 4 h). vm/startup-script.sh
         * every boot: watchdog units, backend binary (download or cargo build),
         * simujoules-backend.service on 127.0.0.1:8077 --max-mem-gb, Caddy.
         * vm/bake-instance.sh provisions once and leaves it STOPPED.
         */
        part src : SourceArtefact { :>> path = "vm/"; }
        part backend : NativeBackend;
        part caddy : CaddyProxy;
        part watchdog : IdleWatchdog;
        attribute instanceName : String = "simu-compute";
        attribute provisioning : String = "SPOT";

        interface proxied : ComputeHttpInterface connect caddy.upstream to backend.http;
        interface watched : ComputeHttpInterface connect watchdog.health to backend.http;
    }

    part def CloudComputePlane {
        doc
        /*
         * Two planes (CL-01): CONTROL browser -> orchestrator (lifecycle);
         * DATA browser -> https://compute.simujaules.pedalhidrografi.co (Caddy)
         * -> backend, never through the orchestrator.
         */
        part orchestrator : Orchestrator;
        part vm : ComputeVm[0..1];
    }

    // =====================================================================
    // Delivery
    // =====================================================================

    part def DeployScript {
        doc
        /*
         * deploy.sh: stage the explicit allow-list (WEB-09), stamp() ?v=VERSION
         * into worker/wasm/app references (grep-verified), gcloud storage rsync
         * to gs://simujaules, set Cache-Control (sw.js no-cache, index.html 300,
         * JS/wasm 3600, icons 30 d, ...), Cloudflare purge of staged URLs.
         */
        part src : SourceArtefact { :>> path = "deploy.sh"; }
        port bucket : ~ObjectStorePort;
        port purge : ~CachePurgePort;
        attribute shippedFiles : String[*] = ("index.html", "app.js", "energy-worker.js",
            "graph-engine.js", "favicon.ico", "wasm-worker.js", "engine32.wasm", "engine64.wasm",
            "dem/*.tif", "vocab/simujoules.jsonld", "modelo/index.html", "modelo/en.html",
            "modelo/artigo.pdf", "modelo/paper.pdf", "modelo/figs/*.svg", "llms.txt",
            "sitemap.xml", "CHANGELOG.md", "manifest.webmanifest", "sw.js", "icons/*-v2.*");
    }

    part def CiWorkflow {
        doc
        /*
         * .github/workflows/deploy.yml: job "test" (node 22) on PRs to
         * main/deploy, pushes to deploy and workflow_dispatch; job "deploy"
         * (needs test, only refs/heads/deploy, inert until the WIF variables
         * exist) authenticates keylessly via Workload Identity Federation,
         * pulls gs://simujaules/dem/*.tif and runs deploy.sh.
         */
        part src : SourceArtefact { :>> path = ".github/workflows/deploy.yml"; }
        attribute testedSuites : String[*] = ("test-worker-pool.mjs", "test-energy-v2.mjs",
            "test-dem-smoothing.mjs", "test-graph-engine.mjs", "test-water-raster.mjs",
            "census/test-census-sampler.mjs");
    }

    part def WasmBuild {
        doc
        /*
         * wasm/build.sh: (1) cargo build --release --target wasm32-unknown-unknown
         * -> engine32.wasm; (2) cargo +nightly -Zbuild-std=std,panic_abort
         * --target wasm64-unknown-unknown with --max-memory=17179869184 ->
         * engine64.wasm; (3) chmod 644. Must follow every main.rs change (EP-04).
         */
        part src : SourceArtefact { :>> path = "wasm/"; }
    }

    part def DeliveryPipeline {
        part ci : CiWorkflow;
        part deployScript : DeployScript;
        part wasmBuild : WasmBuild;
    }

    // =====================================================================
    // The system of interest
    // =====================================================================

    part def SimujaulesSystem {
        doc
        /*
         * Simujaules: asymmetric-cost cycling energy fields over DEMs. The
         * browser app is the product; the native backend, cloud plane and MCP
         * server are optional accelerators / access paths sharing its engines.
         */
        part browserApp : BrowserApp;
        part localBackend : NativeBackend[0..1] {
            doc /* cargo run --release in backend/, compute source "localhost". */
        }
        part cloudPlane : CloudComputePlane[0..1];
        part mcpServer : McpServer[0..1];
        part censusHarness : CensusHarness;
        part researchHarnesses : ResearchHarness;
        part bridgeReview : BridgeElevationReviewTool;
        part delivery : DeliveryPipeline;

        interface localCompute : ComputeHttpInterface
            connect browserApp.app.backendPort to localBackend.http;
        interface cloudCompute : ComputeHttpInterface
            connect browserApp.app.backendPort to cloudPlane.vm.caddy.publicPort;
        interface cloudControl : CloudControlInterface
            connect browserApp.app.cloudControl to cloudPlane.orchestrator.control;
    }
}
