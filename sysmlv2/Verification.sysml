package SimujaulesVerification {
    doc
    /*
     * One verification def per test suite, each verifying the requirements it
     * actually asserts (checked against the suites' assertions, not their
     * names). Suites run in CI are marked runsInCi = true
     * (.github/workflows/deploy.yml job "test"); the rest are run locally by
     * hand before committing engine changes. ReviewOnly collects the
     * requirements NO suite asserts: they are held by review discipline, and
     * listing them is the point (it is the coverage gap).
     */

    private import ScalarValues::*;
    private import SimujaulesStructure::*;
    private import SimujaulesRequirements::*;

    abstract verification def TestSuite {
        doc /* A node (or cargo + node) suite. Run: node <path>. */
        subject sys : SimujaulesSystem;
        attribute path : String;
        attribute runsInCi : Boolean;
        attribute prerequisites : String[0..1];
    }

    // =====================================================================
    // Suites run in CI
    // =====================================================================

    verification def WorkerPoolSuite :> TestSuite {
        doc
        /*
         * from/to/round/eMax/top-N invariants, pooled densityPartial merge ==
         * single run (also for matrix rows), nDirs 4-128 with the pooled
         * nDirs=16 matrix byte-identical (tables == on-demand integration),
         * maximize forcing nDirs=8, portals, string pulling (cheaper,
         * subsequence, endpoints, round/maximize excluded).
         */
        :>> path = "test-worker-pool.mjs";
        :>> runsInCi = true;
        objective {
            verify settledGuard;
            verify densityCostModelIdentity;
            verify longEdgeIntegration;
            verify classicEightModes;
            verify portalParity;
            verify matrixParity;
            verify stringPullDisplayOnly;
        }
    }

    verification def EnergyV2Suite :> TestSuite {
        doc
        /*
         * Locks the v2 closed form and the eps estimator; asserts
         * beta ~= m*g/keff written in terms of G (= G_SP 9.7864), which is what
         * pins local gravity (JS<->Rust parity is gravity-blind).
         */
        :>> path = "test-energy-v2.mjs";
        :>> runsInCi = true;
        objective {
            verify localGravity;
            verify descentClampKept;
        }
    }

    verification def DemSmoothingSuite :> TestSuite {
        doc /* Canonical smoothHeightsInPlace (byte-identical mirror) against the reference Gaussian. */
        :>> path = "test-dem-smoothing.mjs";
        :>> runsInCi = true;
        objective {
            verify smoothingMirror;
        }
    }

    verification def GraphEngineSuite :> TestSuite {
        doc /* stepCost parity with v2Edge, sampling, planarisation, passes, decks and layers. */
        :>> path = "test-graph-engine.mjs";
        :>> runsInCi = true;
        objective {
            verify graphModePortalBlind;
        }
    }

    verification def WaterRasterSuite :> TestSuite {
        doc /* Coastline orientation sweep, even-odd holes, supercover, assembleRings (mirrors of app.js). */
        :>> path = "test-water-raster.mjs";
        :>> runsInCi = true;
        objective {
            verify waterMaskMirror;
        }
    }

    verification def CensusSamplerSuite :> TestSuite {
        doc /* Population weighting, in-polygon / bbox placement, clip-area ratio (mirrors of app.js). */
        :>> path = "census/test-census-sampler.mjs";
        :>> runsInCi = true;
        objective {
            verify censusSamplerMirror;
        }
    }

    // =====================================================================
    // Suites run locally only
    // =====================================================================

    verification def BackendParitySuite :> TestSuite {
        doc
        /*
         * Spawns the release binary and compares /density, /single and /health
         * with energy-worker.js: energy bit-parity, passes equal except on exact
         * f64 ties, +portals, +matrix (max delta 0), +droppedRef (orig_k rows),
         * +ndirs (nDirs != 8 parity), maximize omitting the matrix on both
         * engines, network masks, round with leg/total budgets.
         */
        :>> path = "backend/test-backend.mjs";
        :>> runsInCi = false;
        :>> prerequisites = "cd backend && cargo build --release";
        objective {
            verify jsRustEnergyParity;
            verify passesTieTolerance;
            verify classicEightAnchor;
            verify v8ExactMath;
            verify portalParity;
            verify matrixParity;
            verify accumulatorPrecision;
            verify longEdgeIntegration;
            verify kpiExactnessBound;
        }
    }

    verification def WasmWorkerSuite :> TestSuite {
        doc
        /*
         * Drives wasm-worker.js (engine32, plus engine64 when Memory64
         * validates) against energy-worker.js through their real onmessage on
         * test-backend's 2^16-cell fixtures: density-pool partials,
         * single-source, and the engine-fallback paths. Prints "WASM WORKER
         * MATCHES JS WORKER". It catches a stale module only if the main.rs
         * change altered results.
         */
        :>> path = "wasm/test-wasm.mjs";
        :>> runsInCi = false;
        :>> prerequisites = "wasm/build.sh";
        objective {
            verify wasmIsBackendEngine;
            verify wasmRebuiltWithBackend;
            verify backendFallback;
        }
    }

    verification def CensusDensitySuite :> TestSuite {
        doc /* lon/lat -> pixel, harness density == the app's pooled merge, bundle round-trip. */
        :>> path = "census/test-census-density.mjs";
        :>> runsInCi = false;
        :>> prerequisites = "npm install in census/";
        objective {
            verify densityCostModelIdentity;
            verify reproducibleBundle;
        }
    }

    verification def McpSuite :> TestSuite {
        doc
        /*
         * lib smoothing parity and thread runner, the full stdio tool suite vs
         * direct engine runs, on-disk outputs. It does NOT catch baseMsg drift
         * (CO-13): it compares density against the same harness it builds on.
         */
        :>> path = "mcp/test-mcp.mjs";
        :>> runsInCi = false;
        :>> prerequisites = "npm install in census/ and mcp/";
        objective {
            verify smoothingMirror;
        }
    }

    verification def MaxSegSuite :> TestSuite {
        doc
        /*
         * maxseg (3C.c) against exact enumeration: ridge following,
         * shuttle-degeneracy, wall, anti-round-trip. Not in CI. No requirement
         * covers the max-density segment yet.
         */
        :>> path = "test-maxseg.mjs";
        :>> runsInCi = false;
    }

    verification def GridResearchHarnesses :> TestSuite {
        doc
        /*
         * docs/grid-*.mjs are ANALYSIS harnesses, not tests (need
         * sampa_centro.tif + census/node_modules). Each self-validates its
         * 8-move engine bit-identical to energy-worker.js before reporting, so
         * they double as an independent cross-check of the classic-8 anchor.
         */
        :>> path = "docs/grid-*.mjs";
        :>> runsInCi = false;
        objective {
            verify classicEightAnchor;
        }
    }

    // =====================================================================
    // Held by review only (the coverage gap)
    // =====================================================================

    verification def ReviewOnly {
        doc
        /*
         * No suite asserts these. They hold only as long as a reviewer (human or
         * agent) checks them against CLAUDE.md on every relevant change. Moving
         * one of them into a suite is a real improvement in safety.
         */
        subject sys : SimujaulesSystem;
        objective {
            verify viewingEqualsRouting;
            verify localEdgeCosts;
            verify clientSideByDefault;
            verify offlineAfterFirstLoad;
            verify riderAccuracy;
            verify estimatorAccuracy;
            verify probeResponsiveness;
            verify bilingualUi;
            verify memoryBoundedScale;
            verify fabdemCaveat;
            verify smoothingAppSideOnly;
            verify smoothingAutoRule;
            verify geographicBridgeGuard;
            verify sharedPoolSizing;
            verify sharedPredictor;
            verify backendMemoryModelMirror;
            verify wasmMemoryModelMirror;
            verify sharedEngineSelection;
            verify cancelBeforeGridChange;
            verify probeIsolation;
            verify interpAfterMerge;
            verify portalsCloned;
            verify nDirsVersionGate;
            verify styleNeverRecomputes;
            verify headlessMessageMirror;
            verify memory64MaxMemory;
            verify wasmCorrectionHygiene;
            verify kpiCacheDiscipline;
            verify refPopulationOwnership;
            verify gridCorrectionLayer;
            verify noBuildStep;
            verify swVersionBump;
            verify precacheConsistency;
            verify changelogTrio;
            verify releaseCommit;
            verify sriCrossorigin;
            verify escapeUserStrings;
            verify i18nOnly;
            verify deployAllowList;
            verify stableVocabIri;
            verify controlDataPlaneSplit;
            verify requesterOnlyFirewall;
            verify idleShutdown;
            verify ephemeralIpDns;
        }
    }

    // =====================================================================
    // The verification campaign as run today
    // =====================================================================

    verification ciTestJob : TestSuite {
        doc /* What the CI "test" job runs on PRs to main/deploy and pushes to deploy. */
        verification workerPool : WorkerPoolSuite;
        verification energyV2 : EnergyV2Suite;
        verification demSmoothing : DemSmoothingSuite;
        verification graphEngine : GraphEngineSuite;
        verification waterRaster : WaterRasterSuite;
        verification censusSampler : CensusSamplerSuite;
    }

    verification localEngineChecks : TestSuite {
        doc /* Run by hand before committing engine changes (there is no CI for these). */
        verification backendParity : BackendParitySuite;
        verification wasmWorker : WasmWorkerSuite;
        verification censusDensity : CensusDensitySuite;
        verification mcp : McpSuite;
        verification maxSeg : MaxSegSuite;
    }
}
