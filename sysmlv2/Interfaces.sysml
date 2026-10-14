package SimujaulesInterfaces {
    doc
    /*
     * Every boundary in the system, as item defs (what crosses), port defs
     * (where) and interface defs (who talks to whom). Port defs are written
     * from the PROVIDER's point of view; the consumer uses the conjugate (~).
     */

    private import ScalarValues::*;
    private import SimujaulesDomain::*;
    private import SimujaulesEnergy::*;

    // =====================================================================
    // 1. Web Worker protocol (app.js <-> energy-worker.js / wasm-worker.js)
    // =====================================================================

    item def WorkerMessage {
        doc /* postMessage payload. The worker ignores any kind it does not know (no default kind). */
        attribute kind : String;
    }
    item def RunMessage :> WorkerMessage {
        doc
        /*
         * kind "run": baseMsg (app.js) + height/mask/networkMask arrays.
         * Pool slices add densityPartial, wantMatrix, matrixCells and a slice of
         * refPoints; a wasm-eligible message adds wasm = {module, is64}.
         */
        :>> kind = "run";
        attribute grid : Grid;
        attribute seedR : Integer; attribute seedC : Integer;
        attribute goalR : Integer = -1; attribute goalC : Integer = -1;
        attribute config : RunConfig;
        attribute refPoints : RefPoint[0..*] ordered;
        attribute densityPartial : Boolean = false;
        attribute matrixCells : Int32Array[0..1];
        attribute networkMask : Uint8Array[0..1];
        attribute portals : PortalSet[0..1];
        attribute wasmModuleAttached : Boolean = false;
        attribute wasmIs64 : Boolean = false;
    }
    item def InterpMessage :> WorkerMessage {
        doc /* kind "interp": network IDW fill, AFTER the pool merge (CO-08); optional row band. */
        :>> kind = "interp";
        attribute interpMaxDistance : Real;
        attribute interpSmoothing : Real;
    }
    item def SmoothMessage :> WorkerMessage { :>> kind = "smooth"; attribute iters : Natural; }
    item def MaxSegMessage :> WorkerMessage {
        doc /* kind "maxseg": max-density segment search (3C.c). */
        :>> kind = "maxseg";
        attribute targetLenM : Real; attribute turnExp : Real; attribute elongExp : Real;
        attribute nSegments : Natural;
    }
    item def ProbeMessage :> WorkerMessage {
        doc /* kind "probe": calibration at DEM load, capped by maxSettled (CO-07). */
        :>> kind = "probe";
        attribute maxSettled : Natural;
    }
    item def GraphBuildMessage :> WorkerMessage {
        doc /* kind "graphBuild": lines + dem + opts (junctionMode, snapTolCells, lineMeta), gen. */
        :>> kind = "graphBuild";
        attribute gen : Natural;
    }
    item def GraphRunMessage :> WorkerMessage {
        doc /* kind "graphRun": graph + params (refs snapped with nearestNode), gen. */
        :>> kind = "graphRun";
        attribute gen : Natural;
    }

    item def WorkerReply { attribute kind : String; }
    item def ProgressReply :> WorkerReply { :>> kind = "progress"; attribute progress : Real; }
    item def DoneReply :> WorkerReply {
        doc /* kind "done": energy f32, passes, path, routes, matrix?, stringPulled?, elapsedMs. */
        :>> kind = "done";
        item result : RunResult;
    }
    item def PartialDensityReply :> WorkerReply {
        doc
        /*
         * kind "done", partial: true. JS slice: density f32, energySum f64,
         * energyCount i32. Wasm slice: density f64, energySum f64, energyCount
         * u32 (+ engine). The app's f64 merge accepts both.
         */
        :>> kind = "done";
        item acc : DensityAccumulators;
    }
    item def WarningReply :> WorkerReply { :>> kind = "warning"; attribute key : String; }
    item def ErrorReply :> WorkerReply { :>> kind = "error"; attribute errorMessage : String; }
    item def EngineFallbackReply :> WorkerReply {
        doc
        /*
         * wasm-worker.js only: {engine, stage: instantiate | run, reason}; the
         * same message is then re-run on the JS engine. The run is excluded from
         * corrWasm (CO-15).
         */
        :>> kind = "engine-fallback";
        attribute stage : String;
        attribute reason : String;
    }
    item def InterpDoneReply :> WorkerReply { :>> kind = "interp-done"; item energy : EnergyField; }
    item def SmoothDoneReply :> WorkerReply { :>> kind = "smooth-done"; }
    item def MaxSegDoneReply :> WorkerReply { :>> kind = "maxseg-done"; item segment : MaxDensitySegment; }
    item def ProbeDoneReply :> WorkerReply {
        :>> kind = "probe-done";
        attribute totalMs : Real; attribute exploredTotal : Natural; attribute budgetReached : Boolean;
    }
    item def GraphBuiltReply :> WorkerReply { :>> kind = "graph-built"; item graph : StreetGraph; }
    item def GraphResultReply :> WorkerReply { :>> kind = "graph-result"; }

    port def EnginePort {
        doc /* Provided by a worker. Messages carry state.computeGen app-side (CO-06). */
        in item request : WorkerMessage;
        out item reply : WorkerReply;
    }
    interface def WorkerChannel {
        doc /* new Worker(...) + postMessage / onmessage; worker.terminate() on cancel. */
        end app : ~EnginePort;
        end worker : EnginePort;
    }

    // =====================================================================
    // 2. Wasm C ABI (wasm-worker.js <-> engine32.wasm / engine64.wasm)
    // =====================================================================

    port def WasmAbiPort {
        doc
        /*
         * No wasm-bindgen. Input frame = [u32 LE json_len][json params][arrays].
         * run(ptr, len, kind): kind 0 = density partial, kind 1 = single source;
         * returns 0 or an HTTP-style code. Outputs via out_count/out_ptr/out_len,
         * errors via err_ptr/err_len, then release(). is64 uses BigInt pointers.
         */
        attribute exports : String[*] = ("alloc", "free", "run", "release",
            "out_count", "out_ptr", "out_len", "err_ptr", "err_len");
        attribute jobKinds : Natural[*] = (0, 1);
    }

    // =====================================================================
    // 3. Native backend HTTP (app.js / Caddy -> simujoules-backend)
    // =====================================================================

    item def GridRequestBody {
        doc
        /*
         * POST body, optionally gzip (Content-Encoding: gzip), <= 2 GiB:
         * [u32 json_len][json Params][f32 height x N][u8 mask x N]
         * [u8 network x N if hasNetwork][portals x nPortals: i32 U, i32 V,
         * f64 lenM, f64 hU, f64 hV]. Params (camelCase): h, w, dx, dy, cost,
         * eMax, eMaxMode, densityMode, refPoints, src, wantPasses, hasNetwork,
         * maximize, nPortals, wantMatrix, matrixCells (wasm only), nDirs.
         */
        attribute cost : CostBundle;
        attribute nDirs : Natural = 8;
        attribute hasNetwork : Boolean;
        attribute nPortals : Natural;
    }
    item def DensityRequest :> GridRequestBody { attribute wantMatrix : Boolean; }
    item def SingleRequest :> GridRequestBody {
        doc /* /single: src + wantPasses; maximize is rejected with 400. */
        attribute wantPasses : Boolean;
    }
    item def DensityResponse {
        doc
        /*
         * [u32 json_len][json {elapsed_ms, refs, matrix?: K}, space-padded to 8 B]
         * [f64 density x N][f32 energy x N][f32 matrix x K^2 if wantMatrix].
         * gzip only when the request sent X-Simu-Gzip: 1.
         */
        item density : PassesField;
        item energy : EnergyField;
        item matrix : AccessibilityMatrix[0..1];
    }
    item def SingleResponse {
        doc /* [u32 json_len][json {elapsed_ms, passes: bool}][f32 energy x N][f64 passes x N?] */
        item energy : EnergyField;
        item passes : PassesField[0..1];
    }
    item def HealthResponse {
        doc
        /*
         * GET /health: {ok, version, cores, mem_budget_bytes, idle_seconds}.
         * version gates nDirs != 8 (CO-10); mem_budget_bytes feeds the estimator
         * (CO-03); idle_seconds feeds the VM idle-watchdog (CL-03).
         */
        attribute ok : Boolean;
        attribute version : String;
        attribute cores : Natural;
        attribute memBudgetBytes : Natural;
        attribute idleSeconds : Natural;
    }

    port def ComputeHttpPort {
        doc
        /*
         * Provided by simujoules-backend (tiny_http, default 127.0.0.1:8077).
         * CORS: Access-Control-Allow-Origin *, methods POST GET OPTIONS. No auth
         * in the binary (the cloud token lives in Caddy).
         */
        in item densityRequest : DensityRequest;
        out item densityResponse : DensityResponse;
        in item singleRequest : SingleRequest;
        out item singleResponse : SingleResponse;
        out item health : HealthResponse;
        attribute routes : String[*] = ("OPTIONS *", "GET /health", "POST /density", "POST /single");
    }
    interface def ComputeHttpInterface {
        end client : ~ComputeHttpPort;
        end server : ComputeHttpPort;
    }

    port def AuthenticatedComputePort :> ComputeHttpPort {
        doc
        /*
         * Caddy on the VM: https://compute.simujaules.pedalhidrografi.co. TLS by
         * DNS-01 (Cloudflare). OPTIONS -> 204 without token; everything else
         * requires Authorization: Bearer CLOUD_AUTH_TOKEN (empty token fails
         * closed). CORS origin allow-list = APP_ORIGIN + localhost.
         */
        attribute requiresBearer : Boolean = true;
    }

    // =====================================================================
    // 4. Cloud control plane (app.js -> simu-orchestrator)
    // =====================================================================

    enum def VmState {
        enum absent;
        enum stopped;
        enum starting;
        enum running;
        enum stopping;
    }
    item def CloudStartRequest {
        doc /* POST /cloud/start {machineType}: allow-list n2-standard-8 / -32 / -128. */
        attribute machineType : String;
    }
    item def CloudStatus {
        doc /* {state, dataUrl, externalIp, leaseExpiresAt, etaSeconds?} */
        attribute vmState : VmState;
        attribute dataUrl : String;
        attribute externalIp : String[0..1];
        attribute etaSeconds : Natural[0..1];
    }
    item def KeepaliveRequest {
        doc /* POST /cloud/keepalive with X-Simu-Client; lease 180 s. /cloud/stop is skipped while another client holds a lease. */
        attribute clientId : String;
    }

    port def CloudControlPort {
        doc
        /*
         * Provided by simu-orchestrator (Flask on Cloud Run). Every route except
         * GET /healthz requires Authorization: Bearer CLOUD_AUTH_TOKEN (checked
         * constant-time); /cloud/reap requires REAP_TOKEN. The browser keeps the
         * token typed into #cloud-token in sessionStorage.
         */
        in item start : CloudStartRequest;
        in item keepalive : KeepaliveRequest;
        out item status : CloudStatus;
        attribute routes : String[*] = ("POST /cloud/start", "GET /cloud/status",
            "POST /cloud/keepalive", "POST /cloud/stop", "POST /cloud/create",
            "POST /cloud/delete", "POST /cloud/reap", "GET /healthz");
    }
    interface def CloudControlInterface {
        end client : ~CloudControlPort;
        end server : CloudControlPort;
    }

    // =====================================================================
    // 5. MCP (agent <-> mcp/server.mjs over stdio)
    // =====================================================================

    item def McpToolCall {
        doc /* JSON-RPC tools/call over stdio (@modelcontextprotocol/sdk 1.30.0). */
        attribute tool : String;
    }
    port def McpStdioPort {
        doc
        /*
         * Server {name: "simujaules", version: "0.1.0"}. Tools: load_dem {path,
         * label?, smooth}, dem_info, energy_field {mode, point, physics, eMax,
         * eMaxMode, nDirs (default 16), outDir?, name?}, route {from, to, mode,
         * topN 0-20, penalty, repulsionMode, stringPull, includeGeometry,
         * maxVertices}, energy_at {points 1..1000}, density {refs 1..20000, mode}.
         */
        in item call : McpToolCall;
        attribute tools : String[*] = ("load_dem", "dem_info", "energy_field", "route", "energy_at", "density");
    }

    // =====================================================================
    // 6. External data sources and services consumed by the app
    // =====================================================================

    port def HttpRangeSourcePort {
        doc /* A static object read by HTTP Range (FlatGeobuf bbox pulls via fgbStream, COG tiles). */
        attribute url : String;
    }
    port def OverpassPort {
        doc /* OVERPASS_URL https://overpass-api.de/api/interpreter: streets (1B), water (1C), bridges (1D). */
        attribute url : String = "https://overpass-api.de/api/interpreter";
    }
    port def TileSourcePort {
        doc /* XYZ raster tiles for Leaflet layers. */
        attribute urlTemplate : String;
    }
    port def GeocoderPort {
        doc /* photon.komoot.io/api (bypasses the service worker). */
        attribute url : String = "https://photon.komoot.io/api";
    }
    port def CdnScriptPort {
        doc /* SRI-pinned <script> from a CDN (WEB-06). */
        attribute url : String;
        attribute integrity : String;
        attribute crossorigin : String = "anonymous";
    }

    // =====================================================================
    // 7. Operations interfaces (deploy and cloud provisioning)
    // =====================================================================

    port def ObjectStorePort {
        doc /* gs://simujaules: gcloud storage rsync --checksums-only --delete-unmatched-destination-objects. */
        attribute bucket : String;
    }
    port def CachePurgePort {
        doc /* Cloudflare API purge_cache of the exact staged URLs (CF_API_TOKEN, CF_ZONE_ID). */
    }
    port def DnsApiPort {
        doc /* Cloudflare /zones/{CF_ZONE_ID}/dns_records: A record compute.simujaules.pedalhidrografi.co, TTL 60. */
        attribute record : String = "compute.simujaules.pedalhidrografi.co";
        attribute ttlS : Natural = 60;
    }
    port def GcpComputeApiPort {
        doc /* google.cloud.compute_v1 InstancesClient + FirewallsClient (ADC). */
    }
}
