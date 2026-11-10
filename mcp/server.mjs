#!/usr/bin/env node
// Simujaules MCP server (stdio). Exposes the app's energy engine to an MCP
// client (Claude Code, Claude Desktop, …) as tools: load a DEM, compute a
// single-source energy field, route between two points (with top-N
// alternatives), sample the last field, and multi-reference density.
// Numbers are the app's numbers: the same energy-worker.js, the same
// smoothing at DEM load, the same cost bundle (see lib.mjs).
//
// Usage: node server.mjs [--dem <path.tif>] [--smooth auto|<σ m>]
// Register with Claude Code:
//   claude mcp add simujaules -- node /abs/path/to/simujaules/mcp/server.mjs
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolve } from "node:path";

// stdout IS the JSON-RPC wire. Nothing may print there — route every console
// channel to stderr before any library code runs.
for (const k of ["log", "info", "debug", "warn", "trace"]) console[k] = (...a) => console.error(...a);

// lib.mjs pulls census/census-density.mjs, whose geotiff/jszip resolve from
// census/node_modules — a fresh clone needs `npm install` there too (the
// postinstall in package.json does it). Turn the link error into one line.
let lib;
try {
  lib = await import("./lib.mjs");
} catch (e) {
  if (e?.code === "ERR_MODULE_NOT_FOUND") {
    console.error(`simujaules-mcp: ${e.message}\n→ run \`npm install\` in BOTH census/ and mcp/ (see mcp/README.md).`);
    process.exit(1);
  }
  throw e;
}
const {
  loadDemInThread, demSummary, resolvePoint, cellCentre,
  buildRunMessage, runEngine, runDensity, fieldStats,
  pathFCFromIndices, routesFCFromList, routeDirectionLabel, fieldDirectionLabel, fcForWire,
  buildBundleMetadata, writeRunOutputs,
  DEFAULT_N_DIRS,
} = lib;

const SERVER_VERSION = "0.1.0";
const USAGE = "Usage: node server.mjs [--dem <path.tif>] [--smooth auto|<sigma metres>]";

const state = {
  dem: null,        // loaded (and pre-smoothed) DEM, see lib.loadDemSmoothed
  last: null,       // last computed field: { tool, mode, energy, passes, ... } for energy_at
  runCounter: 0,
  busy: false,      // one compute (or DEM load) at a time — one engine grid in memory
  preloading: null, // --dem path while the startup preload runs
  shuttingDown: false,
};
const shutdownAC = new AbortController();

// ---- argv (before anything else, so bad flags fail fast with exit 1) --------------
function parseArgv(argv) {
  const out = { demPath: null, smooth: "auto" };
  const fail = (msg) => { console.error(`simujaules-mcp: ${msg}\n${USAGE}`); process.exit(1); };
  const need = (flag, v) => { if (v === undefined || v.startsWith("--")) fail(`${flag} needs a value`); return v; };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--dem") out.demPath = need(k, argv[++i]);
    else if (k === "--smooth") {
      const v = need(k, argv[++i]);
      if (v === "auto") out.smooth = "auto";
      else {
        const s = Number(v);
        if (!Number.isFinite(s) || s < 0) fail(`--smooth: expected auto or a σ ≥ 0 in metres, got ${v}`);
        out.smooth = s;
      }
    } else if (k === "-h" || k === "--help") { console.error(USAGE); process.exit(0); }
    else fail(`unknown argument ${k}`);
  }
  return out;
}
const cli = parseArgv(process.argv.slice(2));

// ---- schemas ---------------------------------------------------------------------
const pointSchema = z.object({
  lon: z.number().optional().describe("x / longitude in the DEM's CRS units (degrees on a geographic DEM)"),
  lat: z.number().optional().describe("y / latitude in the DEM's CRS units"),
  row: z.number().int().optional().describe("alternative to lon/lat: pixel row (0 = north edge)"),
  col: z.number().int().optional().describe("alternative to lon/lat: pixel column (0 = west edge)"),
}).describe("A point: {lon, lat} or {row, col}");

const physicsShape = {
  mass: z.number().min(1).default(75).describe("rider + bike mass, kg"),
  crr: z.number().min(0).default(0.008).describe("rolling resistance coefficient"),
  cda: z.number().min(0).default(0.45).describe("drag area CdA, m²"),
  rho: z.number().min(0).default(1.1).describe("air density, kg/m³ (1.1 ≈ São Paulo, 750 m asl)"),
  keff: z.number().min(0.1).max(1).default(0.97).describe("drivetrain efficiency"),
  pFlat: z.number().min(1).default(80).describe("rider power on the flat, W (sets cruise speed and aero cost)"),
  climbThrPct: z.number().min(0).default(2).describe("climb threshold grade, % — above it aero drag is not charged"),
  kSmooth: z.number().min(0).max(1).default(1).describe("gravity smoothing factor 0..1 (1 = full climb cost)"),
};
const runShape = {
  ...physicsShape,
  eMax: z.number().min(0).default(0).describe("energy budget, kJ; 0 = unlimited. Cells beyond it stay unreachable (Infinity)"),
  eMaxMode: z.enum(["leg", "total"]).default("leg").describe("round mode only: cap each leg (leg) or the round-trip sum (total)"),
  nDirs: z.union([z.literal(4), z.literal(8), z.literal(16), z.literal(32), z.literal(64), z.literal(128)])
    .default(DEFAULT_N_DIRS).describe("move directions on the grid: 4, 8, 16, 32, 64 or 128; 16 = app default, 8 = classic/fast"),
};
const outputShape = {
  outDir: z.string().optional().describe("directory to write outputs into: <name>.zip (app-importable bundle), <name>.energy.tif, <name>.passes.tif, <name>.geojson. Omit to keep results in memory only"),
  name: z.string().optional().describe("base file name for outputs (default simujaules-field-<n> / simujaules-route-<n> / simujaules-density-<n>, one counter per server)"),
};
const modeSchema = z.enum(["from", "to", "round"]).default("from")
  .describe("from = energy to ride FROM the point to each cell; to = energy from each cell TO the point; round = both legs summed");

// ---- helpers ----------------------------------------------------------------------
function requireDem() {
  if (!state.dem) {
    throw new Error(state.preloading
      ? `DEM preload of ${state.preloading} is still running — retry shortly`
      : "no DEM loaded — call load_dem first");
  }
  return state.dem;
}
function physicsOf(a) {
  const { mass, crr, cda, rho, keff, pFlat, climbThrPct, kSmooth } = a;
  return { mass, crr, cda, rho, keff, pFlat, climbThrPct, kSmooth };
}
// Text carries the human summary plus a COMPACT copy of the structured
// result (hosts may surface only `content`); never pretty-print it.
function reply(structured, summary) {
  const text = summary ? `${summary}\n${JSON.stringify(structured)}` : JSON.stringify(structured);
  return { content: [{ type: "text", text }], structuredContent: structured };
}
// MCP progress notifications, when the client sent a progressToken. Throttled;
// failures are ignored (progress is best-effort).
function progressReporter(extra) {
  const token = extra?._meta?.progressToken;
  if (token == null) return null;
  let lastAt = 0;
  return (p, message) => {
    const now = Date.now();
    if (p < 1 && now - lastAt < 500) return;
    lastAt = now;
    extra.sendNotification({
      method: "notifications/progress",
      params: { progressToken: token, progress: p, total: 1, ...(message ? { message } : {}) },
    }).catch(() => {});
  };
}
// The request's abort signal (client cancel / transport close) combined with
// the process-level shutdown signal.
function abortSignal(extra) {
  return extra?.signal ? AbortSignal.any([extra.signal, shutdownAC.signal]) : shutdownAC.signal;
}
async function withCompute(fn) {
  if (state.busy) {
    throw new Error(state.preloading
      ? `DEM preload of ${state.preloading} is still running — retry shortly`
      : "a compute is already running — wait for it to finish");
  }
  state.busy = true;
  try { return await fn(); } finally { state.busy = false; }
}
function runName(tool, name) {
  state.runCounter++;
  return name || `simujaules-${tool}-${state.runCounter}`;
}
function fmtKJ(v) { return v == null || !Number.isFinite(v) ? "∞" : `${v.toFixed(1)} kJ`; }
function wireDecimals(dem) { return dem.isGeographic ? 6 : 2; }

async function loadDemGuarded(path, { label, smooth }, extra) {
  return withCompute(async () => {
    const progress = progressReporter(extra);
    const dem = await loadDemInThread(path, { label, smooth }, {
      signal: abortSignal(extra),
      onStage: progress ? (s) => progress(s === "smooth" ? 0.5 : 0.1, s === "smooth" ? "smoothing heights" : "decoding GeoTIFF") : null,
    });
    state.dem = dem;
    state.last = null;
    return dem;
  });
}

// ---- server ---------------------------------------------------------------------------
const server = new McpServer(
  { name: "simujaules", version: SERVER_VERSION },
  {
    capabilities: { logging: {} },
    instructions:
      "Simujaules: cycling ENERGY (kJ) fields over a digital elevation model, using the same engine as " +
      "https://simujaules.pedalhidrografi.co. Workflow: load_dem (a GeoTIFF; heights are pre-smoothed σ 30 m like the app) → " +
      "energy_field / route / density → energy_at to probe the last field. Coordinates are lon/lat (degrees) on a geographic DEM. " +
      "Mode semantics: 'from' = energy to ride from the source to every cell; 'to' = energy to reach the source from every cell " +
      "(route geometry is still written source→destination); 'round' = both legs summed. Energies are minimal path energies under " +
      "the v2 cost model (asymmetric uphill/downhill; descents refund partially, never below 0). Big DEMs take minutes — pass an " +
      "outDir to keep the field as GeoTIFF/bundle files (importable in the app over the same DEM). One compute runs at a time.",
  },
);

server.registerTool("load_dem", {
  title: "Load DEM",
  description:
    "Load a GeoTIFF digital elevation model into the server (replaces the current one and clears cached results). " +
    "Applies the app's pre-smoothing rule: 'auto' = Gaussian σ 30 m unless the file is an app dem.tif export already " +
    "carrying its smoothing tag; a number = that σ in metres (0 = raw). Returns grid size, extent, cell size and elevation range.",
  inputSchema: {
    path: z.string().describe("absolute or cwd-relative path to a GeoTIFF (single band; GDAL_NODATA honoured)"),
    label: z.string().optional().describe("display label recorded in bundle metadata (default: the file name)"),
    smooth: z.union([z.literal("auto"), z.number().min(0)]).default("auto")
      .describe("'auto' (app default, σ 30 m) or an explicit σ in metres (0 = no smoothing)"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ path, label, smooth }, extra) => {
  const dem = await loadDemGuarded(resolve(path), { label, smooth }, extra);
  const s = demSummary(dem);
  const summary =
    `Loaded ${s.label}: ${s.W}×${s.H} cells (${s.validCells.toLocaleString()} valid), ` +
    `cell ≈ ${s.cellSizeM.dx.toFixed(1)}×${s.cellSizeM.dy.toFixed(1)} m, ` +
    `extent x ${s.bbox.xmin}..${s.bbox.xmax}, y ${s.bbox.ymin}..${s.bbox.ymax}` +
    (s.elevationM ? `, elevation ${s.elevationM.min.toFixed(0)}–${s.elevationM.max.toFixed(0)} m` : "") +
    `, smoothing σ ${s.smoothing.appliedSigmaM} m applied (cumulative ${s.smoothing.cumulativeSigmaM.toFixed(1)} m).`;
  return reply(s, summary);
});

server.registerTool("dem_info", {
  title: "DEM info",
  description: "Describe the currently loaded DEM (grid, extent, cell size, elevation range, smoothing) and whether a field is cached for energy_at.",
  inputSchema: {},
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
}, async () => {
  if (!state.dem) {
    return reply({ loaded: false, preloading: state.preloading },
      state.preloading ? `DEM preload of ${state.preloading} is still running.` : "No DEM loaded. Call load_dem with a GeoTIFF path.");
  }
  const s = demSummary(state.dem);
  const last = state.last ? {
    tool: state.last.tool, mode: state.last.mode, src: state.last.src ?? null, dst: state.last.dst ?? null,
    nRefs: state.last.refs?.length ?? null,
  } : null;
  return reply({ loaded: true, dem: s, lastField: last },
    `${s.label}: ${s.W}×${s.H} cells, σ ${s.smoothing.appliedSigmaM} m` + (last ? `; cached field: ${last.tool} (${last.mode})` : "; no field cached"));
});

server.registerTool("energy_field", {
  title: "Energy field",
  description:
    "Compute the single-source energy field (kJ to every cell) and the passes count (how many optimal paths cross each cell — " +
    "the terrain's natural corridors) from/to/round a point. Caches the field for energy_at; writes GeoTIFFs + an " +
    "app-importable bundle when outDir is given. Returns summary statistics, never the whole raster.",
  inputSchema: {
    mode: modeSchema,
    point: pointSchema.describe("the source (mode from), the destination (mode to), or the round-trip anchor"),
    ...runShape,
    ...outputShape,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async (a, extra) => {
  const dem = requireDem();
  const seed = resolvePoint(dem, a.point, "point");
  const physics = physicsOf(a);
  return withCompute(async () => {
    const progress = progressReporter(extra);
    const msg = buildRunMessage(dem, { mode: a.mode, seed, physics, eMax: a.eMax, eMaxMode: a.eMaxMode, nDirs: a.nDirs });
    const res = await runEngine(msg, { onProgress: progress ? (p) => progress(p, "dijkstra") : null, signal: abortSignal(extra) });
    const stats = fieldStats(res.energy, res.passes, dem.mask);
    const run = { tool: "energy_field", mode: a.mode, src: seed, physics, eMax: a.eMax, eMaxMode: a.eMaxMode, nDirs: a.nDirs };
    state.last = { ...run, energy: res.energy, passes: res.passes, elapsedMs: res.elapsedMs };
    const out = {
      mode: a.mode, direction: fieldDirectionLabel(a.mode, "energy_field"),
      point: { row: seed[0], col: seed[1], lonLat: cellCentre(dem, seed[0], seed[1]) },
      params: { ...physics, eMax: a.eMax, eMaxMode: a.eMaxMode, nDirs: a.nDirs },
      stats, elapsedMs: res.elapsedMs, files: null,
    };
    if (a.outDir) {
      const md = buildBundleMetadata(dem, run, res);
      out.files = await writeRunOutputs(resolve(a.outDir), runName("field", a.name), dem, md, res);
    }
    const summary =
      `Energy field (${a.mode}) from cell [${seed[0]}, ${seed[1]}]: ${stats.reachableCells.toLocaleString()} of ` +
      `${stats.validCells.toLocaleString()} cells reachable (${(100 * stats.reachableFraction).toFixed(1)} %)` +
      (stats.energyKJ ? `; energy p50 ${fmtKJ(stats.energyKJ.p50)}, p80 ${fmtKJ(stats.energyKJ.p80)}, max ${fmtKJ(stats.energyKJ.max)}` : "") +
      `; passes max ${stats.passesMax?.toLocaleString()}; ${(res.elapsedMs / 1000).toFixed(1)} s.` +
      (out.files ? `\nWrote ${Object.values(out.files).join(", ")}` : "\n(field cached in memory for energy_at; pass outDir to save it)");
    return reply(out, summary);
  });
});

server.registerTool("route", {
  title: "Route",
  description:
    "Minimum-energy route between two points on the DEM grid (Dijkstra with the v2 cycling cost model), optionally with " +
    "top-N diverse alternatives (A*, with a repulsion penalty on already-used cells). Returns kJ, length and GeoJSON " +
    "LineStrings (cell centres, lon/lat; thinned to maxVertices on the wire — the files in outDir keep every vertex). " +
    "The path's energy IS the sum the search minimised — there is no second estimate. Also caches the full field from the source for energy_at.",
  inputSchema: {
    from: pointSchema.describe("source"),
    to: pointSchema.describe("destination"),
    mode: modeSchema.describe("from (default): energy source→destination. to: energy destination→source (geometry still written source→destination). round: energy is the round trip; the geometry is the outbound leg"),
    topN: z.number().int().min(0).max(20).default(0).describe("0 = only the optimal path; N ≥ 1 = also N diverse alternative routes"),
    penalty: z.number().min(0).default(2).describe("repulsion strength for alternatives (per-cell: multiplier > 1)"),
    repulsionMode: z.enum(["per-cell", "linear", "square"]).default("per-cell"),
    stringPull: z.boolean().default(false).describe("post-hoc shortcutting of the displayed route (never worsens energy; not in round mode)"),
    includeGeometry: z.boolean().default(true).describe("include GeoJSON in the response"),
    maxVertices: z.number().int().min(2).max(100000).default(1500).describe("vertex budget for the inline GeoJSON (all lines together); above it every k-th vertex is kept. Files are never thinned"),
    ...runShape,
    ...outputShape,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async (a, extra) => {
  const dem = requireDem();
  const seed = resolvePoint(dem, a.from, "from");
  const goal = resolvePoint(dem, a.to, "to");
  if (seed[0] === goal[0] && seed[1] === goal[1]) {
    throw new Error(`from and to resolve to the same cell [${seed[0]}, ${seed[1]}] — a route needs two distinct cells ` +
      `(cell ≈ ${dem.dxM.toFixed(0)}×${dem.dyM.toFixed(0)} m; points closer than that collapse together)`);
  }
  const physics = physicsOf(a);
  return withCompute(async () => {
    const progress = progressReporter(extra);
    const msg = buildRunMessage(dem, {
      mode: a.mode, seed, goal, physics, eMax: a.eMax, eMaxMode: a.eMaxMode, nDirs: a.nDirs,
      topN: a.topN, penalty: a.penalty, repulsionMode: a.repulsionMode, stringPull: a.stringPull,
    });
    const res = await runEngine(msg, { onProgress: progress ? (p) => progress(p, "routing") : null, signal: abortSignal(extra) });
    const run = {
      tool: "route", mode: a.mode, src: seed, dst: goal, physics, eMax: a.eMax, eMaxMode: a.eMaxMode, nDirs: a.nDirs,
      topN: a.topN, penalty: a.penalty, repulsionMode: a.repulsionMode, stringPull: a.stringPull,
    };
    state.last = { ...run, energy: res.energy, passes: res.passes, path: res.path, routes: res.routes, elapsedMs: res.elapsedMs };
    const pathFC = res.path ? pathFCFromIndices(res.path, dem, { energy: res.pathEnergy, length_m: res.pathLengthM }, a.mode) : null;
    const routesFC = res.routes?.length ? routesFCFromList(res.routes, dem, a.mode) : null;
    const wire = a.includeGeometry ? fcForWire(routesFC || pathFC, { maxVertices: a.maxVertices, decimals: wireDecimals(dem) }) : null;
    const out = {
      mode: a.mode, direction: routeDirectionLabel(a.mode),
      from: { row: seed[0], col: seed[1], lonLat: cellCentre(dem, seed[0], seed[1]) },
      to: { row: goal[0], col: goal[1], lonLat: cellCentre(dem, goal[0], goal[1]) },
      reachable: res.path != null,
      path: res.path ? {
        energyKJ: res.pathEnergy, lengthM: res.pathLengthM, cells: res.path.length,
        stringPulled: !!res.stringPulled,
        ...(a.mode === "round" ? { note: "energy is the round trip; geometry is the outbound leg" } : {}),
      } : null,
      routes: res.routes ? res.routes.map((r, i) => ({
        rank: i + 1, energyKJ: r.energy, lengthM: r.length, sharedCells: r.shared, cells: r.path.length,
      })) : null,
      ...(res.routes?.length && a.mode === "round" ? { routesNote: "alternative routes are scored and drawn for the outbound leg only" } : {}),
      geojson: wire ? wire.fc : undefined,
      ...(wire ? { geometry: { vertices: wire.vertices, totalVertices: wire.totalVertices, decimated: wire.decimated, step: wire.step, decimals: wireDecimals(dem) } } : {}),
      params: { ...physics, eMax: a.eMax, eMaxMode: a.eMaxMode, nDirs: a.nDirs, topN: a.topN, penalty: a.penalty, repulsionMode: a.repulsionMode, stringPull: a.stringPull },
      elapsedMs: res.elapsedMs, files: null,
    };
    if (a.outDir) {
      const md = buildBundleMetadata(dem, run, res);
      out.files = await writeRunOutputs(resolve(a.outDir), runName("route", a.name), dem, md, res, { pathFC, routesFC });
    }
    let summary = res.path
      ? `Route (${a.mode}) [${seed[0]}, ${seed[1]}] → [${goal[0]}, ${goal[1]}]: ${fmtKJ(res.pathEnergy)}, ` +
        `${(res.pathLengthM / 1000).toFixed(2)} km, ${res.path.length} cells` + (res.stringPulled ? " (string-pulled)" : "") + "."
      : `Destination unreachable from the source${a.eMax > 0 ? ` within the ${a.eMax} kJ budget` : ""} (nodata barrier?).`;
    if (res.routes?.length) {
      summary += `\nTop-${res.routes.length} alternatives${a.mode === "round" ? " (outbound leg only)" : ""}:` + res.routes.map((r, i) =>
        `\n  ${i + 1}. ${fmtKJ(r.energy)}, ${(r.length / 1000).toFixed(2)} km` + (r.shared ? ` (${r.shared} cells shared)` : "")).join("");
    }
    if (wire?.decimated) summary += `\nInline GeoJSON thinned to every ${wire.step}th vertex (${wire.vertices} of ${wire.totalVertices}); the files keep all vertices.`;
    if (out.files) summary += `\nWrote ${Object.values(out.files).join(", ")}`;
    return reply(out, summary);
  });
});

server.registerTool("energy_at", {
  title: "Energy at points",
  description:
    "Sample the LAST computed field (energy_field, route or density) at points: energy in kJ (unreachable → null), " +
    "the passes count (after density: the normalised density, ~1e-8..1e-3), and the smoothed DEM elevation. Cheap — no recompute.",
  inputSchema: {
    points: z.array(pointSchema).min(1).max(1000),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
}, async ({ points }) => {
  const dem = requireDem();
  const last = state.last;
  if (!last?.energy) throw new Error("no field cached — run energy_field, route or density first");
  const isDensity = last.tool === "density";
  const samples = points.map((pt, i) => {
    let rc, err = null;
    try { rc = resolvePoint(dem, pt, `points[${i}]`); } catch (e) { err = e.message; }
    if (!rc) return { input: pt, error: err };
    const idx = rc[0] * dem.W + rc[1];
    const e = last.energy[idx];
    return {
      input: pt, row: rc[0], col: rc[1], lonLat: cellCentre(dem, rc[0], rc[1]),
      elevationM: dem.height[idx],
      reachable: Number.isFinite(e),
      energyKJ: Number.isFinite(e) ? e : null,
      passes: last.passes ? last.passes[idx] : null,   // after density: the normalised density
    };
  });
  const out = {
    field: {
      tool: last.tool, mode: last.mode, direction: fieldDirectionLabel(last.mode, last.tool),
      src: last.src ?? null, nRefs: last.refs?.length ?? null,
      passesMeaning: isDensity ? "normalised density (Σ passes / N²)" : "passes count (optimal paths through the cell)",
    },
    samples,
  };
  const fmtP = (p) => p == null ? "-" : isDensity ? p.toExponential(3) : p.toFixed(0);
  const summary = samples.map((s, i) => s.error
    ? `${i + 1}. ERROR ${s.error}`
    : `${i + 1}. [${s.row}, ${s.col}] ${s.reachable ? fmtKJ(s.energyKJ) : "unreachable"}, ${isDensity ? "density" : "passes"} ${fmtP(s.passes)}, ${s.elevationM.toFixed(1)} m`)
    .join("\n") + `\n(field: ${last.tool}, mode ${last.mode} — ${out.field.direction})`;
  // The lines already carry every sampled value; keep the structured copy off
  // the text for up to 1 000 points.
  return { content: [{ type: "text", text: summary }], structuredContent: out };
});

server.registerTool("density", {
  title: "Multi-reference density",
  description:
    "Passes DENSITY over many reference points: one Dijkstra per reference, corridors summed and normalised (Σ passes / N², " +
    "grows ~linearly with the number of refs — compare runs at matching counts), plus the per-cell mean energy over the refs " +
    "that reached it. Duplicate points act as weights (e.g. population-weighted samples). Caches the field for energy_at.",
  inputSchema: {
    refs: z.array(pointSchema).min(1).max(20000).describe("reference points; duplicates are weights"),
    mode: modeSchema,
    ...runShape,
    ...outputShape,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async (a, extra) => {
  const dem = requireDem();
  const refs = [];
  const dropped = [];
  a.refs.forEach((pt, i) => {
    try { refs.push(resolvePoint(dem, pt, `refs[${i}]`)); } catch (e) { dropped.push(e.message); }
  });
  if (!refs.length) throw new Error("no valid reference points: " + dropped.slice(0, 3).join("; "));
  const physics = physicsOf(a);
  return withCompute(async () => {
    const progress = progressReporter(extra);
    const res = await runDensity(dem, refs, { mode: a.mode, physics, eMax: a.eMax, eMaxMode: a.eMaxMode, nDirs: a.nDirs },
      { onProgress: progress ? (p) => progress(p, "refs") : null, signal: abortSignal(extra) });
    const stats = fieldStats(res.energy, res.passes, dem.mask);
    const run = { tool: "density", mode: a.mode, physics, eMax: a.eMax, eMaxMode: a.eMaxMode, nDirs: a.nDirs, wantDensity: true, refPoints: refs, refSource: "random" };
    state.last = { ...run, refs, energy: res.energy, passes: res.passes, elapsedMs: res.elapsedMs };
    const out = {
      mode: a.mode, direction: fieldDirectionLabel(a.mode, "density"),
      nRefs: refs.length, droppedRefs: dropped.length,
      params: { ...physics, eMax: a.eMax, eMaxMode: a.eMaxMode, nDirs: a.nDirs },
      stats: { ...stats, densityMax: stats.passesMax }, elapsedMs: res.elapsedMs, files: null,
      ...(dropped.length ? { droppedReasons: dropped.slice(0, 10) } : {}),
    };
    if (a.outDir) {
      const md = buildBundleMetadata(dem, run, res);
      out.files = await writeRunOutputs(resolve(a.outDir), runName("density", a.name), dem, md, res);
    }
    const summary =
      `Density (${a.mode}) over ${refs.length} refs${dropped.length ? ` (${dropped.length} dropped)` : ""}: ` +
      `${stats.reachableCells.toLocaleString()} cells reached by ≥ 1 ref; mean-energy p50 ${fmtKJ(stats.energyKJ?.p50)}, ` +
      `density max ${stats.passesMax?.toExponential(3)}; ${(res.elapsedMs / 1000).toFixed(1)} s.` +
      (out.files ? `\nWrote ${Object.values(out.files).join(", ")}` : "\n(field cached in memory for energy_at; pass outDir to save it)");
    return reply(out, summary);
  });
});

// ---- lifecycle ----------------------------------------------------------------------
// SDK 1.30's StdioServerTransport never raises onclose on stdin EOF, so a host
// that just drops the pipes would leave a compute running for nobody (and a
// later write would die with EPIPE). Closing the server aborts every
// in-flight handler's signal — the one runEngine/loadDemInThread terminate
// their Worker on — then the process exits.
function shutdown(code = 0) {
  if (state.shuttingDown) return;
  state.shuttingDown = true;
  shutdownAC.abort();
  server.close().catch(() => {}).finally(() => process.exit(code));
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stdin.once("end", () => shutdown(0));
  process.stdin.once("close", () => shutdown(0));
  process.stdout.on("error", (e) => { if (e?.code === "EPIPE") shutdown(0); });
  process.on("SIGTERM", () => shutdown(0));
  process.on("SIGINT", () => shutdown(0));

  if (cli.demPath) {
    // After connect (a big DEM would otherwise stall the initialize handshake
    // past host startup timeouts); under the busy flag so an early load_dem
    // cannot be clobbered when the preload lands.
    state.preloading = cli.demPath;
    try {
      const dem = await loadDemGuarded(resolve(cli.demPath), { smooth: cli.smooth }, null);
      console.error(`simujaules-mcp: preloaded ${cli.demPath} (${dem.W}x${dem.H}, σ ${dem.smoothSigmaM} m)`);
    } catch (e) {
      console.error(`simujaules-mcp: could not preload ${cli.demPath}: ${e.message}`);
    } finally {
      state.preloading = null;
    }
  }
}

main().catch((e) => { console.error("simujaules-mcp fatal:", e); process.exit(1); });
