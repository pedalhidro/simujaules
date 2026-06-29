// test-energy-v2.mjs — locks the v2 leg-energy closed form (the route evaluator
// behind refEnergyKJ in app.js) and the ε descent-recovery estimator to the
// canonical model in bicycling-energy-model/notas.md (v2) + compare.mjs.
// Run: node test-energy-v2.mjs
//
// These are PURE MIRRORS of app.js's readCost()/refEnergyKJ() math (same
// hand-kept-in-sync rule as test-water-raster.mjs / census mirrors — app.js is a
// browser module and can't be imported here). Keep them in step with app.js.

let failures = 0;
const approx = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
function ok(name, cond, extra = "") { console.log(`${cond ? "  ok  " : "FAIL  "}${name}${extra ? "  — " + extra : ""}`); if (!cond) failures++; }

const G = 9.81;

// ── mirror of app.js flatEqSpeed() + readCost() (physics → kJ cost bundle) ────
function flatEqSpeed(P, m, crr, cda, rho, keff) {
  const a = crr * m * G, b = 0.5 * rho * cda;
  let lo = 0, hi = 40;
  for (let k = 0; k < 60; k++) {
    const v = (lo + hi) / 2;
    const wheel = (a + b * v * v) * v;
    if (wheel < keff * P) lo = v; else hi = v;
  }
  return (lo + hi) / 2;
}
function deriveCost({ mass, crr, cda, rho, keff, pFlat, climbThrPct, kSmooth = 1 }) {
  const vf = flatEqSpeed(pFlat, mass, crr, cda, rho, keff), mg = mass * G, KJ = 1000;
  const aeroCoef = 0.5 * rho * cda * vf * vf;
  return {
    aRoll: mg * crr / keff / KJ,
    aAero: aeroCoef / keff / KJ,
    beta: mg * kSmooth / keff / KJ,   // k_smooth multiplies the gravity term
    climbThr: climbThrPct / 100,
    abRatio: crr + aeroCoef / mg,     // un-smoothed (independent of kSmooth)
    epsOffset: 0.13,
  };
}

// ── mirror of the deadband + closed-form evaluator (refEnergyKJ) ──────────────
function deadband(h, tau) {
  const out = new Float64Array(h.length);
  let y = h[0]; out[0] = y;
  for (let i = 1; i < h.length; i++) {
    if (h[i] > y + tau) y = h[i] - tau; else if (h[i] < y - tau) y = h[i] + tau;
    out[i] = y;
  }
  return out;
}
function epsEstimate(c, sbar) {
  if (!(sbar > 0)) return 0;
  let eps = Math.min(1, c.abRatio / sbar) - c.epsOffset;
  return eps < 0 ? 0 : eps > 1 ? 1 : eps;
}
// segs: [{ d, dh }]. Returns leg energy in kJ (coefficients are kJ-based).
function refEnergyKJ(segs, c, tau = 2) {
  const n = segs.length;
  const h = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) h[i + 1] = h[i] + segs[i].dh;
  const hS = deadband(h, tau);
  let X = 0, Xnc = 0, hPlus = 0, hMinus = 0, Xdesc = 0;
  for (let i = 0; i < n; i++) {
    const d = segs[i].d; if (!(d > 0)) continue;
    const dh = hS[i + 1] - hS[i];
    X += d;
    if (dh >= 0) { hPlus += dh; if (dh < c.climbThr * d) Xnc += d; }
    else { hMinus += -dh; Xnc += d; Xdesc += d; }
  }
  const sbar = Xdesc > 0 ? hMinus / Xdesc : 0;
  const eps = epsEstimate(c, sbar);
  return c.aRoll * X + c.aAero * Xnc + c.beta * (hPlus - eps * hMinus);
}

// ── 1. ε estimator — the notas.md worked example (RMC200 Mogi) ────────────────
{
  // α/β = 0.0202, s̄ = 3.4% ⇒ min(1, 0.0202/0.034) − 0.13 = 0.464 (measured 0.47).
  const c = { abRatio: 0.0202, epsOffset: 0.13 };
  const eps = epsEstimate(c, 0.034);
  ok("ε(RMC200) ≈ 0.46", approx(eps, 0.464, 2e-3), `got ${eps.toFixed(4)}`);
  // Clamp at 1 then minus offset on a gentle descent below the flat-resistance grade.
  ok("ε gentle descent clamps to 1−offset", approx(epsEstimate(c, 0.005), 0.87, 1e-9), `got ${epsEstimate(c, 0.005)}`);
  // Very steep ⇒ little recovery, then floors at 0.
  ok("ε steep descent floors at 0", epsEstimate(c, 1.0) === 0, `got ${epsEstimate(c, 1.0)}`);
}

// ── 2. 2 m deadband rejects sub-τ jitter, keeps real climbs ───────────────────
{
  // ±1 m wiggle around a flat line → 0 net ascent after a 2 m deadband.
  const h = [0, 1, 0, 1, 0, 1, 0];
  const hS = deadband(h, 2);
  let gain = 0; for (let i = 1; i < hS.length; i++) { const d = hS[i] - hS[i - 1]; if (d > 0) gain += d; }
  ok("deadband removes ±1 m jitter (0 gain)", approx(gain, 0), `got ${gain}`);
  // A real 50 m climb survives (lagging by τ): net rise 50−2 = 48.
  const h2 = deadband([0, 50], 2);
  ok("deadband keeps a 50 m climb (−τ lag)", approx(h2[1] - h2[0], 48), `got ${h2[1] - h2[0]}`);
}

// ── 3. closed form: rolling everywhere, aero OFF climbs, gravity ± recovery ───
{
  const c = { aRoll: 0.5, aAero: 0.5, beta: 10, climbThr: 0.05, abRatio: 0.1, epsOffset: 0.13 };
  // 1000 m flat, then 100 m at +20 m (grade 0.2 ≥ climbThr ⇒ no aero), then
  // 100 m at −20 m (grade 0.2 descent). Profile differences exceed the 2 m
  // deadband, so smoothing leaves h± intact (lagging endpoints cancel in Δ).
  const segs = [
    { d: 1000, dh: 0 },     // flat
    { d: 100, dh: 20 },     // climb (no aero)
    { d: 100, dh: -20 },    // descent (full flat aero + ε recovery)
  ];
  // Hand derivation on the deadbanded profile. Cumulative h=[0,0,20,0]; deadband
  // τ=2 LAGS each move by τ → hS=[0,0,18,2], so Δ=[0,+18,−16]: X=1200,
  // Xnc=1000(flat)+100(desc)=1100, hPlus=18, hMinus=16, s̄=16/100=0.16.
  const eps = Math.min(1, c.abRatio / (16 / 100)) - c.epsOffset;
  const want = c.aRoll * 1200 + c.aAero * 1100 + c.beta * (18 - eps * 16);
  ok("closed form matches hand derivation", approx(refEnergyKJ(segs, c), want), `got ${refEnergyKJ(segs, c)} want ${want}`);

  // Aero is charged OFF climbs only: a pure climb pays no aero, a flat of equal
  // distance does — so the flat costs aAero·d more on the distance term. (Use
  // the deadbanded climb height so the gravity term cancels exactly.)
  const flat = refEnergyKJ([{ d: 100, dh: 0 }], c);
  const climb = refEnergyKJ([{ d: 100, dh: 20 }], c); // grade 0.2 ≥ climbThr
  const cd = deadband([0, 20], 2); const hp = cd[1] - cd[0]; // smoothed climb = 18
  ok("aero charged off climbs only",
    approx((climb - c.beta * hp) - flat, -c.aAero * 100),
    `climb−grav=${(climb - c.beta * hp).toFixed(4)} flat=${flat.toFixed(4)}`);
}

// ── 4. readCost() sanity: physics → kJ coefficients in a believable range ─────
{
  const c = deriveCost({ mass: 75, crr: 0.008, cda: 0.45, rho: 1.1, keff: 0.97, pFlat: 80, climbThrPct: 2 });
  // beta = m·g·k_smooth/k_eff in kJ/m ≈ 75·9.81/0.97/1000 ≈ 0.759 at k_smooth=1.
  ok("beta ≈ m·g/keff (kJ/m)", approx(c.beta, 75 * G / 0.97 / 1000, 1e-9), `got ${c.beta.toFixed(4)}`);
  // abRatio (flat-resistance grade) lands in a sane 1–3% band for road cycling.
  ok("abRatio in 1–3% band", c.abRatio > 0.01 && c.abRatio < 0.03, `got ${c.abRatio.toFixed(4)}`);
  ok("climbThr = 2%", approx(c.climbThr, 0.02), `got ${c.climbThr}`);
  // k_smooth scales beta (the gravity term) but NOT abRatio (the ε grade).
  const cs = deriveCost({ mass: 75, crr: 0.008, cda: 0.45, rho: 1.1, keff: 0.97, pFlat: 80, climbThrPct: 2, kSmooth: 0.74 });
  ok("k_smooth scales beta", approx(cs.beta, 0.74 * c.beta, 1e-12), `got ${cs.beta.toFixed(4)}`);
  ok("k_smooth leaves abRatio", approx(cs.abRatio, c.abRatio, 1e-12), `got ${cs.abRatio.toFixed(4)}`);
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
