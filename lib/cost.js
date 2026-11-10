// lib/cost.js — the v2 leg-energy cost bundle (physics inputs → kJ-based
// coefficients) and the local gravity constant. Pure ES module: no DOM, no app
// state. The ONE definition shared by app.js (readCost reads the inputs and
// calls deriveCost), census/census-density.mjs, mcp/lib.mjs and
// test-energy-v2.mjs.

// ── v2 leg-energy cost bundle ────────────────────────────────────────────────
// The compute engines (energy-worker.js v2Edge, graph-engine.js stepCost, the
// Rust backend v2_edge) are parameterised by this bundle, derived ONCE here from
// the physics inputs and shipped identically to all three so they stay
// bit-parity. See bicycling-energy-model/notas.md (v2). Coefficients are in
// kJ-based units (energy field / budget / legend stay kJ, as before α/β/η).
// epsOffset is the empirical −0.13 descent-recovery offset (a constant, not a
// UI knob) — originally fit on 44 rides, now cross-validated on 3 independent
// riders + the author's full export (bicycling-energy-model journal Entries
// 12/14/16). abRatio = crr + aeroCoef/mg is the dimensionless flat-resistance
// grade (= α/β) used by the per-grade descent recovery ε — deliberately
// UN-smoothed (it equals (aRoll+aAero)/beta only when kSmooth = 1; ε is a
// grade-geometry factor, not an energy one, so it must not scale with k_smooth).
// Flat reference speed v_f (m/s) from the rider's power on the flat: solve the
// steady wheel-power balance keff·P = (Crr·m·g + ½ρCdA·v²)·v by bisection.
// Mirrors bicycling-energy-model compare.mjs flatEqSpeed (wind = 0).
//
// GRAVITY — local, not textbook. 9.7864 m/s² is São Paulo's value from IAG-USP
// absolute gravimetry; 9.81 (the old constant) is ~0.24% high here. Every DEM
// this app ships and every ride the model was calibrated on sits in the SP
// metropolitan region, so the local value is the physical one. Re-baselined in
// v63 to re-sync with bicycling-energy-model (journal Entry 27), which moved
// first: while the two disagreed, the sibling applet's v2Edge readout differed
// from this app's by exactly the gravity ratio. Consequence: β (and every
// energy) falls by ≈0.24%.
// DEFINED ONLY HERE: app.js, census/, mcp/, test-energy-v2.mjs and the
// docs/grid-*.mjs harnesses import it (the docs harnesses still carry their own
// dated copies of flatEqSpeed/deriveCost, now reading this G_SP).
// The Rust backend needs NO copy: it receives the derived {aRoll, aAero, beta,
// abRatio, …} bundle over the wire, so JS↔Rust bit-parity is gravity-blind.
export const G_SP = 9.7864;
export function flatEqSpeed(P, m, crr, cda, rho, keff) {
  const a = crr * m * G_SP, b = 0.5 * rho * cda;
  let lo = 0, hi = 40;
  for (let k = 0; k < 60; k++) {
    const v = (lo + hi) / 2;
    const wheel = (a + b * v * v) * v;
    if (wheel < keff * P) lo = v; else hi = v;
  }
  return (lo + hi) / 2;
}
// p = { mass, crr, cda, rho, keff, pFlat, climbThrPct, kSmooth } (numbers; a
// missing or non-finite field takes the app's UI default). Clamps and defaults
// are the app's readCost() ones — readCost is now just the DOM read feeding this.
export function deriveCost(p = {}) {
  const num = (v, dflt) => (Number.isFinite(v) ? v : dflt);
  const m    = Math.max(1, num(p.mass, 75));
  const crr  = Math.max(0, num(p.crr, 0.008));
  const cda  = Math.max(0, num(p.cda, 0.45));
  const rho  = Math.max(0, num(p.rho, 1.1));    // ~750 m asl (São Paulo)
  const keff = Math.min(1, Math.max(0.1, num(p.keff, 0.97)));
  const pFlat = Math.max(1, num(p.pFlat, 80));  // W — rider power on the flat
  const vf   = flatEqSpeed(pFlat, m, crr, cda, rho, keff);  // m/s, derived
  const climbThr = Math.max(0, num(p.climbThrPct, 2)) / 100;  // % → grade
  // k_smooth: profile-smoothing factor (notas v2). 1 = no smoothing (the per-edge
  // engine pays roller momentum implicitly; the notas' ≈0.74 is the FABDEM value
  // for the LOW-COMPUTE closed form). Multiplies the gravity term (climb + the
  // descent credit); ε stays computed from the UN-smoothed abRatio.
  const kSmooth = Math.min(1, Math.max(0, num(p.kSmooth, 1)));
  const g = G_SP, mg = m * g, KJ = 1000;   // local SP gravity — see G_SP above
  const aeroCoef = 0.5 * rho * cda * vf * vf;               // ½ρCdA·v_f² (J/ground-m, pre-/keff)
  return {
    aRoll: mg * crr / keff / KJ,
    aAero: aeroCoef / keff / KJ,
    beta: mg * kSmooth / keff / KJ,
    climbThr,
    abRatio: crr + aeroCoef / mg,   // un-smoothed flat-resistance grade (for ε); k_eff & kJ scale cancel
    epsOffset: 0.13,
  };
}
