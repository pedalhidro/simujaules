// Standalone test harness — runs the worker's Dijkstra against testdem.tif.
// Prints settled-cell counts and timings for forward and reverse modes,
// and inspects a vertical-strip slice through the seed to see how far the
// finite-energy region extends.
const fs = require("fs");
const H = 568, W = 975, N = H * W;
const buf = fs.readFileSync("/tmp/dem.bin");
const height = new Float32Array(buf.buffer, buf.byteOffset, N);
const mask = new Uint8Array(N).fill(1);
const dxM = 4.887778601902139, dyM = 5.295618378919024;
const alpha = 0.008, beta = 1, eta = 0.1;

function run(reverse) {
  const diag = Math.hypot(dxM, dyM);
  const drs = [-1,-1,-1,0,0,1,1,1], dcs = [-1,0,1,-1,1,-1,0,1];
  const dists = [diag,dyM,diag,dxM,dxM,diag,dyM,diag];
  const E = new Float32Array(N); E.fill(Infinity);
  const settled = new Uint8Array(N);
  const seedR = (H/2)|0, seedC = (W/2)|0;
  const seedIdx = seedR * W + seedC;
  E[seedIdx] = 0;
  let cap = 65536, sz = 0;
  let pri = new Float64Array(cap), pay = new Int32Array(cap);
  function push(p, v) {
    if (sz >= cap) {
      cap *= 2;
      const a = new Float64Array(cap); a.set(pri); pri = a;
      const b = new Int32Array(cap); b.set(pay); pay = b;
    }
    let i = sz++; pri[i] = p; pay[i] = v;
    while (i > 0) {
      const par = (i - 1) >> 1;
      if (pri[par] <= pri[i]) break;
      const tp = pri[par]; pri[par] = pri[i]; pri[i] = tp;
      const tv = pay[par]; pay[par] = pay[i]; pay[i] = tv;
      i = par;
    }
  }
  function pop() {
    const tp = pri[0], tv = pay[0]; sz--;
    if (sz > 0) {
      pri[0] = pri[sz]; pay[0] = pay[sz];
      let i = 0;
      while (true) {
        const l = 2*i+1, r = 2*i+2;
        let s = i;
        if (l < sz && pri[l] < pri[s]) s = l;
        if (r < sz && pri[r] < pri[s]) s = r;
        if (s === i) break;
        const a = pri[s]; pri[s] = pri[i]; pri[i] = a;
        const b = pay[s]; pay[s] = pay[i]; pay[i] = b;
        i = s;
      }
    }
    return [tp, tv];
  }
  push(0, seedIdx);
  let popped = 0;
  while (sz > 0) {
    const [g, idx] = pop();
    if (settled[idx]) continue;
    settled[idx] = 1;
    popped++;
    const r = (idx/W)|0, c = idx - r*W, hh = height[idx];
    for (let k = 0; k < 8; k++) {
      const nr = r + drs[k], nc = c + dcs[k];
      if (nr < 0 || nr >= H || nc < 0 || nc >= W) continue;
      const ni = nr * W + nc;
      if (!mask[ni]) continue;
      const hn = height[ni];
      const dh = reverse ? hh - hn : hn - hh;
      const d = dists[k];
      const edge = dh >= 0 ? alpha*d + beta*dh : Math.max(0, alpha*d - eta*beta*(-dh));
      const t = g + edge;
      if (t < E[ni]) { E[ni] = t; push(t, ni); }
    }
  }
  return { E, popped };
}

for (const rev of [false, true]) {
  const t0 = Date.now();
  const { E, popped } = run(rev);
  const dt = Date.now() - t0;
  let fin = 0, maxE = 0;
  for (let i = 0; i < N; i++) {
    const v = E[i];
    if (Number.isFinite(v)) { fin++; if (v > maxE) maxE = v; }
  }
  console.log(`reverse=${rev}: ${dt}ms  popped=${popped}  finite=${fin}/${N}  maxE=${maxE.toFixed(2)}`);
}
