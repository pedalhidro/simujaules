// End-to-end check: starts the release binary, sends a framed /density
// request, and compares the response against energy-worker.js run in-process.
// Usage: cargo build --release && node test-backend.mjs
import { readFileSync } from "fs";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const here = dirname(fileURLToPath(import.meta.url));
const ADDR = "127.0.0.1:8177"; // off the default port so a running dev server isn't disturbed

// ---- JS worker reference, driven through its real onmessage handler ----
function loadWorker() {
  const src = readFileSync(join(here, "..", "energy-worker.js"), "utf8");
  const messages = [];
  const sandbox = { postMessage: (m) => messages.push(m), self: {}, performance, console };
  new Function(...Object.keys(sandbox), src)(...Object.values(sandbox));
  return (msg) => {
    messages.length = 0;
    sandbox.self.onmessage({ data: msg });
    const err = messages.find((m) => m.kind === "error");
    if (err) throw new Error(err.message);
    return messages.find((m) => m.kind === "done");
  };
}

const H = 256, W = 256, N = H * W;
const height = new Float32Array(N);
for (let r = 0; r < H; r++)
  for (let c = 0; c < W; c++)
    height[r * W + c] =
      50 * Math.sin(r * 0.013) * Math.cos(c * 0.017) +
      20 * Math.sin(r * 0.05 + c * 0.031) + 800;
const mask = new Uint8Array(N).fill(1);
for (let i = 0; i < N; i += 997) mask[i] = 0;
const refs = [[40, 60], [100, 200], [180, 30], [220, 230], [128, 128]];

// v2 cost bundle (see energy-worker.js v2Edge / main.rs v2_edge). Chosen so the
// synthetic relief exercises every branch: climbs ≥ climbThr drop aero, and the
// per-grade descent recovery ε = clamp01(min(1, abRatio/s) − epsOffset) varies.
// abRatio = (aRoll+aAero)/beta keeps the bundle self-consistent.
const cost = { aRoll: 1, aAero: 0.5, beta: 30, climbThr: 0.05, abRatio: 0.05, epsOffset: 0.13 };

const server = spawn(join(here, "target", "release", "simujoules-backend"), [ADDR], {
  stdio: ["ignore", "inherit", "inherit"],
});
process.on("exit", () => server.kill());
// wait for the port
for (let i = 0; ; i++) {
  try { await fetch(`http://${ADDR}/health`); break; }
  catch { if (i > 50) throw new Error("server never came up"); await new Promise((r) => setTimeout(r, 100)); }
}

const runWorker = loadWorker();
let allOk = true;

// Bridge portal edges: deck shortcuts between far cells (endpoints off the
// nodata cells). They genuinely change the field, so the +portals cases verify
// the Rust portal port matches the JS worker bit-for-bit.
const portalU    = new Int32Array([ 10 * W + 10,  50 * W + 200, 200 * W + 20 ]);
const portalV    = new Int32Array([ 240 * W + 240, 60 * W + 60,  30 * W + 220 ]);
const portalLenM = new Float64Array([ 1500, 800, 2000 ]);
// Deck-end elevations (OSM `ele`): NaN ⇒ engine uses the DEM at the abutment
// cell; finite ⇒ the mapped deck height. Mix both so the +portals parity cases
// cover the NaN-fallback AND the explicit-ele paths in one sweep.
const portalHU = new Float64Array([ NaN, 730, 712 ]);
const portalHV = new Float64Array([ NaN, 705, 718 ]);

const cases = [];
for (const portals of [false, true]) {
  for (const dmode of ["from", "to", "round"]) {
    for (const eMax of [0, 20000]) cases.push({ dmode, eMax, eMaxMode: "leg", portals });
  }
  cases.push({ dmode: "round", eMax: 20000, eMaxMode: "total", portals });
}
// Reverse-optimisation (maximize) density: the edge-inversion path +
// max_edge_cost derivation are identical in both engines but were never
// parity-checked, so a future divergence would slip past the suite.
cases.push({ dmode: "from", eMax: 0, eMaxMode: "leg", maximize: true });

for (const { dmode, eMax, eMaxMode, portals = false, maximize = false } of cases) {
  {
    const nPortals = portals ? portalU.length : 0;
    // backend
    const params = {
      h: H, w: W, dx: 30, dy: 30, cost, eMax, eMaxMode,
      densityMode: dmode, refPoints: refs, hasNetwork: false, maximize,
      nPortals,
    };
    const json = new TextEncoder().encode(JSON.stringify(params));
    const head = new Uint8Array(4);
    new DataView(head.buffer).setUint32(0, json.length, true);
    const parts = [head, json, height, mask];
    if (portals) parts.push(portalU, portalV, portalLenM, portalHU, portalHV);
    const resp = await fetch(`http://${ADDR}/density`, { method: "POST", body: new Blob(parts) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
    const buf = await resp.arrayBuffer();
    const jlen = new DataView(buf).getUint32(0, true);
    let off = 4 + jlen;
    const density = new Float64Array(buf.slice(off, off + 8 * N)); off += 8 * N;
    const energy = new Float32Array(buf.slice(off, off + 4 * N));

    // JS reference
    const ref = runWorker({
      kind: "run", H, W, dx: 30, dy: 30, cost, eMax, eMaxMode,
      seedR: -1, seedC: -1, goalR: -1, goalC: -1, mode: dmode,
      wantDensity: true, refPoints: refs, densityMode: dmode, maximize,
      height: new Float32Array(height), mask: new Uint8Array(mask),
      portalU: portals ? portalU : null,
      portalV: portals ? portalV : null,
      portalLenM: portals ? portalLenM : null,
      portalHU: portals ? portalHU : null,
      portalHV: portals ? portalHV : null,
    });

    let maxD = 0, maxE = 0, bad = 0;
    for (let i = 0; i < N; i++) {
      maxD = Math.max(maxD, Math.abs(density[i] - ref.passes[i]));
      const a = energy[i], b = ref.energy[i];
      if (Number.isFinite(a) !== Number.isFinite(b)) bad++;
      else if (Number.isFinite(a)) maxE = Math.max(maxE, Math.abs(a - b));
    }
    const ok = maxD < 1e-15 && maxE < 1e-3 && bad === 0;
    allOk = allOk && ok;
    console.log(
      `mode=${dmode} eMax=${eMax}${eMaxMode === "total" ? " (total)" : ""}${portals ? " +portals" : ""}${maximize ? " (maximize)" : ""}: ` +
      `max|Δdensity|=${maxD.toExponential(2)}, ` +
      `max|Δenergy|=${maxE.toExponential(2)}, finite-mismatch=${bad} ${ok ? "✓" : "✗"}`,
    );
  }
}

// ---- /single single-source parity (energy field + optional passes) ----
// The non-density fast path: one Dijkstra (two for round) from a single source,
// returning the RAW energy field (not averaged) + optional passes counts. Mirror
// the JS worker's from/to/round single-point branch. Cover network-constrained
// (the eff_mask = dem_mask AND network_mask path) and bridge portals too.
const SR = 128, SC = 128;
// A diagonal band that includes the seed — exercises the network constraint
// (and so the shared eff_mask path) on both engines.
const netMask = new Uint8Array(N);
for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) netMask[r * W + c] = Math.abs(r - c) < 90 ? 1 : 0;

const singleCases = [];
for (const portals of [false, true]) {
  for (const hasNetwork of [false, true]) {
    for (const dmode of ["from", "to", "round"]) {
      for (const eMax of [0, 20000]) {
        for (const wantPasses of [false, true]) {
          singleCases.push({ dmode, eMax, eMaxMode: "leg", portals, hasNetwork, wantPasses });
        }
      }
    }
    singleCases.push({ dmode: "round", eMax: 20000, eMaxMode: "total", portals, hasNetwork, wantPasses: true });
  }
}

for (const { dmode, eMax, eMaxMode, portals, hasNetwork, wantPasses } of singleCases) {
  const nPortals = portals ? portalU.length : 0;
  const params = {
    h: H, w: W, dx: 30, dy: 30, cost, eMax, eMaxMode,
    densityMode: dmode, src: [SR, SC], wantPasses, hasNetwork, nPortals,
  };
  const json = new TextEncoder().encode(JSON.stringify(params));
  const head = new Uint8Array(4);
  new DataView(head.buffer).setUint32(0, json.length, true);
  const parts = [head, json, height, mask];
  if (hasNetwork) parts.push(netMask);
  if (portals) parts.push(portalU, portalV, portalLenM, portalHU, portalHV);
  const resp = await fetch(`http://${ADDR}/single`, { method: "POST", body: new Blob(parts) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
  const buf = await resp.arrayBuffer();
  const jlen = new DataView(buf).getUint32(0, true);
  let off = 4 + jlen;
  const energy = new Float32Array(buf.slice(off, off + 4 * N)); off += 4 * N;
  const passes = wantPasses ? new Float32Array(buf.slice(off, off + 4 * N)) : null;

  // JS reference — the worker's single-source branch (wantDensity false).
  const ref = runWorker({
    kind: "run", H, W, dx: 30, dy: 30, cost, eMax, eMaxMode,
    seedR: SR, seedC: SC, goalR: -1, goalC: -1, mode: dmode,
    wantPasses, wantDensity: false,
    height: new Float32Array(height), mask: new Uint8Array(mask),
    networkMask: hasNetwork ? new Uint8Array(netMask) : null,
    portalU: portals ? portalU : null,
    portalV: portals ? portalV : null,
    portalLenM: portals ? portalLenM : null,
    portalHU: portals ? portalHU : null,
    portalHV: portals ? portalHV : null,
  });

  let maxE = 0, bad = 0, maxP = 0;
  for (let i = 0; i < N; i++) {
    const a = energy[i], b = ref.energy[i];
    if (Number.isFinite(a) !== Number.isFinite(b)) bad++;
    else if (Number.isFinite(a)) maxE = Math.max(maxE, Math.abs(a - b));
    if (wantPasses) maxP = Math.max(maxP, Math.abs(passes[i] - ref.passes[i]));
  }
  const ok = maxE < 1e-3 && bad === 0 && (!wantPasses || maxP < 1e-15);
  allOk = allOk && ok;
  console.log(
    `[single] mode=${dmode} eMax=${eMax}${eMaxMode === "total" ? " (total)" : ""}` +
    `${portals ? " +portals" : ""}${hasNetwork ? " +net" : ""}${wantPasses ? " +passes" : ""}: ` +
    `max|Δenergy|=${maxE.toExponential(2)}, finite-mismatch=${bad}` +
    `${wantPasses ? `, max|Δpasses|=${maxP.toExponential(2)}` : ""} ${ok ? "✓" : "✗"}`,
  );
}

server.kill();
console.log(allOk ? "BACKEND MATCHES JS WORKER" : "MISMATCH");
process.exit(allOk ? 0 : 1);
