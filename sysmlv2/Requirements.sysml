package SimujaulesRequirements {
    doc
    /*
     * Requirements of Simujaules. Two kinds:
     *  - PRODUCT requirements (what the app promises its users), and
     *  - INVARIANTS (the "easy to break, hard to notice" rules from CLAUDE.md).
     * Every invariant is either verified by a test suite (see
     * SimujaulesVerification) or carries an explicit "Unverified" note in its
     * doc. CI (.github/workflows/deploy.yml, job "test") runs only the six
     * pure-node suites on PRs and the deploy branch; the backend, wasm, MCP and
     * census-density suites are run locally by hand, and an unverified
     * invariant is held only by review discipline.
     * Short names: PR product, EP engine parity, EM engine model, PP terrain
     * preprocessing, CO compute orchestration, KP accessibility KPIs, WEB
     * PWA/release, CL cloud plane.
     */

    private import ScalarValues::*;
    private import SimujaulesStructure::*;
    private import SimujaulesEnergy::*;

    // ---------------------------------------------------------------------
    // Requirement definitions (subject kinds)
    // ---------------------------------------------------------------------

    requirement def SystemRequirement {
        doc /* A requirement on the whole Simujaules system. */
        subject sys : SimujaulesSystem;
    }
    requirement def EngineRequirement {
        doc /* A requirement on a compute engine (JS worker, native core, wasm, graph). */
        subject engine : ComputeEngine;
    }
    requirement def AppRequirement {
        doc /* A requirement on the browser application (app.js and its PWA shell). */
        subject app : AppController;
    }
    requirement def CloudRequirement {
        doc /* A requirement on the optional cloud compute plane. */
        subject plane : CloudComputePlane;
    }

    // ---------------------------------------------------------------------
    // PR — product requirements
    // ---------------------------------------------------------------------

    requirement <'PR-01'> viewingEqualsRouting : SystemRequirement {
        doc
        /*
         * Viewing energy == routing energy, by construction
         * (docs/energy-journal-2026-07-06-workorder.md). Whatever energy is shown
         * for a routed path or cell IS the per-edge sum the search optimised;
         * never add a second "estimated energy" number. The v2Edge descent clamp
         * is provably unreachable (journal Entry 18), so there is nothing to
         * reconcile and no reconciliation mechanism may be built.
         */
    }
    requirement <'PR-02'> localEdgeCosts : EngineRequirement {
        doc
        /*
         * Edge costs stay O(1)-local: no path-history-dependent term may enter
         * dijkstra(), densityField(), graph-engine.js stepCost or
         * backend/src/main.rs. Any change to the edge formula must re-run the
         * verify_v2edge_clamp.mjs-style proof. Unverified by the node suites
         * (held by the journal proof + review).
         */
    }
    requirement <'PR-03'> clientSideByDefault : SystemRequirement {
        doc
        /*
         * Everything runs client-side by default: no account, no upload, the DEM
         * never leaves the machine unless the user explicitly selects the
         * Localhost or Cloud compute source.
         */
    }
    requirement <'PR-04'> offlineAfterFirstLoad : SystemRequirement {
        doc /* The PWA works offline after first load (precache + runtime cache of SRI'd CDN libs). */
    }
    requirement <'PR-05'> backendFallback : AppRequirement {
        doc
        /*
         * The native backend / cloud VM is OFF by default and optional: any
         * failure (unreachable, version mismatch, wasm trap) falls back to the
         * browser workers; the user always gets a result.
         */
    }
    requirement <'PR-06'> riderAccuracy : SystemRequirement {
        doc
        /*
         * Energy accuracy goal +/-5 % per ride, +/-2 % bias, carried by per-rider
         * calibration (CdA/Crr/k_s fitted on the rider's own rides). Journal
         * Entry 20 validated med|delta%| 3.7/2.7/4.9 with bias < +/-1 % on three
         * riders. Smoothing alone does not rescue uncalibrated fine-DEM accuracy.
         * Verified by the external bicycling-energy-model journal, not in-repo.
         */
        attribute perRideTolerancePct : Real = 5.0;
        attribute biasTolerancePct : Real = 2.0;
    }
    requirement <'PR-07'> estimatorAccuracy : AppRequirement {
        doc
        /*
         * The run-time estimate (estimateRunTime/predictComputeMs) is within
         * +/-20 % in steady state, guaranteed by the per-engine online correction
         * (corrBrowser / corrBackend / corrWasm EMA of actual/predicted).
         * Unverified by tests (measured, docs/runtime_estimate.md).
         */
        attribute steadyStateTolerancePct : Real = 20.0;
    }
    requirement <'PR-08'> probeResponsiveness : AppRequirement {
        doc
        /*
         * The calibration probe at DEM load is bounded to <= ~1.5 s on any DEM,
         * by capping settled cells (maxSettled), not by energy budget.
         */
        attribute maxProbeSeconds : Real = 1.5;
    }
    requirement <'PR-09'> reproducibleBundle : AppRequirement {
        doc
        /*
         * Every run exports a reproducible bundle (GeoTIFFs + GeoJSON +
         * metadata.jsonld capturing every parameter) that opens in QGIS and
         * re-imports into the app. Bundles never carry the exporter's
         * connection settings (backend/orchestrator URL, computeSource).
         */
    }
    requirement <'PR-10'> bilingualUi : AppRequirement {
        doc /* The UI is available in Brazilian Portuguese and English. */
    }
    requirement <'PR-11'> memoryBoundedScale : SystemRequirement {
        doc
        /*
         * Very large DEMs (e.g. 135 M cells) never OOM-crash: both the browser
         * pool and the native backend cap concurrency to a memory budget (fewer
         * parallel slices, identical output).
         */
    }

    // ---------------------------------------------------------------------
    // EP — engine parity
    // ---------------------------------------------------------------------

    requirement <'EP-01'> jsRustEnergyParity : EngineRequirement {
        doc
        /*
         * backend/src/main.rs is a PORT of energy-worker.js: cost model, f32
         * energy storage, settled-flag handling, passes accumulation, density
         * normalisation. compute_density mirrors the JS density path and
         * compute_single mirrors the from/to/round single-source branch. Energy
         * is bit-identical; any change to one engine lands in the other.
         */
    }
    requirement <'EP-02'> passesTieTolerance : EngineRequirement {
        doc
        /*
         * Passes may differ between engines ONLY on exact f64 cost ties (radix
         * heap vs binary heap tie order); both trees are valid optima. Density
         * passes (radix heap on both sides) match the backend.
         */
    }
    requirement <'EP-03'> wasmIsBackendEngine : EngineRequirement {
        doc
        /*
         * wasm/src/lib.rs include!s backend/src/main.rs VERBATIM and adds only a
         * tiny C ABI: there is no third engine to keep in parity. Never put
         * engine logic in wasm/src/lib.rs.
         */
    }
    requirement <'EP-04'> wasmRebuiltWithBackend : EngineRequirement {
        doc
        /*
         * Every change to main.rs is followed by wasm/build.sh, committing BOTH
         * engine32.wasm and engine64.wasm, and node wasm/test-wasm.mjs. A stale
         * module silently serves the old engine in the browser.
         */
    }
    requirement <'EP-05'> classicEightAnchor : EngineRequirement {
        doc
        /*
         * buildMoves (Farey ladder, nDirs 4..128): the first 8 moves of every
         * set >= 8 are the classic 8 in the classic order; nDirs = 8 stays
         * bit-identical to the historical engine (the Rust-parity anchor).
         */
    }
    requirement <'EP-06'> v8ExactMath : EngineRequirement {
        doc
        /*
         * main.rs uses V8-exact js_hypot / js_round mirrors. libm hypot differs
         * by 1 ulp and breaks passes parity; never swap them for std functions.
         */
    }
    requirement <'EP-07'> portalParity : EngineRequirement {
        doc
        /*
         * Bridge portal edges are relaxed alongside the grid edges in dijkstra,
         * densityField and dijkstra_tree at the flat-deck cost
         * (alpha*deckLenM + beta*dh, downhill-clamped; reverse uses the opposite
         * direction). Costs derive from the same inputs (deck length, endpoint
         * heights widened f32->f64) in buildPortalAdj and build_portals. Per-cell
         * portal iteration order (JS Map vs Rust HashMap) follows insertion order
         * so exact-tie passes agree. Cells under a deck are never touched.
         */
    }
    requirement <'EP-08'> matrixParity : EngineRequirement {
        doc
        /*
         * The accessibility matrix is a /density parity surface: densityField's
         * refCells sampling and compute_density's want_matrix are bit-identical
         * (max delta = 0). Rows are keyed by the ORIGINAL ref index on both
         * engines (a skipped ref keeps an all-Infinity row; Rust carries orig_k).
         * Round entries reuse accumulate_round + f32 rounding.
         */
    }
    requirement <'EP-09'> accumulatorPrecision : EngineRequirement {
        doc
        /*
         * Precision layout is load-bearing: Rust Acc stays f64 (an f32 Acc breaks
         * the maxD < 1e-15 parity test); Scratch.passes is f32 for DENSITY only;
         * /single passes accumulate in f64 (subtree_passes_f64) and ship as f64;
         * densityField's density/passes are Float32 but energySum stays Float64;
         * the app pool-merge accumulators stay Float64.
         */
    }
    requirement <'EP-10'> settledGuard : EngineRequirement {
        doc
        /*
         * E is Float32Array but heap priorities are f64: the settled byte array
         * (not g > E[idx]) filters stale heap entries, and settled neighbours are
         * never relaxed. Removing either guard corrupts passes counts.
         */
    }
    requirement <'EP-11'> densityCostModelIdentity : EngineRequirement {
        doc
        /*
         * densityField (radix heap, one reused scratch set, targeted reset) keeps
         * a cost model identical to dijkstra(); pooled density equals a single
         * run (worker-pool equivalence).
         */
    }
    requirement <'EP-12'> longEdgeIntegration : EngineRequirement {
        doc
        /*
         * Long moves (nDirs > 8) are PROFILE-INTEGRATED (longEdgeCost: bilinear
         * heights every ~1 cell, v2Edge per sub-step, mask-blocked); never cost a
         * long move from its endpoints' delta-h alone. Precomputed long-edge
         * tables (slice with >= 3 refs) stay bit-identical to on-demand
         * integration. Passes are stamped over swept cells (stampLongPasses,
         * settled-only); portals never stamp.
         */
    }
    requirement <'EP-13'> classicEightModes : EngineRequirement {
        doc
        /*
         * Maximize, the calibration probe, A* top-N and the layered max-cost DP
         * always run the classic 8 moves, and do NOT use bridge portals
         * (admissible heuristic; a long deck cost would invert to a free
         * shortcut against maxEdgeCost).
         */
    }
    requirement <'EP-14'> descentClampKept : EngineRequirement {
        doc
        /*
         * v2Edge's trailing max(0, e) descent clamp is dead code but kept as
         * defensive bit-parity code on BOTH engines; never remove it on one side,
         * never remove it at all without re-running the Entry 18 proof.
         */
    }
    requirement <'EP-15'> graphModePortalBlind : EngineRequirement {
        doc
        /*
         * Graph mode is portal-blind. Street decks come from per-way {deck, layer}
         * metadata (state.networkLinesMeta -> graphBuild opts.lineMeta):
         * crossings at different layers are suppressed and deck profiles are
         * flattened between ground-endpoint elevations. state.bridges must NOT
         * invalidate the cached graph; bridgesToken is not in
         * computeNetworkGraphToken.
         */
    }

    // ---------------------------------------------------------------------
    // EM — engine physics model
    // ---------------------------------------------------------------------

    requirement <'EM-01'> localGravity : SystemRequirement {
        doc
        /*
         * Gravity is local: G_SP = 9.7864 m/s^2 (Sao Paulo, IAG-USP absolute
         * gravimetry), not 9.81. It lives in app.js readCost and is hand-copied
         * into census/census-density.mjs, test-energy-v2.mjs and every
         * docs/grid-*.mjs harness; grep 9.7864 and change every hit together.
         * backend/src/main.rs needs no copy (it receives the derived bundle), so
         * JS<->Rust parity is gravity-blind.
         */
        require constraint { SimujaulesEnergy::G_SP == 9.7864 }
    }
    requirement <'EM-02'> fabdemCaveat : SystemRequirement {
        doc
        /*
         * FABDEM is unsuitable for energy computations on flat/urban terrain: its
         * per-pixel noise inflates h+ by +57 % median (up to +135 %) vs the IGC
         * survey (journal Entry 19). Wherever FABDEM is offered this caveat is
         * documented. Unverified by tests.
         */
    }

    // ---------------------------------------------------------------------
    // PP — terrain preprocessing
    // ---------------------------------------------------------------------

    requirement <'PP-01'> smoothingAppSideOnly : AppRequirement {
        doc
        /*
         * DEM smoothing (smoothHeightsInPlace: sequential per-axis
         * mask-normalised Gaussian, in place at DEM load) runs BEFORE heights
         * ship to any engine, so JS/graph/Rust parity is untouched. Never move
         * smoothing into an engine (path-history state is forbidden by PR-02).
         */
    }
    requirement <'PP-02'> smoothingAutoRule : AppRequirement {
        doc
        /*
         * #dem-smooth "auto" = sigma 30 m on EVERY source, FABDEM included
         * (bicycling-energy-model Entry 74), skipping already-smoothed
         * re-imports via the exported dem.tif ImageDescription tag. The sigma
         * choices are only valid for THIS transform; changing sigma or the rule
         * requires re-running the journal validation.
         */
        attribute autoSigmaM : Real = 30.0;
    }
    requirement <'PP-03'> smoothingMirror : AppRequirement {
        doc
        /*
         * test-dem-smoothing.mjs holds a byte-identical mirror of
         * smoothHeightsInPlace (function body verbatim; export is a trailing
         * statement) that mcp/lib.mjs reuses for headless DEM load.
         */
    }
    requirement <'PP-04'> waterMaskMirror : AppRequirement {
        doc
        /*
         * app.js water-mask helpers (fillRingsEvenOdd, rasterPolylineSupercover,
         * assembleRings, fillSeaFromCoastlines) are mirrored in
         * test-water-raster.mjs. The sea is filled by a horizontal+vertical
         * orientation SWEEP from natural=coastline lines, never flood-filled.
         */
    }
    requirement <'PP-05'> censusSamplerMirror : AppRequirement {
        doc
        /*
         * app.js census-sampling helpers (pointInPolygon, ringArea/polyArea,
         * clipRingToBbox/clippedPolyArea, sobolScalar1D) are mirrored in
         * census/test-census-sampler.mjs.
         */
    }
    requirement <'PP-06'> geographicBridgeGuard : AppRequirement {
        doc /* The OSM bridge pull is refused on a projected DEM (isGeographic guard). */
    }

    // ---------------------------------------------------------------------
    // CO — compute orchestration (app side)
    // ---------------------------------------------------------------------

    requirement <'CO-01'> sharedPoolSizing : AppRequirement {
        doc
        /*
         * densityPoolSize() = min(K, cores-1, memCap) (overridable by
         * #max-workers, clamped by K) is shared by the runner AND
         * estimateRunTime(); it takes the engine and nDirs. They must not drift.
         */
    }
    requirement <'CO-02'> sharedPredictor : AppRequirement {
        doc
        /*
         * predictComputeMs() is the single predictor shared by the live estimate
         * AND the online correction (must not drift).
         */
    }
    requirement <'CO-03'> backendMemoryModelMirror : AppRequirement {
        doc
        /*
         * The backend estimate replicates the backend's memory-bounded slice cap
         * min(refs, cores, mem_budget/per_slice), per_slice = 38*N (57*N round)
         * plus the shared long-edge tables; BACKEND_BYTES_PER_CELL{,_ROUND}
         * mirror main.rs per_slice and /health mem_budget_bytes feeds it.
         * Hand-kept in sync. Unverified by tests.
         */
    }
    requirement <'CO-04'> wasmMemoryModelMirror : AppRequirement {
        doc
        /*
         * wasmJobBytes mirrors main.rs Scratch/Acc/compute_single buffers. A pool
         * only switches to wasm when workers x wasmSpeedup beats JS; jobs over
         * memBudgetBytes() stay JS unless #max-workers is set. Hand-kept in sync.
         */
    }
    requirement <'CO-05'> sharedEngineSelection : AppRequirement {
        doc
        /*
         * wasmEngineFor / densityEngine / singleEngine pick the engine in BOTH
         * the runner and currentRunOpts (must not drift). The wasm single-source
         * gate mirrors /single's: no destination, top-N or maximize; graph mode
         * and the compare pair stay JS.
         */
    }
    requirement <'CO-06'> cancelBeforeGridChange : AppRequirement {
        doc
        /*
         * Every run captures state.computeGen; cancelActiveCompute() bumps it and
         * terminates state.workers. It is called before anything that changes
         * the grid a result renders against (DEM load, network load/clear), and
         * worker callbacks drop messages of a stale generation.
         */
    }
    requirement <'CO-07'> probeIsolation : AppRequirement {
        doc
        /*
         * The probe is generation-guarded (state.calibrationGen, bumped per DEM
         * load) and skipped while a compute runs. maxSettled is probe-only
         * (0 = normal path) and never leaks into a real run. The probe anchors
         * at an UNSATURATED point (Estar cells at budget bStar).
         */
    }
    requirement <'CO-08'> interpAfterMerge : AppRequirement {
        doc
        /*
         * The optional network IDW fill runs AFTER the density pool merge as a
         * separate kind:"interp" worker message, never per slice.
         */
    }
    requirement <'CO-09'> portalsCloned : AppRequirement {
        doc
        /*
         * buildPortals() packs state.bridges into portalU/V/lenM, threaded via
         * baseMsg CLONED (never transferred: shared across the density pool) and
         * appended to the backend Blob (nPortals).
         */
    }
    requirement <'CO-10'> nDirsVersionGate : AppRequirement {
        doc
        /*
         * nDirs != 8 is dispatched to the backend only when /health reports
         * version >= 0.2.0: an older binary silently ignores the nDirs field and
         * would return a mislabelled 8-direction field.
         */
        attribute minBackendVersion : String = "0.2.0";
    }
    requirement <'CO-11'> styleNeverRecomputes : AppRequirement {
        doc
        /*
         * Style knobs (colormap, ranges, gamma, blend) re-render cached arrays
         * and never trigger a recompute. Unverified by tests.
         */
    }
    requirement <'CO-12'> stringPullDisplayOnly : AppRequirement {
        doc
        /*
         * String pulling (#string-pull) shortens displayed routes (single path +
         * top-N; not round/maximize) by windowed DP over the path's own nodes
         * with profile-integrated straight segments; accepted only when strictly
         * cheaper; never changes fields. The shown energy is the pulled
         * polyline's own v2Edge sum (PR-01 holds by construction).
         */
    }
    requirement <'CO-13'> headlessMessageMirror : AppRequirement {
        doc
        /*
         * A new run-message field in app.js baseMsg must land in mcp/lib.mjs
         * buildRunMessage AND census/census-density.mjs runDensity's msg literal;
         * the engine silently defaults missing keys and test-mcp.mjs compares
         * against the same harness, so drift is NOT caught by tests.
         */
    }
    requirement <'CO-14'> memory64MaxMemory : EngineRequirement {
        doc
        /*
         * engine64.wasm keeps --max-memory (declared 16 GiB): without it Firefox
         * copies a Memory64 memory on every grow (measured quadratic). Modules
         * compile once per page (loadWasmEngine) and travel to workers as
         * WebAssembly.Module objects.
         */
    }
    requirement <'CO-15'> wasmCorrectionHygiene : AppRequirement {
        doc
        /*
         * A wasm job posts no progress (one call into the module): wasmTicker
         * animates the bar from the prediction. corrWasm is its own correction,
         * and a run that fell back mid-way (engine-fallback) is excluded from it.
         */
    }

    // ---------------------------------------------------------------------
    // KP — accessibility KPIs (group 3B)
    // ---------------------------------------------------------------------

    requirement <'KP-01'> kpiCacheDiscipline : AppRequirement {
        doc
        /*
         * The cached ref<->ref matrix lives in state.kpi (NOT state.lastResult),
         * is invalidated by kpiInvalidate() on any ref/grid/network change, and
         * threshold edits re-evaluate the cache only: never a recompute.
         */
    }
    requirement <'KP-02'> kpiExactnessBound : AppRequirement {
        doc
        /*
         * KPIs are exact only for thresholds <= the run's eMax (0 = infinity);
         * beyond that the matrix is budget-truncated and the UI warns "lower
         * bound". refCells is never passed on the probe path or under maximize.
         */
    }
    requirement <'KP-03'> refPopulationOwnership : AppRequirement {
        doc
        /*
         * state.refPopM (census in-extent population behind "K people"
         * thresholds) is set ONLY by placeCensusRefPoints after its placement
         * loop; every ref-set mutation nulls it.
         */
    }
    requirement <'KP-04'> gridCorrectionLayer : AppRequirement {
        doc
        /*
         * #kpi-corr (default 1.00 = off) inflates the two accessibility
         * thresholds by c before counting; it lives at the KPI/threshold layer
         * ONLY (never a corrected per-cell energy). c > 1 shows the "centered
         * estimate - floor guarantee lost" warning.
         */
        attribute defaultCorrection : Real = 1.0;
    }

    // ---------------------------------------------------------------------
    // WEB — PWA, release and code hygiene
    // ---------------------------------------------------------------------

    requirement <'WEB-01'> noBuildStep : SystemRequirement {
        doc
        /*
         * Static, build-step-free: index.html loads app.js directly; no
         * package.json build or bundler for the served app (wasm modules are
         * committed build products, so deploy stays build-free).
         */
    }
    requirement <'WEB-02'> swVersionBump : SystemRequirement {
        doc
        /*
         * sw.js VERSION is bumped (with a changelog line) on every deploy that
         * changes app behaviour; otherwise users keep stale cached copies.
         */
    }
    requirement <'WEB-03'> precacheConsistency : SystemRequirement {
        doc
        /*
         * PRECACHE_URLS stays in sync with what index.html / deploy.sh reference:
         * cache.addAll is atomic and one 404 blocks the SW install for everyone.
         */
    }
    requirement <'WEB-04'> changelogTrio : SystemRequirement {
        doc
        /*
         * The changelog lives in THREE places that move together every release:
         * CHANGELOG.md, the <details id="changelog"> in the help modal
         * (index.html) and the sw.js version-history comment.
         */
    }
    requirement <'WEB-05'> releaseCommit : SystemRequirement {
        doc
        /*
         * Every version bump ships as its own git commit authored as Claude
         * (noreply@anthropic.com) with a Co-Authored-By trailer crediting the
         * maintainer.
         */
    }
    requirement <'WEB-06'> sriCrossorigin : SystemRequirement {
        doc
        /*
         * CDN <script> tags carry SRI integrity + crossorigin="anonymous". The
         * crossorigin attribute is also what lets sw.js runtime-cache them.
         */
    }
    requirement <'WEB-07'> escapeUserStrings : AppRequirement {
        doc
        /*
         * User-derived strings (error messages, bundle metadata) go through
         * escapeHtml() before any status.innerHTML interpolation.
         */
    }
    requirement <'WEB-08'> i18nOnly : AppRequirement {
        doc
        /*
         * Display text goes through the STRINGS table / data-i18n and t(); never
         * hardcode display text in JS (it clobbers the PT translation).
         */
    }
    requirement <'WEB-09'> deployAllowList : SystemRequirement {
        doc
        /*
         * deploy.sh ships only explicitly listed files; backend/, mcp/, census/,
         * tests, docs and this model never deploy.
         */
    }
    requirement <'WEB-10'> stableVocabIri : SystemRequirement {
        doc
        /*
         * The export vocabulary IRI stays on the legacy path
         * https://telhas.pedalhidrografi.co/simujoules/vocab/simujoules.jsonld#
         * (the @vocab of app.js SIMU_CONTEXT in metadata.jsonld, and the simu:
         * prefix of vocab/simujoules.jsonld, schema version 3), so exported
         * bundles keep resolving. Only branding and hostnames use
         * the "Simujaules" spelling, which is deliberate and never "corrected".
         */
    }

    // ---------------------------------------------------------------------
    // CL — cloud compute plane
    // ---------------------------------------------------------------------

    requirement <'CL-01'> controlDataPlaneSplit : CloudRequirement {
        doc
        /*
         * Compute data never transits the orchestrator: the browser talks
         * directly to the VM (Caddy -> backend) over HTTPS. The orchestrator only
         * manages the VM lifecycle (Cloud Run request size limit is 32 MiB; DEM
         * uploads are hundreds of MB).
         */
    }
    requirement <'CL-02'> requesterOnlyFirewall : CloudRequirement {
        doc
        /*
         * Only the requesting browser reaches the VM: the firewall is tightened
         * to the /32 read from the LAST X-Forwarded-For hop on Cloud Run, and
         * both planes require a Bearer token.
         */
    }
    requirement <'CL-03'> idleShutdown : CloudRequirement {
        doc
        /*
         * The billable Spot VM shuts itself down when idle (idle-watchdog reads
         * /health idle_seconds); between runs it stays STOPPED and the
         * orchestrator scales to zero. Nothing in vm/ runs automatically.
         */
    }
    requirement <'CL-04'> ephemeralIpDns : CloudRequirement {
        doc
        /*
         * The VM has no static IP: on each start the orchestrator rewrites the
         * DNS-only A record of compute.simujaules.pedalhidrografi.co (TTL 60 s);
         * TLS uses a DNS-01 certificate independent of the IP.
         */
    }
}
