// lib/run-message.js — the engine's `kind: "run"` message, built in ONE place.
//
// energy-worker.js (and wasm-worker.js, which forwards to it) destructure this
// message and silently DEFAULT every key that is missing. A sender that
// forgets a field therefore does not fail — it runs a different computation.
// The app (app/run.js), the MCP server (mcp/lib.mjs) and the census harness
// (census/census-density.mjs) each used to write the literal by hand; they
// now all call these builders, and the builders are STRICT: every input must
// be given explicitly (null where "none" is meant), so a new field cannot be
// added here without every sender being made to state it.
// test-run-message.mjs pins the other direction: the set of keys built here
// is exactly the set the worker reads.
//
// Pure: no DOM, no `state`. The grid arrays (height / mask / networkMask) are
// deliberately NOT part of the message built here — every sender attaches its
// own copies, because they are transferred to the worker.

const BASE_INPUTS = [
  "H", "W", "dxM", "dyM", "seed", "goal",
  "mode", "cost", "eMax", "eMaxMode",
  "wantPasses", "wantTopN", "nRoutes", "penalty", "repulsionMode",
  "wantDensity", "refPoints", "densityMode",
  "wantNetworkInterp", "interpMaxDistance", "interpSmoothing",
  "nDirs", "stringPull", "portals",
];

function requireAll(fn, p, names) {
  if (!p || typeof p !== "object") throw new TypeError(`${fn}: an options object is required`);
  for (const k of names) if (p[k] === undefined) throw new TypeError(`${fn}: "${k}" is required (pass null for none)`);
  for (const k of Object.keys(p)) if (!names.includes(k)) throw new TypeError(`${fn}: unknown input "${k}"`);
}

// The message every run starts from.
//   H, W            grid size
//   dxM, dyM        cell size in METRES (the cost model's unit)
//   seed, goal      [row, col] or null (→ −1/−1 on the wire)
//   mode            "from" | "to" | "round"
//   cost            the v2 cost bundle (lib/cost.js deriveCost)
//   eMax, eMaxMode  energy budget in kJ (0 = none) and "leg" | "total"
//   refPoints       [[row, col], …] for density, else null
//   portals         { u, v, lenM, hu, hv } typed arrays (the app's
//                   buildPortals) or null — small, structured-cloned, never
//                   transferred (the density pool shares them)
export function buildRunMessage(p) {
  requireAll("buildRunMessage", p, BASE_INPUTS);
  const { seed, goal, portals } = p;
  return {
    kind: "run",
    H: p.H, W: p.W,
    dx: p.dxM,
    dy: p.dyM,
    seedR: seed ? seed[0] : -1,
    seedC: seed ? seed[1] : -1,
    goalR: goal ? goal[0] : -1,
    goalC: goal ? goal[1] : -1,
    mode: p.mode, cost: p.cost, eMax: p.eMax, eMaxMode: p.eMaxMode,
    wantPasses: p.wantPasses, wantTopN: p.wantTopN, nRoutes: p.nRoutes, penalty: p.penalty, repulsionMode: p.repulsionMode,
    wantDensity: p.wantDensity,
    refPoints: p.refPoints,
    densityMode: p.densityMode,
    wantNetworkInterp: p.wantNetworkInterp,
    interpMaxDistance: p.interpMaxDistance,
    interpSmoothing: p.interpSmoothing,
    // The engines still implement maximize (and the layered-DP max-cost path),
    // but no sender asks for it: the app's control was dropped in v83.
    maximize: false,
    maximizeLength: 0,
    nDirs: p.nDirs,
    stringPull: p.stringPull,
    portalU: portals ? portals.u : null,
    portalV: portals ? portals.v : null,
    portalLenM: portals ? portals.lenM : null,
    portalHU: portals ? portals.hu : null,   // deck-end ele (NaN = use DEM)
    portalHV: portals ? portals.hv : null,
  };
}

// One density-pool slice: the base message narrowed to this slice's reference
// points, asking for RAW accumulators (density, energySum, energyCount) that
// the sender merges and normalises. `matrixCells` is the Int32Array of ALL K
// refs' flat cells when the accessibility matrix is wanted, else null. The
// network IDW fill never runs per slice (it runs once, after the merge).
export function densitySliceMessage(base, p) {
  requireAll("densitySliceMessage", p, ["refPoints", "matrixCells"]);
  return {
    ...base,
    refPoints: p.refPoints,
    densityPartial: true,
    wantMatrix: !!p.matrixCells,
    matrixCells: p.matrixCells,
    wantNetworkInterp: false,
  };
}

// Key sets, for test-run-message.mjs.
export const RUN_MESSAGE_GRID_KEYS = ["height", "mask", "networkMask"];
export const RUN_MESSAGE_SLICE_KEYS = ["densityPartial", "wantMatrix", "matrixCells"];
