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

// Network masks for the hasNetwork cases (eff_mask = dem_mask AND network_mask
// in both engines). The diagonal band includes the refs/seed.
const netMask = new Uint8Array(N);
for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) netMask[r * W + c] = Math.abs(r - c) < 90 ? 1 : 0;
// A network that EXCLUDES the DEM's height extremes (only the middle 70% of the
// height range, refs forced back in). The JS worker derives maximize's
// maxEdgeCost from the RAW DEM mask BEFORE effMask exists — a backend scanning
// the effective mask instead inverts against a smaller range and diverges
// wholesale, which is exactly what the maximize+net case below must catch.
let rawMinH = Infinity, rawMaxH = -Infinity;
for (let i = 0; i < N; i++) if (mask[i]) { rawMinH = Math.min(rawMinH, height[i]); rawMaxH = Math.max(rawMaxH, height[i]); }
const netMaskInner = new Uint8Array(N);
for (let i = 0; i < N; i++) {
  const f = (height[i] - rawMinH) / (rawMaxH - rawMinH);
  netMaskInner[i] = f > 0.15 && f < 0.85 ? 1 : 0;
}
for (const [r, c] of refs) netMaskInner[r * W + c] = 1; // keep every ref on the eff mask
{ // guard: vacuous test if the network doesn't actually trim the height range
  let m = Infinity, M = -Infinity;
  for (let i = 0; i < N; i++) if (mask[i] && netMaskInner[i]) { m = Math.min(m, height[i]); M = Math.max(M, height[i]); }
  if (m <= rawMinH || M >= rawMaxH) throw new Error("netMaskInner failed to trim the height range");
}

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
// Network-constrained density (the backend parses a second mask off the wire):
// every mode, plus the total-budget and portal combinations.
for (const dmode of ["from", "to", "round"]) cases.push({ dmode, eMax: 20000, eMaxMode: "leg", network: netMask });
cases.push({ dmode: "round", eMax: 20000, eMaxMode: "total", network: netMask });
cases.push({ dmode: "from", eMax: 20000, eMaxMode: "leg", portals: true, network: netMask });
// maximize + network, with the height extremes excluded from the network —
// catches a backend deriving the maximize height range from the effective
// (network-ANDed) mask instead of the raw DEM mask.
cases.push({ dmode: "from", eMax: 0, eMaxMode: "leg", maximize: true, network: netMaskInner });
// +matrix index-shift regression: an extra ref on the masked cell 0 — the
// backend filters refs into a compacted list, so a matrix keyed by the
// compacted index (instead of the ORIGINAL one) would shift every row after
// the dropped ref. Both engines must return an all-Infinity row at its
// original index. One case per mode (round exercises the two-leg sampling).
for (const dmode of ["from", "to", "round"]) {
  cases.push({ dmode, eMax: 20000, eMaxMode: "leg", droppedRef: true });
}

// Every density case also requests the accessibility matrix (wantMatrix):
// matrix entries are raw per-ref f32 energy samples — no cross-slice f64
// accumulation — so unlike the mean-energy field they are BIT-parity
// (maxΔ === 0) regardless of how either engine slices the refs. Under
// maximize both engines must omit the matrix entirely.
for (const { dmode, eMax, eMaxMode, portals = false, maximize = false, network = null, droppedRef = false } of cases) {
  {
    const caseRefs = droppedRef ? [...refs, [0, 0]] : refs;
    const K = caseRefs.length;
    const nPortals = portals ? portalU.length : 0;
    // backend
    const params = {
      h: H, w: W, dx: 30, dy: 30, cost, eMax, eMaxMode,
      densityMode: dmode, refPoints: caseRefs, hasNetwork: !!network, maximize,
      nPortals, wantMatrix: true,
    };
    const json = new TextEncoder().encode(JSON.stringify(params));
    const head = new Uint8Array(4);
    new DataView(head.buffer).setUint32(0, json.length, true);
    const parts = [head, json, height, mask];
    if (network) parts.push(network);
    if (portals) parts.push(portalU, portalV, portalLenM, portalHU, portalHV);
    const resp = await fetch(`http://${ADDR}/density`, { method: "POST", body: new Blob(parts) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
    const buf = await resp.arrayBuffer();
    const jlen = new DataView(buf).getUint32(0, true);
    // Meta JSON (padded with trailing spaces — legal JSON whitespace);
    // "matrix":K announces the appended f32×K² block.
    const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, jlen)));
    const mk = meta.matrix | 0;
    const expect = 4 + jlen + 8 * N + 4 * N + 4 * mk * mk;
    if (buf.byteLength !== expect) throw new Error(`/density response ${buf.byteLength} B, expected ${expect} B`);
    let off = 4 + jlen;
    const density = new Float64Array(buf.slice(off, off + 8 * N)); off += 8 * N;
    const energy = new Float32Array(buf.slice(off, off + 4 * N)); off += 4 * N;
    const matrix = mk > 0 ? new Float32Array(buf.slice(off, off + 4 * mk * mk)) : null;

    // JS reference
    const ref = runWorker({
      kind: "run", H, W, dx: 30, dy: 30, cost, eMax, eMaxMode,
      seedR: -1, seedC: -1, goalR: -1, goalC: -1, mode: dmode,
      wantDensity: true, refPoints: caseRefs, densityMode: dmode, maximize,
      wantMatrix: true,
      matrixCells: Int32Array.from(caseRefs, ([r, c]) => r * W + c),
      height: new Float32Array(height), mask: new Uint8Array(mask),
      networkMask: network ? new Uint8Array(network) : null,
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
    // Matrix parity: under maximize BOTH engines must omit it; otherwise
    // bit-identical entries with an identical finite pattern.
    let matOk, maxM = 0, badM = 0;
    if (maximize) {
      matOk = mk === 0 && matrix === null && ref.matrix == null;
    } else {
      matOk = mk === K && matrix !== null && ref.matrix instanceof Float32Array && ref.matrix.length === K * K;
      if (matOk) {
        for (let i = 0; i < K * K; i++) {
          const a = matrix[i], b = ref.matrix[i];
          if (Number.isFinite(a) !== Number.isFinite(b)) badM++;
          else if (Number.isFinite(a)) maxM = Math.max(maxM, Math.abs(a - b));
        }
        matOk = maxM === 0 && badM === 0;
        if (droppedRef) {
          // The dropped ref's row must sit at its ORIGINAL index, all-Infinity.
          for (let j = 0; j < K; j++) if (matrix[(K - 1) * K + j] !== Infinity) matOk = false;
        }
      }
    }
    const ok = maxD < 1e-15 && maxE < 1e-3 && bad === 0 && matOk;
    allOk = allOk && ok;
    console.log(
      `mode=${dmode} eMax=${eMax}${eMaxMode === "total" ? " (total)" : ""}${portals ? " +portals" : ""}${network ? " +net" : ""}${maximize ? " (maximize)" : ""}${droppedRef ? " +droppedRef" : ""} +matrix: ` +
      `max|Δdensity|=${maxD.toExponential(2)}, ` +
      `max|Δenergy|=${maxE.toExponential(2)}, finite-mismatch=${bad}, ` +
      (maximize ? `matrix-omitted=${matOk}` : `max|Δmatrix|=${maxM.toExponential(2)}, matrix-finite-mismatch=${badM}`) +
      ` ${ok ? "✓" : "✗"}`,
    );
  }
}

// ---- /single single-source parity (energy field + optional passes) ----
// The non-density fast path: one Dijkstra (two for round) from a single source,
// returning the RAW energy field (not averaged) + optional passes counts. Mirror
// the JS worker's from/to/round single-point branch. Cover network-constrained
// (the eff_mask = dem_mask AND network_mask path) and bridge portals too.
const SR = 128, SC = 128; // seed — inside the diagonal netMask band above

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
  // Wire-format guard: /single passes ship as f64 (the JS worker's
  // single-source branch returns Float64Array — counts exceed 2^24 on big
  // DEMs, where f32 would round), so the decoded values below compare EXACTLY
  // against the JS reference. A backend regressing to f32 fails right here.
  const expect = 4 + jlen + 4 * N + (wantPasses ? 8 * N : 0);
  if (buf.byteLength !== expect) throw new Error(`/single response ${buf.byteLength} B, expected ${expect} B`);
  let off = 4 + jlen;
  const energy = new Float32Array(buf.slice(off, off + 4 * N)); off += 4 * N;
  const passes = wantPasses ? new Float64Array(buf.slice(off, off + 8 * N)) : null;

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

// /single rejects maximize (browser-only by design — the app never sends it,
// so a 400 beats silently computing a degenerate max_edge_cost=0 field).
{
  const params = {
    h: H, w: W, dx: 30, dy: 30, cost, eMax: 0, eMaxMode: "leg",
    densityMode: "from", src: [SR, SC], wantPasses: false, hasNetwork: false,
    maximize: true, nPortals: 0,
  };
  const json = new TextEncoder().encode(JSON.stringify(params));
  const head = new Uint8Array(4);
  new DataView(head.buffer).setUint32(0, json.length, true);
  const resp = await fetch(`http://${ADDR}/single`, {
    method: "POST", body: new Blob([head, json, height, mask]),
  });
  const ok = resp.status === 400;
  allOk = allOk && ok;
  console.log(`[single] maximize=true → HTTP ${resp.status} (expect 400) ${ok ? "✓" : "✗"}`);
}

server.kill();
console.log(allOk ? "BACKEND MATCHES JS WORKER" : "MISMATCH");
process.exit(allOk ? 0 : 1);
