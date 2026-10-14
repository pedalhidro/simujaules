package SimujaulesBehavior {
    doc
    /*
     * Behaviour: the main flows as action defs and the lifecycles as state
     * defs. Action steps are named after the real functions so the model can
     * be read against app.js / sw.js / orchestrator/main.py.
     */

    private import ScalarValues::*;
    private import ISQ::*;
    private import SI::*;
    private import SimujaulesDomain::*;
    private import SimujaulesInterfaces::*;
    private import SimujaulesStructure::*;

    // =====================================================================
    // Signals
    // =====================================================================

    item def RunRequested { doc /* #run clicked (or an MCP / census harness run). */ }
    item def GridChanged { doc /* DEM load or network load/clear: the grid a result renders against changed. */ }
    item def SliceDone { attribute generation : Natural; }
    item def AllSlicesMerged;
    item def ComputeError { attribute reason : String; }
    item def StyleEdited { doc /* colormap / range / gamma / blend edit: re-render only (CO-11). */ }
    item def ThresholdEdited { doc /* KPI threshold or #kpi-corr edit: re-evaluate state.kpi only (KP-01). */ }

    item def CreateVm;
    item def StartVm;
    item def VmBooted;
    item def Keepalive;
    item def StopVm;
    item def IdleTimeout { doc /* watchdog: idle_seconds > 900 or uptime > 7200 s */ }
    item def SpotPreempted;
    item def MaxRunDurationReached { doc /* GCE --max-run-duration 4 h, termination action STOP */ }
    item def DeleteVm;
    item def Reap { doc /* /cloud/reap: delete if STOPPED > REAP_IDLE_DAYS (30) */ }

    item def SwInstalled;
    item def NewVersionDeployed { doc /* a new sw.js (VERSION bump) is fetched; sw.js is served no-cache. */ }

    // =====================================================================
    // DEM load
    // =====================================================================

    action def LoadDem {
        doc
        /*
         * loadDemFromArrayBuffer / loadDemFromUrl / loadFabdemForView. Order
         * matters: cancel first (CO-06), smooth before anything is shipped to an
         * engine (PP-01), invalidate the KPI cache, then calibrate with a fresh
         * generation (CO-07).
         */
        in item dem : Dem;
        out attribute grid : Grid;

        action cancelActiveCompute { doc /* bump state.computeGen, terminate state.workers */ }
        action decodeGeoTiff { doc /* geotiff.js; FABDEM: COG tiles via GeoTIFF.fromUrl */ }
        action cropOrDownsample { doc /* optional #crop-dem / #downsample-dem */ }
        action smoothHeightsInPlace { doc /* sigma per #dem-smooth; auto = 30 m unless ImageDescription says smoothed */ }
        action kpiInvalidate;
        action bumpCalibrationGen;
        action startCalibrationProbe { doc /* kind "probe" worker, maxSettled-capped, skipped while computing */ }

        first cancelActiveCompute then decodeGeoTiff;
        first decodeGeoTiff then cropOrDownsample;
        first cropOrDownsample then smoothHeightsInPlace;
        first smoothHeightsInPlace then kpiInvalidate;
        first kpiInvalidate then bumpCalibrationGen;
        first bumpCalibrationGen then startCalibrationProbe;
    }

    action def LoadLayer {
        doc
        /*
         * 1B/1C/1D layer pulls. Streets: gpkg (sql.js) | Overpass | viario FGB
         * -> installNetworkFromLines. Water: Overpass | FGB -> osmWaterGeom ->
         * rebuildOsmWaterMask. Bridges: Overpass | viario FGB | network ->
         * installBridgesFromWays (refused on projected DEMs, PP-06). A network
         * change cancels the active compute (CO-06) and invalidates KPIs; a
         * bridge change does NOT invalidate the cached street graph (EP-15).
         */
        action fetchSource;
        action cancelActiveCompute;
        action install;
        action kpiInvalidate;
        first fetchSource then cancelActiveCompute;
        first cancelActiveCompute then install;
        first install then kpiInvalidate;
    }

    // =====================================================================
    // Running a compute
    // =====================================================================

    action def SelectEngine {
        doc
        /*
         * Shared by the runner AND currentRunOpts (CO-05): computeSource
         * (browser / localhost / cloud), then for browser runs wasmEngineFor ->
         * densityEngine / singleEngine. A pool switches to wasm only when
         * workers x wasmSpeedup beats JS and the job fits memBudgetBytes()
         * (unless #max-workers). Backend nDirs != 8 requires >= 0.2.0 (CO-10).
         */
        in attribute config : RunConfig;
        in attribute source : ComputeSource;
        out attribute engine : EngineKind;
    }

    action def DensityPoolRun {
        doc
        /*
         * computeDensityField: densityPoolSize() slices, each a kind "run" with
         * densityPartial: true (+ wantMatrix/matrixCells when KPIs apply),
         * portals CLONED (CO-09). Raw accumulators are merged in f64 and
         * normalised once; the optional IDW fill runs after the merge (CO-08).
         */
        in attribute k : Natural;
        out item result : RunResult;

        action sizePool { doc /* densityPoolSize({N, K, round, nDirs, hasNet, engine}) */ }
        action spawnSlices { doc /* spawnWorker x poolSize; refPoints sliced */ }
        action awaitSlices { doc /* drop replies whose generation != state.computeGen */ }
        action mergeAccumulators { doc /* f64 density / energySum / energyCount + matrix blocks */ }
        action normalise;
        action runInterp { doc /* kind "interp" (optionally banded), only if wantNetworkInterp */ }

        first sizePool then spawnSlices;
        first spawnSlices then awaitSlices;
        first awaitSlices then mergeAccumulators;
        first mergeAccumulators then normalise;
        first normalise then runInterp;
    }

    action def RunCompute {
        doc
        /*
         * The #run handler (dispatchCompute). Captures state.computeGen and a
         * state.lastRun snapshot (predicted ms, engine). Any backend / cloud /
         * wasm failure falls back to the browser JS workers (PR-05) unless
         * #cloud-no-fallback. computeDone feeds the online correction of the
         * engine that actually ran (CO-15) and installs fields in
         * state.lastResult, the matrix in state.kpi.
         */
        in attribute config : RunConfig;
        in attribute source : ComputeSource;
        out item result : RunResult;

        attribute isDensity : Boolean;
        attribute isGraphMode : Boolean;
        attribute onBackend : Boolean;

        action snapshotRun { doc /* state.computeGen++, state.lastRun = {..., predictedMs} */ }
        action selectEngine : SelectEngine;
        action ensureCloudVm { doc /* only for compute source cloud: /cloud/start, poll /cloud/status, then dataUrl/health */ }

        action densityOnPool : DensityPoolRun;
        action densityOnBackend { doc /* startDensityBackend: POST /density (gzip, X-Simu-Gzip) */ }
        action singleOnWorker { doc /* startSingleWorker: one worker, kind "run" (wasm job 1 when eligible) */ }
        action singleOnBackend { doc /* startSingleBackend: POST /single */ }
        action graphCompute { doc /* startGraphCompute: graphBuild (cached by networkGraphToken) + graphRun */ }
        action fallbackToBrowser { doc /* any failure -> browser workers */ }
        action computeDone { doc /* install result, update corrections, render, string pull display */ }

        first snapshotRun then selectEngine;
        first selectEngine then ensureCloudVm;
        first ensureCloudVm then dispatch;

        decide dispatch;
            if isGraphMode then graphCompute;
            if isDensity and onBackend then densityOnBackend;
            if isDensity and not onBackend then densityOnPool;
            if not isDensity and onBackend then singleOnBackend;
            else singleOnWorker;

        succession densityBackendFailed first densityOnBackend then fallbackToBrowser {
            doc /* taken only when the backend call fails */
        }
        succession singleBackendFailed first singleOnBackend then fallbackToBrowser {
            doc /* taken only when the backend call fails */
        }

        merge collect;
        first graphCompute then collect;
        first densityOnPool then collect;
        first densityOnBackend then collect;
        first singleOnWorker then collect;
        first singleOnBackend then collect;
        first fallbackToBrowser then collect;
        first collect then computeDone;
    }

    // =====================================================================
    // Lifecycles
    // =====================================================================

    state def ComputeLifecycle {
        doc
        /*
         * One generation of state.computeGen per run. GridChanged in any busy
         * state cancels (cancelActiveCompute) and returns to idle; style and
         * KPI-threshold edits never leave idle (CO-11, KP-01).
         */
        entry; then idle;

        state idle;
        state running;
        state merging { doc /* density pool merge */ }
        state interpolating { doc /* kind "interp" after the merge */ }
        state failed;

        transition first idle accept RunRequested then running;
        transition first idle accept StyleEdited then idle;
        transition first idle accept ThresholdEdited then idle;
        transition first running accept AllSlicesMerged then merging;
        transition first merging then interpolating;
        transition first interpolating then idle;
        transition first running accept ComputeError then failed;
        transition first failed then idle;
        transition first running accept GridChanged then idle;
        transition first merging accept GridChanged then idle;
        transition first interpolating accept GridChanged then idle;
    }

    state def CloudVmLifecycle {
        doc
        /*
         * simu-compute as driven by the orchestrator, the VM and GCE. Costs
         * accrue only in starting/running (CL-03).
         */
        entry; then absent;

        state absent;
        state stopped;
        state starting { doc /* firewall /32 + DNS rewrite + boot (startup-script) */ }
        state running { doc /* leases renewed by /cloud/keepalive every < 180 s */ }

        transition first absent accept CreateVm then stopped;
        transition first stopped accept StartVm then starting;
        transition first starting accept VmBooted then running;
        transition first running accept Keepalive then running;
        transition first running accept StopVm then stopped;
        transition first running accept IdleTimeout then stopped;
        transition first running accept SpotPreempted then stopped;
        transition first running accept MaxRunDurationReached then stopped;
        transition first stopped accept DeleteVm then absent;
        transition first stopped accept Reap then absent;
    }

    state def ServiceWorkerLifecycle {
        doc
        /*
         * sw.js: install = atomic cache.addAll(PRECACHE_URLS) + skipWaiting (one
         * 404 aborts, WEB-03); activate = delete caches of other VERSIONs +
         * clients.claim; then serve fetches until a new VERSION is deployed.
         */
        entry; then installing;

        state installing;
        state active;

        transition first installing accept SwInstalled then active;
        transition first active accept NewVersionDeployed then installing;
    }

    // =====================================================================
    // Release and deploy
    // =====================================================================

    action def Release {
        doc
        /*
         * Shipping a user-visible change (WEB-02, WEB-04, WEB-05). Engine edits
         * add the local-only suites (backend, wasm, mcp, census density) before
         * the commit; CI repeats the six node suites on the deploy branch.
         */
        action runLocalSuites;
        action rebuildWasmIfMainRsChanged { doc /* wasm/build.sh + commit both modules (EP-04) */ }
        action bumpSwVersion;
        action updateChangelogTrio { doc /* CHANGELOG.md + help-modal <details id="changelog"> + sw.js comment */ }
        action releaseCommit { doc /* --author Claude, Co-Authored-By the maintainer */ }
        action pushDeployBranch;
        action ciTestJob;
        action ciDeployJob { doc /* WIF auth, pull dem/*.tif, ./deploy.sh */ }
        action stageFiles;
        action stampVersion { doc /* stamp(): ?v=VERSION into worker/wasm references, grep-verified */ }
        action rsyncBucket;
        action setCacheHeaders;
        action purgeCloudflare;

        first runLocalSuites then rebuildWasmIfMainRsChanged;
        first rebuildWasmIfMainRsChanged then bumpSwVersion;
        first bumpSwVersion then updateChangelogTrio;
        first updateChangelogTrio then releaseCommit;
        first releaseCommit then pushDeployBranch;
        first pushDeployBranch then ciTestJob;
        first ciTestJob then ciDeployJob;
        first ciDeployJob then stageFiles;
        first stageFiles then stampVersion;
        first stampVersion then rsyncBucket;
        first rsyncBucket then setCacheHeaders;
        first setCacheHeaders then purgeCloudflare;
    }
}
