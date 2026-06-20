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

const cases = [];
for (const dmode of ["from", "to", "round"]) {
  for (const eMax of [0, 20000]) cases.push({ dmode, eMax, eMaxMode: "leg" });
}
cases.push({ dmode: "round", eMax: 20000, eMaxMode: "total" });
// Reverse-optimisation (maximize) density: the edge-inversion path +
// max_edge_cost derivation are identical in both engines but were never
// parity-checked, so a future divergence would slip past the suite.
cases.push({ dmode: "from", eMax: 0, eMaxMode: "leg", maximize: true });

for (const { dmode, eMax, eMaxMode, maximize = false } of cases) {
  {
    // backend
    const params = {
      h: H, w: W, dx: 30, dy: 30, alpha: 1, beta: 30, eta: 0.3, eMax, eMaxMode,
      densityMode: dmode, refPoints: refs, hasNetwork: false, maximize,
    };
    const json = new TextEncoder().encode(JSON.stringify(params));
    const head = new Uint8Array(4);
    new DataView(head.buffer).setUint32(0, json.length, true);
    const resp = await fetch(`http://${ADDR}/density`, {
      method: "POST",
      body: new Blob([head, json, height, mask]),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
    const buf = await resp.arrayBuffer();
    const jlen = new DataView(buf).getUint32(0, true);
    let off = 4 + jlen;
    const density = new Float64Array(buf.slice(off, off + 8 * N)); off += 8 * N;
    const energy = new Float32Array(buf.slice(off, off + 4 * N));

    // JS reference
    const ref = runWorker({
      kind: "run", H, W, dx: 30, dy: 30, alpha: 1, beta: 30, eta: 0.3, eMax, eMaxMode,
      seedR: -1, seedC: -1, goalR: -1, goalC: -1, mode: dmode,
      wantDensity: true, refPoints: refs, densityMode: dmode, maximize,
      height: new Float32Array(height), mask: new Uint8Array(mask),
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
      `mode=${dmode} eMax=${eMax}${eMaxMode === "total" ? " (total)" : ""}${maximize ? " (maximize)" : ""}: ` +
      `max|Δdensity|=${maxD.toExponential(2)}, ` +
      `max|Δenergy|=${maxE.toExponential(2)}, finite-mismatch=${bad} ${ok ? "✓" : "✗"}`,
    );
  }
}

server.kill();
console.log(allOk ? "BACKEND MATCHES JS WORKER" : "MISMATCH");
process.exit(allOk ? 0 : 1);
