package SimujaulesDomain {
    doc
    /*
     * Domain data: the grid the engines search, the inputs layered on it
     * (network, water mask, bridges, references), and the products of a run
     * (fields, routes, matrix, bundle). Typed arrays are modelled as attribute
     * defs whose element precision is load-bearing for parity (EP-09).
     */

    private import ScalarValues::*;
    private import ISQ::*;
    private import SI::*;
    private import SimujaulesEnergy::*;

    // ---------------------------------------------------------------------
    // Enumerations (values exactly as they appear in the UI / wire format)
    // ---------------------------------------------------------------------

    enum def ComputeMode {
        doc /* #mode and the wire field mode / densityMode. */
        enum 'from';
        enum 'to';
        enum 'round';
    }
    enum def EMaxMode {
        doc /* #e-max-mode: in round mode, cap each leg or out-plus-back total. */
        enum leg;
        enum total;
    }
    enum def RepulsionMode {
        doc /* #repulsion-mode for A* top-N alternatives. */
        enum 'per-cell';
        enum linear;
        enum square;
    }
    enum def RefSampling {
        doc
        /*
         * #ref-sampling. halton survives only in code and on bundle import
         * (dropped from the UI); clicked and file refs bypass the sampler.
         */
        enum census;
        enum sobol;
        enum random;
        enum halton;
    }
    enum def ComputeSource {
        doc /* The #compute-source radiogroup (2C Execucao): cs-browser / cs-localhost / cs-cloud. */
        enum browser;
        enum localhost;
        enum cloud;
    }
    enum def EngineKind {
        doc /* Which engine served a run (state.lastRunEngine / reply.engine). */
        enum js;
        enum wasm32;
        enum wasm64;
        enum native;
        enum graph;
    }
    enum def EnergySource {
        doc /* #energy-source: which field the energy layer shows when a compare pair ran. */
        enum constrained;
        enum unconstrained;
        enum difference;
    }
    enum def JunctionMode {
        doc /* #vec-junction-mode for graph building. */
        enum crossings;
        enum shared;
    }
    enum def DemSource {
        doc /* Where a DEM came from (1A Carregar DEM). */
        enum geotiffFile;
        enum bundledExample;
        enum fabdemViewport;
        enum bundleImport;
    }

    // ---------------------------------------------------------------------
    // Typed arrays (precision matters: see EP-09)
    // ---------------------------------------------------------------------

    attribute def TypedArray { attribute length : Natural; }
    attribute def Float32Array :> TypedArray;
    attribute def Float64Array :> TypedArray;
    attribute def Uint8Array :> TypedArray;
    attribute def Int32Array :> TypedArray;
    attribute def Uint32Array :> TypedArray;

    // ---------------------------------------------------------------------
    // The grid
    // ---------------------------------------------------------------------

    item def Dem {
        doc
        /*
         * A georeferenced elevation raster (EPSG:4326 recommended). Heights are
         * smoothed in place at load (SimujaulesEnergy::DemSmoothing) before any
         * engine sees them.
         */
        attribute source : DemSource;
        attribute label : String;
        attribute isGeographic : Boolean;
        attribute smoothing : DemSmoothing;
        attribute grid : Grid;
    }

    attribute def Grid {
        doc
        /*
         * The engines' search space: H x W cells (row-major idx = r*W + c), cell
         * size dx/dy in metres, heights f32, traversability mask u8. N = H*W.
         */
        attribute H : Natural;
        attribute W : Natural;
        attribute dx : LengthValue;
        attribute dy : LengthValue;
        attribute height : Float32Array;
        attribute mask : Uint8Array;
    }

    attribute def MoveSet {
        doc
        /*
         * buildMoves / build_moves: nDirs in {4, 8, 16, 32, 64, 128} on the
         * Farey (Stern-Brocot) ladder. The first 8 moves of every set >= 8 are
         * the classic 8 in classic order (EP-05). Default #n-dirs = 16 since
         * v64; the engine default when the field is absent is 8.
         */
        attribute nDirs : Natural = 16;
        attribute classicPrefix : Natural = 8;
    }

    attribute def Portal {
        doc
        /*
         * A bridge/tunnel deck as a directed shortcut between two abutment cells
         * (portalU/portalV) of length portalLenM with optional deck end heights
         * portalHU/portalHV (NaN -> DEM height). Cells under the deck are never
         * touched (EP-07).
         */
        attribute u : Integer;
        attribute v : Integer;
        attribute lenM : Real;
        attribute hU : Real;
        attribute hV : Real;
    }

    attribute def PortalSet {
        doc /* buildPortals() output, cloned (never transferred) into every pool message (CO-09). */
        attribute portalU : Int32Array;
        attribute portalV : Int32Array;
        attribute portalLenM : Float64Array;
        attribute portalHU : Float64Array;
        attribute portalHV : Float64Array;
    }

    // ---------------------------------------------------------------------
    // Layered inputs (groups 1B, 1C, 1D, 2B)
    // ---------------------------------------------------------------------

    item def StreetNetwork {
        doc
        /*
         * 1B: polylines from a .gpkg (sql.js), Overpass, or the South-America
         * viario FlatGeobuf. networkLines (WGS84) + networkLinesMeta ({deck,
         * layer} per way, null for .gpkg) + the rasterised networkMask u8.
         */
        attribute lineCount : Natural;
        attribute networkMask : Uint8Array;
        attribute hasLineMeta : Boolean;
    }
    item def WaterMask {
        doc
        /*
         * 1C: impassable cells from water areas, the sea (coastline orientation
         * sweep, Overpass only: the FGB family has no coastline layer) and
         * rivers; plus drawn barriers/corridors. Cached as osmWaterGeom.
         */
        attribute impassable : Uint8Array;
        attribute includesRivers : Boolean;
    }
    item def BridgeSet {
        doc
        /*
         * 1D: OSM bridge/tunnel decks (Overpass, viario FGB, from the loaded
         * network, or drawn), state.bridges. Refused on projected DEMs (PP-06).
         */
        attribute deckCount : Natural;
        attribute includeTunnels : Boolean;
    }
    attribute def RefPoint {
        doc /* A density reference [r, c]. */
        attribute r : Integer;
        attribute c : Integer;
    }
    item def ReferenceSet {
        doc
        /*
         * 2B: K references for multi-reference density: map clicks, a file, or
         * sampled (RefSampling). Census placement also sets refPopM (KP-03).
         */
        attribute k : Natural;
        attribute sampling : RefSampling;
        attribute refs : RefPoint[0..*] ordered;
        attribute refPopM : Real[0..1];
    }

    item def StreetGraph {
        doc
        /*
         * graph-engine.js buildGraph() output (graph mode): nodes, edges with
         * sampled height profiles, CSR adjacency; deck edges flattened between
         * ground-endpoint elevations; no junctions across layers at decks.
         */
        attribute nNodes : Natural;
        attribute nEdges : Natural;
        attribute junctionMode : JunctionMode;
    }

    // ---------------------------------------------------------------------
    // Run configuration
    // ---------------------------------------------------------------------

    attribute def RunConfig {
        doc
        /*
         * The engine-facing run parameters (app.js baseMsg minus the arrays).
         * Mirrors: mcp/lib.mjs buildRunMessage, census runDensity msg (CO-13).
         * maximize/maximizeLength exist in the engines but have had no UI
         * control since v36 (dormant code path).
         */
        attribute mode : ComputeMode;
        attribute cost : CostBundle;
        attribute eMax : Real = 0.0 { doc /* kJ; 0 = no budget */ }
        attribute eMaxMode : EMaxMode;
        attribute wantPasses : Boolean;
        attribute wantTopN : Boolean;
        attribute nRoutes : Natural = 1 { doc /* clamped to [1, 20] */ }
        attribute penalty : Real = 2.0;
        attribute repulsionMode : RepulsionMode;
        attribute wantDensity : Boolean;
        attribute densityMode : ComputeMode;
        attribute wantNetworkInterp : Boolean;
        attribute interpMaxDistance : Real = 50.0;
        attribute interpSmoothing : Real = 0.0;
        attribute maximize : Boolean = false;
        attribute maximizeLength : Natural = 0;
        attribute moves : MoveSet;
        attribute stringPull : Boolean;
        attribute wantMatrix : Boolean;
    }

    // ---------------------------------------------------------------------
    // Products of a run
    // ---------------------------------------------------------------------

    item def EnergyField {
        doc /* Minimum energy (kJ) from/to/round-trip each cell; f32. Infinity outside budget/mask. */
        attribute energy : Float32Array;
    }
    item def PassesField {
        doc
        /*
         * Subtree sizes of the shortest-path tree ("natural corridors"). f64 for
         * single-source (counts exceed 2^24 on big DEMs), f32 inside density.
         */
        attribute passes : TypedArray;
    }
    item def DensityAccumulators {
        doc
        /*
         * A pool slice's raw partial result (densityPartial): density,
         * energySum (f64), energyCount and an optional K x K matrix block. The
         * app merges slices in f64 and normalises once.
         */
        attribute density : TypedArray;
        attribute energySum : Float64Array;
        attribute energyCount : TypedArray;
        attribute matrix : Float32Array[0..1];
    }
    item def Route {
        doc /* A routed path: cell indices, energy (the optimised per-edge sum, PR-01), length. */
        attribute path : Integer[0..*] ordered;
        attribute energyKJ : Real;
        attribute lengthM : Real;
        attribute stringPulled : Boolean;
    }
    item def AccessibilityMatrix {
        doc
        /*
         * K x K ref<->ref energies (raw per-ref f32 samples) behind the 3B KPIs
         * (300 kJ). Exact only up to the run's eMax (KP-02).
         */
        attribute k : Natural;
        attribute entries : Float32Array;
        attribute eMax : Real;
    }
    item def MaxDensitySegment {
        doc /* 3C.c: worker kind "maxseg", a self-avoiding high-density segment of target length. */
        attribute targetLenM : Real;
        attribute nSegments : Natural;
    }

    item def RunResult {
        doc /* What a completed run installs into state.lastResult (fields) and state.kpi (matrix). */
        item energy : EnergyField[0..1];
        item passes : PassesField[0..1];
        item routes : Route[0..20];
        item matrix : AccessibilityMatrix[0..1];
        attribute engine : EngineKind;
        attribute elapsedMs : Real;
    }

    item def BundleFile {
        attribute name : String;
        attribute mediaType : String;
    }
    item def ResultBundle {
        doc
        /*
         * downloadBundle(): simujoules-{slug}{ts}.zip with metadata.jsonld
         * (@type EnergyFieldComputation, schemaVersion 3, @vocab = the legacy
         * simujoules vocab IRI) plus whichever exist: energy.tif (f32),
         * passes.tif (f64), energy_unconstrained.tif, energy_difference.tif,
         * passes_unconstrained.tif, network.tif (u8), impassable.tif,
         * bridges.geojson, routes.geojson, path.geojson, path_alt.geojson,
         * graph_edges.geojson. Connection settings are stripped (PR-09).
         */
        item metadataFile : BundleFile;
        item files : BundleFile[0..*];
        attribute schemaVersion : Natural = 3;
    }
    item def RenderedExport {
        doc /* exportRenderedImages(): energy_rendered.png / passes_rendered.png + .pgw (+ .prj if geographic). */
        item files : BundleFile[0..*];
    }
}
