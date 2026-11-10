// The engine's run message has ONE builder (lib/run-message.js) and three
// senders (the app, the MCP server, the census harness). energy-worker.js
// silently defaults any key a sender leaves out, so drift between "what the
// worker reads" and "what the senders send" is invisible at run time. This
// test makes it visible:
//   1. the keys the builders produce are EXACTLY the keys the worker's run
//      handler reads (both directions);
//   2. the builders are strict — a missing or unknown input throws;
//   3. no sender writes a `kind: "run"` literal by hand any more.
// Run with `node test-run-message.mjs` (no dependencies).
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import {
  buildRunMessage, densitySliceMessage, RUN_MESSAGE_GRID_KEYS, RUN_MESSAGE_SLICE_KEYS,
} from "./lib/run-message.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, p), "utf8");
let passed = 0, failed = 0;
const ok = (cond, msg) => { if (cond) passed++; else { failed++; console.error("  FAIL:", msg); } };
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

const inputs = () => ({
  H: 4, W: 5, dxM: 28.5, dyM: 30.9, seed: [1, 2], goal: [3, 4],
  mode: "from", cost: { aRoll: 1, aAero: 1, beta: 30, climbThr: 0.02, abRatio: 0.02, epsOffset: 0.13 },
  eMax: 0, eMaxMode: "leg",
  wantPasses: true, wantTopN: false, nRoutes: 3, penalty: 2, repulsionMode: "per-cell",
  wantDensity: false, refPoints: null, densityMode: "from",
  wantNetworkInterp: false, interpMaxDistance: 50, interpSmoothing: 0,
  nDirs: 16, stringPull: false, portals: null,
});

console.log("builders");
const base = buildRunMessage(inputs());
ok(base.kind === "run" && base.dx === 28.5 && base.dy === 30.9, "base carries kind and the metre cell size as dx/dy");
ok(base.seedR === 1 && base.seedC === 2 && base.goalR === 3 && base.goalC === 4, "seed / goal become row/col pairs");
const none = buildRunMessage({ ...inputs(), seed: null, goal: null });
ok(none.seedR === -1 && none.seedC === -1 && none.goalR === -1 && none.goalC === -1, "null seed / goal become −1/−1");
ok(base.maximize === false && base.maximizeLength === 0, "maximize is never requested");
ok(base.portalU === null && base.portalHV === null, "no portals → null portal arrays");
const pu = new Int32Array([1]), pv = new Int32Array([2]), pl = new Float64Array([3]), phu = new Float64Array([NaN]), phv = new Float64Array([NaN]);
const withPortals = buildRunMessage({ ...inputs(), portals: { n: 1, u: pu, v: pv, lenM: pl, hu: phu, hv: phv } });
ok(withPortals.portalU === pu && withPortals.portalV === pv && withPortals.portalLenM === pl && withPortals.portalHU === phu && withPortals.portalHV === phv,
   "portal arrays pass through by reference (cloned by postMessage, never transferred)");
for (const k of Object.keys(inputs())) {
  const p = inputs(); delete p[k];
  ok(throws(() => buildRunMessage(p)), `buildRunMessage refuses a missing "${k}"`);
}
ok(throws(() => buildRunMessage({ ...inputs(), maximize: true })), "buildRunMessage refuses an unknown input (maximize)");
ok(throws(() => buildRunMessage()), "buildRunMessage refuses no argument");

const cells = new Int32Array([7, 13]);
const slice = densitySliceMessage({ ...base, wantNetworkInterp: true }, { refPoints: [[1, 2]], matrixCells: cells });
ok(slice.densityPartial === true && slice.wantMatrix === true && slice.matrixCells === cells, "slice asks for raw accumulators + the matrix");
ok(slice.wantNetworkInterp === false, "a slice never runs the network IDW fill");
ok(slice.refPoints.length === 1 && base.refPoints === null, "slice narrows refPoints without touching the base");
const plain = densitySliceMessage(base, { refPoints: [[1, 2]], matrixCells: null });
ok(plain.wantMatrix === false && plain.matrixCells === null, "no matrix cells → wantMatrix false");
ok(throws(() => densitySliceMessage(base, { refPoints: [[1, 2]] })), "densitySliceMessage refuses a missing matrixCells");

// ---- what the worker reads ---------------------------------------------------
console.log("worker ⇄ builder key parity");
const worker = read("energy-worker.js");
const start = worker.indexOf('if (msg.kind !== "run") return;');
const end = worker.indexOf("} = msg;", start);
ok(start > 0 && end > start, "found the run handler's destructuring in energy-worker.js");
const block = worker.slice(worker.indexOf("const {", start) + "const {".length, end)
  .replace(/\/\/.*$/gm, "");                       // drop the trailing comments
const destructured = block.split(",").map((s) => s.trim().split(/\s*=\s*/)[0].trim()).filter(Boolean);
ok(destructured.length > 25 && destructured.every((k) => /^[A-Za-z]\w*$/.test(k)), `parsed ${destructured.length} destructured keys`);
// …plus the keys the handler reads off `msg` directly (the portal arrays).
const handler = worker.slice(start);
const direct = [...handler.matchAll(/\bmsg\.([A-Za-z]\w*)/g)].map((m) => m[1]);
const workerKeys = new Set([...destructured, ...direct, "kind"]);
const built = new Set([...Object.keys(plain), ...RUN_MESSAGE_GRID_KEYS, ...RUN_MESSAGE_SLICE_KEYS]);
for (const k of workerKeys) ok(built.has(k), `the worker reads "${k}" and the builders send it`);
for (const k of built) ok(workerKeys.has(k), `the builders send "${k}" and the worker reads it`);

// wasm-worker.js sits in front of the JS engine: everything it reads off the
// message must be something the builders (or the page's wasm attachment) send.
const wasmReads = new Set([...read("wasm-worker.js").matchAll(/\bmsg\.([A-Za-z]\w*)/g)].map((m) => m[1]));
for (const k of wasmReads) ok(built.has(k) || k === "wasm", `wasm-worker.js reads "${k}", which the page sends`);

// ---- every sender goes through the builder -----------------------------------
console.log("senders");
const SENDERS = {
  "app/run.js": [/from "\.\.\/lib\/run-message\.js"/, /\bbuildRunMessage\(/, /\bdensitySliceMessage\(/],
  "mcp/lib.mjs": [/from "\.\.\/lib\/run-message\.js"/, /\bbuildEngineRunMessage\(/],
  "census/census-density.mjs": [/from "\.\.\/lib\/run-message\.js"/, /\bbuildRunMessage\(/, /\bdensitySliceMessage\(/],
};
for (const [file, patterns] of Object.entries(SENDERS)) {
  const src = read(file);
  for (const re of patterns) ok(re.test(src), `${file} uses the shared builder (${re.source})`);
  ok(!/kind:\s*"run"/.test(src), `${file} writes no run-message literal by hand`);
}

console.log(failed ? `\n${failed} FAILED, ${passed} passed` : `\nALL PASS — ${passed} checks`);
process.exit(failed ? 1 : 0);
