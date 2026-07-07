// test-dem-smoothing.mjs — the deployable DEM pre-smoothing transform + its tests.
//
// smoothHeightsInPlace() below is THE canonical implementation destined for
// app.js (v55, Entry-20 mitigation): sequential per-axis mask-normalized
// Gaussian (rows then columns), truncation 3σ, per-axis σ_px from the
// geotransform, in place, O(rows) temp memory. It must stay byte-identical to
// the copy pasted into app.js (same hand-kept-in-sync rule as the other test
// mirrors in this repo) and semantically identical to the Entry-20 python
// reference in bicycling-energy-model/data/activities/goal_calibration.mjs's
// Phase-A header — the σ* selected there is only valid for THIS transform.
//
// Scheme (pinned in the journal Entry-20 pre-registration amendment):
//   pass 1 (rows): for each valid cell, value' = Σ w_k·h[i±k]·m[i±k] / Σ w_k·m[i±k]
//     over the 1-D window k ∈ [0, R], R = ceil(3σ_px); invalid cells stay
//     untouched and never contribute.
//   pass 2 (columns): the same rule applied to pass 1's output, same mask.
// One rule handles interior, borders, and nodata holes alike.
//
// Run: node test-dem-smoothing.mjs

// ---------------------------------------------------------------------------
// The function (app.js-destined; keep in sync verbatim once integrated).
// Column pass streams row-major with a deferred-write ring buffer so the
// access pattern stays sequential on a 135 M-cell raster.
function smoothHeightsInPlace(height, mask, H, W, dxM, dyM, sigmaM) {
  if (!(sigmaM > 0)) return;
  const passes = [
    { sigPx: sigmaM / dxM, horizontal: true },
    { sigPx: sigmaM / dyM, horizontal: false },
  ];
  for (const p of passes) {
    const R = Math.ceil(3 * p.sigPx);
    if (!(R >= 1)) continue;
    const w = new Float64Array(R + 1);
    for (let k = 0; k <= R; k++) w[k] = Math.exp(-(k * k) / (2 * p.sigPx * p.sigPx));
    if (p.horizontal) {
      const buf = new Float64Array(W);
      for (let r = 0; r < H; r++) {
        const base = r * W;
        for (let c = 0; c < W; c++) {
          const idx = base + c;
          if (!mask[idx]) continue;
          let num = w[0] * height[idx], den = w[0];
          for (let k = 1; k <= R; k++) {
            const a = c - k, b = c + k;
            if (a >= 0 && mask[base + a]) { num += w[k] * height[base + a]; den += w[k]; }
            if (b < W && mask[base + b]) { num += w[k] * height[base + b]; den += w[k]; }
          }
          buf[c] = num / den;
        }
        for (let c = 0; c < W; c++) if (mask[base + c]) height[base + c] = buf[c];
      }
    } else {
      // Vertical pass, row-major streaming: for output row r, accumulate the
      // (2R+1) source rows r±k sequentially into num/den, then defer the
      // write by R rows via a ring buffer (source rows must stay unmodified
      // while they can still appear in a later output row's window).
      const num = new Float64Array(W), den = new Float64Array(W);
      const ring = []; // { row, vals: Float64Array }
      const flushRow = (entry) => {
        const base = entry.row * W;
        for (let c = 0; c < W; c++) if (mask[base + c]) height[base + c] = entry.vals[c];
      };
      for (let r = 0; r < H; r++) {
        num.fill(0); den.fill(0);
        const k0 = Math.max(0, r - R), k1 = Math.min(H - 1, r + R);
        for (let rr = k0; rr <= k1; rr++) {
          const wk = w[Math.abs(rr - r)], base = rr * W;
          for (let c = 0; c < W; c++) {
            if (mask[base + c]) { num[c] += wk * height[base + c]; den[c] += wk; }
          }
        }
        const vals = new Float64Array(W);
        const base = r * W;
        for (let c = 0; c < W; c++) vals[c] = mask[base + c] ? num[c] / den[c] : height[base + c];
        ring.push({ row: r, vals });
        // Flush rows whose window can no longer include any unwritten source row.
        while (ring.length && ring[0].row <= r - R) flushRow(ring.shift());
      }
      while (ring.length) flushRow(ring.shift());
    }
  }
}

// ---------------------------------------------------------------------------
// Test helpers
let pass = 0, fail = 0;
function ok(cond, msg, extra = "") {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${msg}${extra ? "  — " + extra : ""}`);
  cond ? pass++ : fail++;
}
function approx(a, b, tol = 1e-9) { return Math.abs(a - b) <= tol; }

// Brute-force reference of the SAME sequential-per-axis rule, written
// independently (full-array copies, no ring buffer, no streaming) so a bug in
// the optimized traversal can't hide in a shared code path.
function refSmooth(height, mask, H, W, dxM, dyM, sigmaM) {
  let h = Float64Array.from(height);
  const axes = [
    { sigPx: sigmaM / dxM, dr: 0, dc: 1 },
    { sigPx: sigmaM / dyM, dr: 1, dc: 0 },
  ];
  for (const ax of axes) {
    const R = Math.ceil(3 * ax.sigPx);
    if (!(R >= 1)) continue;
    const w = [];
    for (let k = 0; k <= R; k++) w.push(Math.exp(-(k * k) / (2 * ax.sigPx * ax.sigPx)));
    const out = Float64Array.from(h);
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
      const idx = r * W + c;
      if (!mask[idx]) continue;
      let num = 0, den = 0;
      for (let k = -R; k <= R; k++) {
        const rr = r + ax.dr * k, cc = c + ax.dc * k;
        if (rr < 0 || rr >= H || cc < 0 || cc >= W) continue;
        const j = rr * W + cc;
        if (mask[j]) { num += w[Math.abs(k)] * h[j]; den += w[Math.abs(k)]; }
      }
      out[idx] = num / den;
    }
    h = out;
  }
  return h;
}

// Seeded LCG for deterministic pseudo-random grids.
let seed = 123456789;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

// ---------------------------------------------------------------------------
console.log("dem pre-smoothing (Entry-20 deployable transform)");

// 1. Flat terrain is invariant (any mask-normalized average of a constant is the constant).
{
  const H = 12, W = 40, h = new Float32Array(H * W).fill(750), m = new Uint8Array(H * W).fill(1);
  smoothHeightsInPlace(h, m, H, W, 5, 5, 20);
  let maxDev = 0;
  for (const v of h) maxDev = Math.max(maxDev, Math.abs(v - 750));
  ok(maxDev < 1e-4, "flat terrain invariant under smoothing", `max dev ${maxDev.toExponential(2)}`);
}

// 2. 1-D spike attenuates by the analytic normalized-kernel factor w0/Σw.
{
  const W = 201, H = 1, sig = 10, dx = 5;
  const h = new Float32Array(W), m = new Uint8Array(W).fill(1);
  h[100] = 100;
  const sigPx = sig / dx, R = Math.ceil(3 * sigPx);
  let sum = 1;
  for (let k = 1; k <= R; k++) sum += 2 * Math.exp(-(k * k) / (2 * sigPx * sigPx));
  // Horizontal pass attenuates the spike; the vertical pass on a 1-row grid
  // has den = w0 alone (window leaves the grid) → identity. Expected: 100·w0/Σw.
  smoothHeightsInPlace(h, m, H, W, dx, dx, sig);
  ok(approx(h[100], 100 / sum, 1e-4), "spike attenuates by w0/Σw (row pass; 1-row col pass is identity)",
    `got ${h[100].toFixed(5)} want ${(100 / sum).toFixed(5)}`);
}

// 3. Nodata holes: invalid cells untouched, and they never contaminate neighbours
//    (a hole with value 0 next to a 750 m plateau must not drag the plateau down).
{
  const H = 20, W = 20, N = H * W;
  const h = new Float32Array(N).fill(750), m = new Uint8Array(N).fill(1);
  for (let r = 5; r < 10; r++) for (let c = 5; c < 10; c++) { const i = r * W + c; h[i] = 0; m[i] = 0; }
  smoothHeightsInPlace(h, m, H, W, 5, 5, 15);
  let okPlateau = true, okHole = true;
  for (let i = 0; i < N; i++) {
    if (m[i]) { if (Math.abs(h[i] - 750) > 1e-3) okPlateau = false; }
    else if (h[i] !== 0) okHole = false;
  }
  ok(okPlateau, "hole does not bleed into valid plateau (mask-normalized)");
  ok(okHole, "invalid cells stay untouched");
}

// 4. Border normalization: a uniform slope stays exactly linear in the
//    interior, and border cells stay finite/sane (one-sided windows renormalize).
{
  const H = 30, W = 30, N = H * W;
  const h = new Float32Array(N), m = new Uint8Array(N).fill(1);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) h[r * W + c] = 2 * c; // 2 m per 5 m cell
  const before = Float32Array.from(h);
  smoothHeightsInPlace(h, m, H, W, 5, 5, 15);
  const R = Math.ceil(3 * (15 / 5));
  let maxInterior = 0;
  for (let r = R; r < H - R; r++) for (let c = R; c < W - R; c++)
    maxInterior = Math.max(maxInterior, Math.abs(h[r * W + c] - before[r * W + c]));
  ok(maxInterior < 1e-3, "linear slope invariant in the interior (symmetric kernel)",
    `max dev ${maxInterior.toExponential(2)}`);
  let finite = true;
  for (const v of h) if (!Number.isFinite(v)) finite = false;
  ok(finite, "border cells finite under one-sided renormalization");
}

// 5. Optimized traversal ≡ independent brute-force reference on random terrain
//    with random holes (the load-bearing equivalence test).
{
  const H = 37, W = 53, N = H * W;
  const h = new Float32Array(N), m = new Uint8Array(N);
  for (let i = 0; i < N; i++) { h[i] = 700 + 120 * rnd(); m[i] = rnd() < 0.9 ? 1 : 0; }
  for (let i = 0; i < N; i++) if (!m[i]) h[i] = 0;
  const ref = refSmooth(h, m, H, W, 4.88, 5.32, 20);
  const got = Float32Array.from(h);
  smoothHeightsInPlace(got, m, H, W, 4.88, 5.32, 20);
  let maxD = 0;
  for (let i = 0; i < N; i++) if (m[i]) maxD = Math.max(maxD, Math.abs(got[i] - Math.fround(ref[i])));
  ok(maxD < 1e-3, "optimized in-place pass ≡ brute-force reference (random terrain + holes)",
    `max |Δ| ${maxD.toExponential(2)} m`);
}

// 6. Smoothing monotonically reduces h₊ along a rough profile (the mechanism
//    Entry 19/20 rely on).
{
  const H = 3, W = 400, N = H * W;
  const h = new Float32Array(N), m = new Uint8Array(N).fill(1);
  for (let c = 0; c < W; c++) {
    const v = 750 + 15 * Math.sin(c / 7) + 6 * Math.sin(c / 2.1) + 4 * rnd();
    for (let r = 0; r < H; r++) h[r * W + c] = v;
  }
  const hplus = (arr) => { let s = 0; for (let c = 1; c < W; c++) { const d = arr[W + c] - arr[W + c - 1]; if (d > 0) s += d; } return s; };
  const h0 = hplus(h);
  let prev = h0, mono = true;
  for (const sig of [10, 20, 30]) {
    const hh = Float32Array.from(h);
    smoothHeightsInPlace(hh, m, H, W, 5, 5, sig);
    const hp = hplus(hh);
    if (!(hp < prev)) mono = false;
    prev = hp;
  }
  ok(mono, `h₊ decreases monotonically with σ (raw ${h0.toFixed(0)} m → σ30 ${prev.toFixed(0)} m)`);
}

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILURE(S)`);
process.exit(fail ? 1 : 0);
