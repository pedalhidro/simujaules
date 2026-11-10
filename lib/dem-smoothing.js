// lib/dem-smoothing.js — the app's static DEM pre-smoothing transform.
// Pure ES module shared by app.js (DEM load), test-dem-smoothing.mjs and
// mcp/lib.mjs; no DOM, no app state. Moved verbatim out of app.js.

// Static DEM pre-smoothing (v55, journal Entry 20's validated mitigation for the
// Entry-19 fine-DEM over-charge): sequential per-axis mask-normalized Gaussian
// (rows then columns), truncation 3σ, per-axis σ_px from the geotransform, in
// place, O(rows) temp memory (~10 s at 135 M cells). Runs app-side at DEM load
// only — heights then ship identically to the JS worker, graph engine and Rust
// backend, so there are NO engine/parity implications. test-dem-smoothing.mjs
// imports this function and checks it against an independent brute-force
// reference; the Entry-20 harness (goal_calibration.mjs Phase A)
// validated this exact scheme, so σ choices are only meaningful for THIS
// transform — don't swap in a plain gaussian blur.
export function smoothHeightsInPlace(height, mask, H, W, dxM, dyM, sigmaM) {
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
