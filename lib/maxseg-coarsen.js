// lib/maxseg-coarsen.js — block-mean coarsening of a field for the max-cost
// segment search (3D). Pure; shared by app.js and test-maxseg.mjs.

// Block-mean coarsening: coarse cell = mean of its allowed, finite fine cells;
// allowed iff ≥ 1 such cell.
export function coarsenFieldForMaxseg(field, mask, H, W, f) {
  const Hc = Math.ceil(H / f), Wc = Math.ceil(W / f);
  const sum = new Float64Array(Hc * Wc);
  const cnt = new Int32Array(Hc * Wc);
  for (let r = 0; r < H; r++) {
    const rowBase = r * W;
    const cBase = ((r / f) | 0) * Wc;
    for (let c = 0; c < W; c++) {
      if (!mask[rowBase + c]) continue;
      const v = field[rowBase + c];
      if (!Number.isFinite(v)) continue;
      const ci = cBase + ((c / f) | 0);
      sum[ci] += v;
      cnt[ci]++;
    }
  }
  const density = new Float32Array(Hc * Wc);
  const allowed = new Uint8Array(Hc * Wc);
  for (let i = 0; i < Hc * Wc; i++) {
    if (cnt[i] > 0) { density[i] = sum[i] / cnt[i]; allowed[i] = 1; }
  }
  return { density, allowed, Hc, Wc };
}
