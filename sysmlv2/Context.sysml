package SimujaulesSystemContext {
    doc
    /*
     * The system in its world: who uses it (actors + use cases), what it
     * depends on (external services and sibling Pedal Hidrografico repos, as
     * black boxes), where each part runs (execution platforms + allocations),
     * and which part satisfies which requirement. `simujaulesContext` at the
     * bottom is the root usage of the whole model.
     */

    private import ScalarValues::*;
    private import SimujaulesDomain::*;
    private import SimujaulesInterfaces::*;
    private import SimujaulesStructure::*;
    private import SimujaulesRequirements::*;

    // =====================================================================
    // Actors
    // =====================================================================

    part def RidePlanner {
        doc
        /*
         * A member of the Pedal Hidrografico collective (or anyone) planning
         * rides that "seguir as aguas": loads a DEM, clicks anchors, reads energy
         * fields, corridors and accessibility KPIs. UI in pt-BR (or en).
         */
    }
    part def Researcher {
        doc /* Exports bundles to QGIS, runs census density and the docs/ research harnesses. */
    }
    part def AiAgent {
        doc /* Claude Code / Desktop calling the MCP server over stdio. */
    }
    part def Maintainer {
        doc /* Ships releases (Release action), provisions the cloud plane, runs the local suites. */
    }

    // =====================================================================
    // Use cases
    // =====================================================================

    use case def ComputeEnergyField {
        doc /* Minimum energy from / to / round-trip an anchor to every cell, optionally with passes and a destination path. */
        subject sys : SimujaulesSystem;
        actor planner : RidePlanner;
    }
    use case def FindAlternativeRoutes {
        doc /* A* top-N between two points with per-cell / linear / square repulsion; optional string pulling. */
        subject sys : SimujaulesSystem;
        actor planner : RidePlanner;
    }
    use case def MapNaturalCorridors {
        doc /* Multi-reference density (clicked, Sobol, random or census-weighted refs), the max-density segment. */
        subject sys : SimujaulesSystem;
        actor planner : RidePlanner;
    }
    use case def AssessAccessibility {
        doc /* 3B KPIs: share of refs / people reachable within 300 kJ thresholds, from the ref<->ref matrix. */
        subject sys : SimujaulesSystem;
        actor planner : RidePlanner;
    }
    use case def ConstrainToStreets {
        doc /* Restrict to an OSM / gpkg street network (raster mask or graph mode), compare against unconstrained. */
        subject sys : SimujaulesSystem;
        actor planner : RidePlanner;
    }
    use case def ExportForGis {
        doc /* Reproducible bundle (GeoTIFF + GeoJSON + metadata.jsonld) and rendered PNG + world file for QGIS. */
        subject sys : SimujaulesSystem;
        actor researcher : Researcher;
    }
    use case def RunOnCloudVm {
        doc /* Compute source "cloud": start the Spot VM through the orchestrator, compute directly on it. */
        subject sys : SimujaulesSystem;
        actor planner : RidePlanner;
    }
    use case def QueryFromAgent {
        doc /* load_dem / energy_field / route / energy_at / density through the MCP server. */
        subject sys : SimujaulesSystem;
        actor agent : AiAgent;
    }
    use case def ShipRelease {
        doc /* Bump VERSION + changelog trio, release commit, push deploy, CI tests, deploy.sh. */
        subject sys : SimujaulesSystem;
        actor maintainer : Maintainer;
    }

    // =====================================================================
    // External services (black boxes)
    // =====================================================================

    part def OverpassApi {
        doc /* overpass-api.de: OSM streets, water (incl. natural=coastline) and bridges for the current extent. */
        port api : OverpassPort;
    }
    part def OsmBasemaps {
        doc /* tile.openstreetmap.org, basemaps.cartocdn.com (dark/light nolabels), server.arcgisonline.com World_Imagery. */
        port tiles : TileSourcePort;
    }
    part def TelhasTiles {
        doc
        /*
         * telhas.pedalhidrografi.co: the collective's custom hydrography raster
         * (RMSAMPA_URL rmsampa-v2/{z}/{x}/{y}.png), shared with amora.
         */
        port tiles : TileSourcePort { :>> urlTemplate = "https://telhas.pedalhidrografi.co/rmsampa-v2/{z}/{x}/{y}.png"; }
    }
    part def PhotonGeocoder {
        doc /* photon.komoot.io place search. */
        port api : GeocoderPort;
    }
    part def ScriptCdns {
        doc /* unpkg, cdn.jsdelivr.net, cdnjs: Leaflet, geoman, geotiff.js, JSZip, proj4, sql.js, flatgeobuf (SRI-pinned). */
        port scripts : CdnScriptPort;
    }

    part def R2DataBucket {
        doc
        /*
         * Cloudflare R2 behind fabdem.pedalhidrografi.co (no egress cost, v81):
         * FABDEM V1-2 COG tiles ({N|S}LL{E|W}LLL_FABDEM_V1-2.tif) and the
         * South-America FlatGeobufs (viario/south-america-viario.fgb,
         * south-america-water-areas.fgb, south-america-water-rivers.fgb), read
         * by HTTP Range. FGBs over 500 MB are served Cache-Control: private.
         */
        port fabdem : HttpRangeSourcePort { :>> url = "https://fabdem.pedalhidrografi.co/"; }
        port viario : HttpRangeSourcePort { :>> url = "https://fabdem.pedalhidrografi.co/viario/south-america-viario.fgb"; }
        port waterAreas : HttpRangeSourcePort { :>> url = "https://fabdem.pedalhidrografi.co/south-america-water-areas.fgb"; }
        port waterRivers : HttpRangeSourcePort { :>> url = "https://fabdem.pedalhidrografi.co/south-america-water-rivers.fgb"; }
    }

    part def IbgeCensus {
        doc /* IBGE Censo 2022 setores censitarios (geoftp.ibge.gov.br), population v0001 of the basico aggregates. */
    }
    part def GeoSampa {
        doc /* Sao Paulo municipal GIS: ponto_intervia deck elevations reviewed by tools/bridge-ele-review. */
    }
    part def BicyclingEnergyModel {
        doc
        /*
         * Sibling repo bicycling-energy-model: the canonical v2 derivation and
         * the journal (Entries 18-20, 27, 74) behind the clamp proof, gravity,
         * smoothing sigma and calibration accuracy. It moves first; this repo
         * re-syncs its constants by hand.
         */
    }
    part def AmoraViarioBuild {
        doc /* Sibling repo amora: build-viario.py produces the South-America viario / water FGBs. */
    }
    part def Qgis {
        doc /* Desktop GIS consuming exported bundles and rendered PNG + world files. */
    }

    // =====================================================================
    // Execution platforms
    // =====================================================================

    part def UserBrowser {
        doc /* Any modern browser: page, service worker, Web Worker pool, WebAssembly (Memory64 where available). */
    }
    part def DeveloperMachine {
        doc /* A laptop running node suites, cargo builds, the localhost backend, the MCP server and the census harness. */
    }
    part def StaticHosting {
        doc
        /*
         * gs://simujaules (GCS) as the origin of https://simujaules.pedalhidrografi.co,
         * fronted by Cloudflare (cache rules + purge; NOT Cloud CDN). Also holds
         * census/setores_br_pop.fgb (storage.googleapis.com/simujaules/census/)
         * and vm/startup-script.sh.
         */
        port bucket : ObjectStorePort { :>> bucket = "gs://simujaules"; }
        port purge : CachePurgePort;
        port census : HttpRangeSourcePort {
            :>> url = "https://storage.googleapis.com/simujaules/census/setores_br_pop.fgb";
        }
    }
    part def CloudRunPlatform {
        doc /* Google Cloud Run, project pedal-hidrografico, region southamerica-east1. */
    }
    part def ComputeEnginePlatform {
        doc /* GCE southamerica-east1-a (N2 family; C4 quota is 0 in the region). */
        port api : GcpComputeApiPort;
    }
    part def CloudflareDns {
        doc /* Zone pedalhidrografi.co: DNS-only A record for compute.simujaules (TTL 60) + DNS-01 for Caddy. */
        port api : DnsApiPort;
    }
    part def GitHub {
        doc /* github.com/pedalhidro/simujaules: source, PRs, Actions runners (OIDC -> GCP Workload Identity Federation). */
    }

    allocation def Deployment {
        doc /* A logical part allocated to the platform it executes on. */
    }

    // =====================================================================
    // The root usage
    // =====================================================================

    part simujaulesContext {
        doc /* Simujaules and everything around it. */

        part system : SimujaulesSystem;

        // actors
        part planner : RidePlanner;
        part researcher : Researcher;
        part agent : AiAgent;
        part maintainer : Maintainer;

        // use cases performed against the system
        use case computeEnergyField : ComputeEnergyField {
            subject :>> sys = system;
            actor :>> planner = simujaulesContext.planner;
        }
        use case findAlternativeRoutes : FindAlternativeRoutes {
            subject :>> sys = system;
            actor :>> planner = simujaulesContext.planner;
        }
        use case mapNaturalCorridors : MapNaturalCorridors {
            subject :>> sys = system;
            actor :>> planner = simujaulesContext.planner;
        }
        use case assessAccessibility : AssessAccessibility {
            subject :>> sys = system;
            actor :>> planner = simujaulesContext.planner;
        }
        use case constrainToStreets : ConstrainToStreets {
            subject :>> sys = system;
            actor :>> planner = simujaulesContext.planner;
        }
        use case exportForGis : ExportForGis {
            subject :>> sys = system;
            actor :>> researcher = simujaulesContext.researcher;
        }
        use case runOnCloudVm : RunOnCloudVm {
            subject :>> sys = system;
            actor :>> planner = simujaulesContext.planner;
        }
        use case queryFromAgent : QueryFromAgent {
            subject :>> sys = system;
            actor :>> agent = simujaulesContext.agent;
        }
        use case shipRelease : ShipRelease {
            subject :>> sys = system;
            actor :>> maintainer = simujaulesContext.maintainer;
        }

        // external services and sibling repos
        part overpass : OverpassApi;
        part basemaps : OsmBasemaps;
        part telhas : TelhasTiles;
        part photon : PhotonGeocoder;
        part cdns : ScriptCdns;
        part r2 : R2DataBucket;
        part ibge : IbgeCensus;
        part geoSampa : GeoSampa;
        part bicyclingEnergyModel : BicyclingEnergyModel;
        part amora : AmoraViarioBuild;
        part qgis : Qgis;

        // execution platforms
        part userBrowser : UserBrowser;
        part developerMachine : DeveloperMachine;
        part staticHosting : StaticHosting;
        part cloudRun : CloudRunPlatform;
        part computeEngine : ComputeEnginePlatform;
        part cloudflareDns : CloudflareDns;
        part github : GitHub;

        // what the browser app consumes
        connect system.browserApp.app.overpass to overpass.api;
        connect system.browserApp.app.tiles to basemaps.tiles;
        connect system.browserApp.app.tiles to telhas.tiles;
        connect system.browserApp.app.geocoder to photon.api;
        connect system.browserApp.app.cdnScripts to cdns.scripts;
        connect system.browserApp.app.rangeSources to r2.fabdem;
        connect system.browserApp.app.rangeSources to r2.viario;
        connect system.browserApp.app.rangeSources to r2.waterAreas;
        connect system.browserApp.app.rangeSources to r2.waterRivers;
        connect system.browserApp.app.rangeSources to staticHosting.census;

        // operations
        connect system.delivery.deployScript.bucket to staticHosting.bucket;
        connect system.delivery.deployScript.purge to staticHosting.purge;
        connect system.cloudPlane.orchestrator.gcp to computeEngine.api;
        connect system.cloudPlane.orchestrator.dns to cloudflareDns.api;

        // where each part runs
        allocation browserDeployment : Deployment allocate system.browserApp to userBrowser;
        allocation backendDeployment : Deployment allocate system.localBackend to developerMachine;
        allocation mcpDeployment : Deployment allocate system.mcpServer to developerMachine;
        allocation censusDeployment : Deployment allocate system.censusHarness to developerMachine;
        allocation researchDeployment : Deployment allocate system.researchHarnesses to developerMachine;
        allocation reviewToolDeployment : Deployment allocate system.bridgeReview to developerMachine;
        allocation orchestratorDeployment : Deployment allocate system.cloudPlane.orchestrator to cloudRun;
        allocation vmDeployment : Deployment allocate system.cloudPlane.vm to computeEngine;
        allocation ciDeployment : Deployment allocate system.delivery.ci to github;
        allocation deployScriptDeployment : Deployment allocate system.delivery.deployScript to github {
            doc /* runs in the CI deploy job; also runnable by hand on a developer machine */
        }
        allocation servedFiles : Deployment allocate system.browserApp.shell to staticHosting {
            doc /* the deploy.sh allow-list is published to gs://simujaules and served through Cloudflare */
        }

        // ---- who satisfies what ------------------------------------------

        // product
        satisfy viewingEqualsRouting by system;
        satisfy localEdgeCosts by system.browserApp.workerPool;
        satisfy clientSideByDefault by system;
        satisfy offlineAfterFirstLoad by system;
        satisfy backendFallback by system.browserApp.app;
        satisfy riderAccuracy by system;
        satisfy estimatorAccuracy by system.browserApp.app;
        satisfy probeResponsiveness by system.browserApp.app;
        satisfy reproducibleBundle by system.browserApp.app;
        satisfy bilingualUi by system.browserApp.app;
        satisfy memoryBoundedScale by system;

        // engine parity: the native core (shared by backend and wasm) vs the JS worker
        satisfy jsRustEnergyParity by system.localBackend.core;
        satisfy passesTieTolerance by system.localBackend.core;
        satisfy wasmIsBackendEngine by system.browserApp.workerPool.module.core;
        satisfy wasmRebuiltWithBackend by system.browserApp.workerPool.module.core;
        satisfy classicEightAnchor by system.browserApp.workerPool;
        satisfy v8ExactMath by system.localBackend.core;
        satisfy portalParity by system.localBackend.core;
        satisfy matrixParity by system.localBackend.core;
        satisfy accumulatorPrecision by system.localBackend.core;
        satisfy settledGuard by system.browserApp.workerPool;
        satisfy densityCostModelIdentity by system.browserApp.workerPool;
        satisfy longEdgeIntegration by system.browserApp.workerPool;
        satisfy classicEightModes by system.browserApp.workerPool;
        satisfy descentClampKept by system.localBackend.core;
        satisfy graphModePortalBlind by system.browserApp.workerPool.graph;
        satisfy memory64MaxMemory by system.browserApp.workerPool.module.core;

        // physics
        satisfy localGravity by system;
        satisfy fabdemCaveat by system;

        // preprocessing, orchestration, KPIs (all app.js)
        satisfy smoothingAppSideOnly by system.browserApp.app;
        satisfy smoothingAutoRule by system.browserApp.app;
        satisfy smoothingMirror by system.browserApp.app;
        satisfy waterMaskMirror by system.browserApp.app;
        satisfy censusSamplerMirror by system.browserApp.app;
        satisfy geographicBridgeGuard by system.browserApp.app;
        satisfy sharedPoolSizing by system.browserApp.app;
        satisfy sharedPredictor by system.browserApp.app;
        satisfy backendMemoryModelMirror by system.browserApp.app;
        satisfy wasmMemoryModelMirror by system.browserApp.app;
        satisfy sharedEngineSelection by system.browserApp.app;
        satisfy cancelBeforeGridChange by system.browserApp.app;
        satisfy probeIsolation by system.browserApp.app;
        satisfy interpAfterMerge by system.browserApp.app;
        satisfy portalsCloned by system.browserApp.app;
        satisfy nDirsVersionGate by system.browserApp.app;
        satisfy styleNeverRecomputes by system.browserApp.app;
        satisfy stringPullDisplayOnly by system.browserApp.app;
        satisfy headlessMessageMirror by system.browserApp.app;
        satisfy wasmCorrectionHygiene by system.browserApp.app;
        satisfy kpiCacheDiscipline by system.browserApp.app;
        satisfy kpiExactnessBound by system.browserApp.app;
        satisfy refPopulationOwnership by system.browserApp.app;
        satisfy gridCorrectionLayer by system.browserApp.app;
        satisfy escapeUserStrings by system.browserApp.app;
        satisfy i18nOnly by system.browserApp.app;

        // web / release
        satisfy noBuildStep by system;
        satisfy swVersionBump by system;
        satisfy precacheConsistency by system;
        satisfy changelogTrio by system;
        satisfy releaseCommit by system;
        satisfy sriCrossorigin by system;
        satisfy deployAllowList by system;
        satisfy stableVocabIri by system;

        // cloud
        satisfy controlDataPlaneSplit by system.cloudPlane;
        satisfy requesterOnlyFirewall by system.cloudPlane;
        satisfy idleShutdown by system.cloudPlane;
        satisfy ephemeralIpDns by system.cloudPlane;
    }
}
