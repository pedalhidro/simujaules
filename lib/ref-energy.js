// lib/ref-energy.js — the closed-form v2 leg-energy evaluator behind the
// reference-geometry readout (app.js refEnergyKJ, which reads readCost() and
// #deadband and calls refEnergyKJ below). Pure; shared by app.js and
// test-energy-v2.mjs.

// τ elevation deadband (hysteresis): the output follows h only once it moves
// more than τ away, lagging by τ. Rejects sub-τ jitter in h±. τ = 0 ⇒ identity.
export function deadband(h, TAU) {
  let y = h[0];
  const hS = new Float64Array(h.length); hS[0] = y;
  for (let i = 1; i < h.length; i++) {
    if (h[i] > y + TAU) y = h[i] - TAU; else if (h[i] < y - TAU) y = h[i] + TAU;
    hS[i] = y;
  }
  return hS;
}

// v2 leg energy (kJ) of a route from its {d, dh} segments: the closed form with
// a 2 m elevation deadband (rejects sub-τ jitter in h±) and the ε descent-
// recovery estimator — mirrors bicycling-energy-model compare.mjs
// approximate()+deadband() for the roll/aero/climb walk, and regime_compare.mjs
// epsGeom (journal Entry 18/WI-1) for ε itself. `c` is the deriveCost() bundle,
// whose coefficients are kJ-based, so the sum is in kJ. Aero is charged only OFF
// climbs; descent gets the drop-weighted ε. TAU is the deadband in metres
// (already clamped ≥ 0 by the app's #deadband read).
export function refEnergyKJ(segs, c, TAU = 2) {
  const n = segs.length;
  // Rebuild the elevation profile from the per-segment Δh and deadband it.
  const h = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) h[i + 1] = h[i] + segs[i].dh;
  const hS = deadband(h, TAU);
  let X = 0, Xnc = 0, hPlus = 0, hMinus = 0;
  for (let i = 0; i < n; i++) {
    const d = segs[i].d; if (!(d > 0)) continue;
    const dh = hS[i + 1] - hS[i];
    X += d;
    if (dh >= 0) { hPlus += dh; if (dh < c.climbThr * d) Xnc += d; }  // aero off climbs
    else { hMinus += -dh; Xnc += d; }                                // descents: full flat aero
  }
  // ε (descent-recovery factor): ports bicycling-energy-model regime_compare.mjs
  // epsGeom EXACTLY (journal Entry 18/WI-1) — every epsGeom call site in that
  // harness resamples the RAW (pre-deadband) profile, never the τ-smoothed one
  // the walk above uses, so this resamples `h`/cumulative distance, not `hS`.
  // Resample into 30 m cells (confirmed load-bearing by Entry 19 — do not
  // change the cell size), accumulate the drop-weighted
  // Σ drop_k·min(1, abRatio/(drop_k/30)) over descending cells, divide by the
  // total drop, THEN subtract epsOffset and clamp₀₁ ONCE on that aggregate
  // (never per-cell — clamping per-cell is what the old lumped-mean-grade s̄ =
  // H₋/X₋ estimator effectively approximated, and it collapses under mixed
  // grades / fine resolution; see Entry 18/19).
  const xCum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) xCum[i + 1] = xCum[i] + segs[i].d;
  const totalM = xCum[n], DX = 30, nc = Math.floor(totalM / DX);
  let eps = 0;
  if (nc >= 2) {
    let j = 0;
    const hAt = (d) => {
      while (j < n - 1 && xCum[j + 1] < d) j++;
      const seg = xCum[j + 1] - xCum[j], f = seg > 1e-9 ? (d - xCum[j]) / seg : 0;
      return h[j] * (1 - f) + h[j + 1] * f;
    };
    const cellH = new Float64Array(nc + 1);
    for (let k = 0; k <= nc; k++) cellH[k] = hAt(k * DX);
    let Hd = 0, epsW = 0;
    for (let k = 0; k < nc; k++) {
      const dh = cellH[k + 1] - cellH[k];
      if (dh < 0) { const drop = -dh; Hd += drop; epsW += drop * Math.min(1, c.abRatio / (drop / DX)); }
    }
    if (Hd >= 1) eps = Math.max(0, Math.min(1, epsW / Hd - c.epsOffset));
  }
  return c.aRoll * X + c.aAero * Xnc + c.beta * (hPlus - eps * hMinus);
}
