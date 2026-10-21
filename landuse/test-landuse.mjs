#!/usr/bin/env node
// Land-use simulation tests: the exact PNG codec (bake ↔ page), the
// hydrology primitives, the basin-area gate against the published UGRHI
// areas, and model invariants across both regions × both city modes.
// The data-dependent parts run only when landuse/data/ has been baked.
import { existsSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { encodePng, decodePng, priorityFloodD8, topoOrder, receiverOf } from "./lib.mjs";
import { decodePngAsync, prepare, simulate, USE, DEFAULTS } from "./model.js";

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
function ok(cond, msg, extra = "") {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${msg}${extra ? "  — " + extra : ""}`);
  cond ? pass++ : fail++;
}
let seed = 987654321;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

console.log("PNG codec (exact, every filter, 8/16-bit, 1–4 channels)");
for (const depth of [8, 16]) for (const nch of [1, 2, 3, 4]) {
  const W = 37, H = 23, max = depth === 16 ? 65535 : 255;
  const planes = Array.from({ length: nch }, (_, k) => {
    const a = depth === 16 ? new Uint16Array(W * H) : new Uint8Array(W * H);
    // mix smooth ramps (Sub/Up/Avg/Paeth win) with noise (None wins)
    for (let i = 0; i < a.length; i++) a[i] = (i % 3 === 0 ? Math.floor(rnd() * (max + 1)) : (i * (k + 3)) % (max + 1));
    return a;
  });
  const png = encodePng(planes, W, H, depth);
  const sync = decodePng(png);
  const asyncD = await decodePngAsync(png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength));
  const same = (d) => d.W === W && d.H === H && d.planes.length === nch && d.planes.every((p, k) => p.every((v, i) => v === planes[k][i]));
  ok(same(sync) && same(asyncD), `${depth}-bit × ${nch} channel(s) round-trips (lib.decodePng and the page's decodePngAsync)`);
}

console.log("priority-flood + D8 on a synthetic DEM with pits and flats");
{
  const W = 60, H = 40, N = W * H;
  const elev = new Float32Array(N), valid = new Uint8Array(N).fill(1);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    const bowl = Math.hypot(r - 20, c - 30) * 2;                     // rises outward…
    elev[r * W + c] = 100 - bowl + 10 * Math.sin(c / 4) + (rnd() < 0.05 ? -15 : 0);  // …so the middle is a big pit
  }
  for (let r = 10; r < 15; r++) for (let c = 10; c < 20; c++) elev[r * W + c] = 90;   // a flat
  valid[5 * W + 5] = 0;                                             // a nodata hole (an inner outlet)
  const dx = new Float64Array(H).fill(30);
  const { filled, dir } = priorityFloodD8(elev, valid, W, H, dx, 30);
  const order = topoOrder(dir, valid, W, H);
  let nValid = 0; for (let i = 0; i < N; i++) nValid += valid[i];
  ok(order.length === nValid, "every valid cell is in the topological order (no cycles)", `${order.length}/${nValid}`);
  let strictly = true;
  for (let i = 0; i < N; i++) { const j = receiverOf(i, dir, W); if (j >= 0 && !(filled[j] < filled[i])) strictly = false; }
  ok(strictly, "every receiver is strictly lower on the filled surface");
  const acc = new Float64Array(N);
  for (const i of order) acc[i] += 1;
  for (const i of order) { const j = receiverOf(i, dir, W); if (j >= 0) acc[j] += acc[i]; }
  let atOutlets = 0;
  for (let i = 0; i < N; i++) if (valid[i] && receiverOf(i, dir, W) < 0) atOutlets += acc[i];
  ok(atOutlets === nValid, "all area reaches an outlet (edge or nodata)", `${atOutlets}`);
}

const DATA = join(here, "data");
if (!existsSync(join(DATA, "meta.json"))) {
  console.log("\n(no landuse/data/ — run `node bake.mjs all` to bake it; skipping the data tests)");
} else {
  const meta = JSON.parse(readFileSync(join(DATA, "meta.json"), "utf8"));
  console.log("basin gate (DEM-traced vs published UGRHI areas, ±5 %)");
  for (const b of [1, 2]) {
    const got = meta.basins[b].areaKm2, want = meta.published[b].areaKm2;
    ok(Math.abs(got - want) / want <= 0.05, `${meta.published[b].name}: ${got} km² vs ${want}`, `${(100 * (got - want) / want).toFixed(1)} %`);
  }
  ok(meta.basins[1].pop > 19e6 && meta.basins[1].pop < 22e6, "Alto Tietê population is the RMSP order of magnitude", `${(meta.basins[1].pop / 1e6).toFixed(2)} M`);
  const files = {};
  for (const f of meta.files) { const b = readFileSync(join(DATA, f)); files[f] = await decodePngAsync(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); }
  const ctx = prepare(meta, files);
  let nValid = 0; for (let o = 0; o < ctx.N; o++) if (ctx.elev[o]) nValid++;
  ok(ctx.topo.length === nValid, "baked D8 is acyclic over every valid cell", `${ctx.topo.length}/${nValid}`);
  console.log("model invariants");
  for (const scenario of ["AT", "ATPV"]) for (const cityMode of ["compact", "redesign"]) {
    const params = { scenario, cityMode, compaction: cityMode === "compact" ? 0.2 : 0 };
    const r = simulate(ctx, params), s = r.stats, tag = `${scenario}/${cityMode}`;
    let outside = 0, area = 0, used = 0;
    for (let o = 0; o < ctx.N; o++) {
      const inSc = ctx.basin[o] === 1 || (scenario === "ATPV" && ctx.basin[o] === 2);
      if (!inSc && r.use[o] !== USE.NONE) outside++;
      if (inSc) { area += ctx.area[o]; if (r.use[o] !== USE.NONE) used++; }
    }
    ok(outside === 0, `${tag}: nothing allocated outside the scenario`);
    const byUseTotal = s.byUse.reduce((t, x) => t + (x[1] || 0) + (x[2] || 0), 0);
    ok(Math.abs(byUseTotal - area) < 1e-6 * area + 1e-6, `${tag}: land-use table sums to the scenario area`, `${byUseTotal.toFixed(0)} km²`);
    if (cityMode === "redesign") ok(Math.abs(s.cityPop - s.P) / s.P < 1e-6, `${tag}: everyone lives in the new city`, `${(s.cityPop / 1e6).toFixed(2)} M`);
    else ok(s.cityPop <= s.P * (1 + 1e-9), `${tag}: city population ≤ scenario population`);
    ok(s.food.share >= 0 && s.food.share <= 1, `${tag}: calorie share in [0, 1]`, `${Math.round(s.food.share * 100)} %`);
    ok(s.food.vegShare > 0.99, `${tag}: vegetables close`);
    ok(!s.energy.closes || s.energy.groundTWh >= s.energy.gapTWh * 0.999, `${tag}: energy 'closes' only when ground solar covers the gap`);
    ok(s.sewage.plants > 0 && s.sewage.served <= s.cityPop * (1 + 1e-9), `${tag}: plants serve at most the sewered city`, `${s.sewage.plants} plants`);
    const r2 = simulate(ctx, params);
    ok(r2.use.every((v, i) => v === r.use[i]) && r2.stats.food.stapleKm2 === s.food.stapleKm2, `${tag}: deterministic`);
  }
  {
    const a = simulate(ctx, { scenario: "AT" }).stats, b = simulate(ctx, { scenario: "ATPV" }).stats;
    ok(b.food.share > a.food.share, "adding the Paraíba Valley raises the calorie share", `${Math.round(a.food.share * 100)} % → ${Math.round(b.food.share * 100)} %`);
    const c = simulate(ctx, { scenario: "AT", cityMode: "compact", compaction: 0.3 }).stats;
    ok(c.energy.roofTWh < a.energy.roofTWh, "compacting the city cuts rooftop solar (less roof)", `${a.energy.roofTWh.toFixed(1)} → ${c.energy.roofTWh.toFixed(1)} TWh`);
    const d = simulate(ctx, { scenario: "AT", cropEff: DEFAULTS.cropEff * 2 }).stats;
    ok(d.food.needKm2 < a.food.needKm2 * 0.51, "doubling crop efficiency halves the field area needed");
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
