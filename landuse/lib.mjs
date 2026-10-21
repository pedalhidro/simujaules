// Shared helpers for the land-use bake (bake.mjs) and its test
// (test-landuse.mjs): grid geometry, a min-heap, priority-flood + D8, and
// a tiny exact PNG codec (8/16-bit, gray / RGB / RGBA, all five row filters)
// used to carry integer layers to the static page byte-for-byte. The page's
// decoder (landuse/index.html `decodePng`) is a mirror of `decodePng` below;
// test-landuse.mjs round-trips both through every filter.
import { deflateSync, inflateSync } from "zlib";

// ---- grid geometry ---------------------------------------------------------
// The output grid is regular in lon/lat (EPSG:4326), north-up, row 0 at the
// north edge. Cell areas shrink with cos(lat), so every area sum goes through
// cellAreaKm2(row) — never "cells × constant".
export const R_EARTH_M = 6371008.8;                 // mean radius (IUGG)
export function makeGrid({ west, east, south, north, step }) {
  const W = Math.round((east - west) / step);
  const H = Math.round((north - south) / step);
  const rowArea = new Float64Array(H);
  const rad = Math.PI / 180;
  for (let r = 0; r < H; r++) {
    const latN = north - r * step, latS = latN - step;
    // exact spherical zone area of one cell
    rowArea[r] = (R_EARTH_M * R_EARTH_M * (step * rad) *
      (Math.sin(latN * rad) - Math.sin(latS * rad))) / 1e6;
  }
  return {
    west, east: west + W * step, south: north - H * step, north, step, W, H,
    rowArea,                                   // km² per cell, by row
    lonOf: (c) => west + (c + 0.5) * step,
    latOf: (r) => north - (r + 0.5) * step,
    colOf: (lon) => Math.floor((lon - west) / step),
    rowOf: (lat) => Math.floor((north - lat) / step),
  };
}

// D8 neighbour order: E, SE, S, SW, W, NW, N, NE (code 0..7; 8 = no receiver)
export const D8_DR = [0, 1, 1, 1, 0, -1, -1, -1];
export const D8_DC = [1, 1, 0, -1, -1, -1, 0, 1];
export const NO_DIR = 8;

// ---- binary min-heap on (key, value) with Float64 keys ---------------------
export class MinHeap {
  constructor(cap = 1024) {
    this.k = new Float64Array(cap); this.v = new Int32Array(cap); this.n = 0;
  }
  push(key, val) {
    if (this.n === this.k.length) {
      const k = new Float64Array(this.n * 2); k.set(this.k); this.k = k;
      const v = new Int32Array(this.n * 2); v.set(this.v); this.v = v;
    }
    let i = this.n++;
    const K = this.k, V = this.v;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (K[p] <= key) break;
      K[i] = K[p]; V[i] = V[p]; i = p;
    }
    K[i] = key; V[i] = val;
  }
  pop() {                 // returns the value; the key is left in this.lastKey
    const K = this.k, V = this.v;
    const topV = V[0]; this.lastKey = K[0];
    const n = --this.n;
    if (n > 0) {
      const key = K[n], val = V[n];
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const m = r < n && K[r] < K[l] ? r : l;
        if (K[m] >= key) break;
        K[i] = K[m]; V[i] = V[m]; i = m;
      }
      K[i] = key; V[i] = val;
    }
    return topV;
  }
}

// ---- hydrology: priority-flood + epsilon, D8 on the filled surface --------
// Barnes et al. (2014) "Priority-Flood" with an epsilon gradient across
// filled depressions/flats, so every valid cell drains to the grid edge or
// to a nodata cell (the sea). Returns the filled surface (Float64), the D8
// receiver code per cell (steepest descent on the filled surface, distance-
// weighted), and `order` — the cells in pop order (non-decreasing filled
// height). Use topoOrder() — not `order` — for accumulation/labelling.
export function priorityFloodD8(elev, valid, W, H, dxRowM, dyM, eps = 1e-3) {
  const N = W * H;
  const filled = new Float64Array(N);
  const seen = new Uint8Array(N);
  const order = new Int32Array(N);
  let nOrder = 0;
  const heap = new MinHeap(1 << 16);
  const pit = new Int32Array(N); let pitHead = 0, pitTail = 0;
  // seeds: valid cells on the grid border or touching a nodata cell
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    const i = r * W + c;
    if (!valid[i]) { seen[i] = 1; continue; }
    let edge = r === 0 || c === 0 || r === H - 1 || c === W - 1;
    if (!edge) {
      for (let d = 0; d < 8 && !edge; d++) {
        if (!valid[(r + D8_DR[d]) * W + c + D8_DC[d]]) edge = true;
      }
    }
    if (edge) { seen[i] = 1; filled[i] = elev[i]; heap.push(elev[i], i); }
  }
  while (heap.n > 0 || pitHead < pitTail) {
    let i;
    if (pitHead < pitTail) i = pit[pitHead++];
    else i = heap.pop();
    order[nOrder++] = i;
    const r = (i / W) | 0, c = i - r * W;
    for (let d = 0; d < 8; d++) {
      const rr = r + D8_DR[d], cc = c + D8_DC[d];
      if (rr < 0 || cc < 0 || rr >= H || cc >= W) continue;
      const j = rr * W + cc;
      if (seen[j]) continue;
      seen[j] = 1;
      const lift = filled[i] + eps;
      if (elev[j] <= lift) { filled[j] = lift; pit[pitTail++] = j; }
      else { filled[j] = elev[j]; heap.push(elev[j], j); }
    }
  }
  // D8 steepest descent on the filled surface (strictly lower receivers only)
  const dir = new Uint8Array(N).fill(NO_DIR);
  for (let r = 0; r < H; r++) {
    const dx = dxRowM[r], dd = Math.hypot(dx, dyM);
    const dist = [dx, dd, dyM, dd, dx, dd, dyM, dd];
    for (let c = 0; c < W; c++) {
      const i = r * W + c;
      if (!valid[i]) continue;
      let best = 0, bestD = NO_DIR;
      for (let d = 0; d < 8; d++) {
        const rr = r + D8_DR[d], cc = c + D8_DC[d];
        if (rr < 0 || cc < 0 || rr >= H || cc >= W) continue;
        const j = rr * W + cc;
        if (!valid[j]) continue;
        const s = (filled[i] - filled[j]) / dist[d];
        if (s > best) { best = s; bestD = d; }
      }
      dir[i] = bestD;
    }
  }
  return { filled, dir, order: order.subarray(0, nOrder) };
}

// Upstream→downstream topological order of the valid cells from the D8 tree
// (Kahn on in-degrees). NOT the flood's pop order: with epsilon filling the
// pit queue interleaves with the heap, so pop order is not monotone in filled
// height and its reverse is not a valid accumulation order (measured: it
// broke accumulation along the Paraíba). Every receiver is strictly lower on
// the filled surface, so the D8 graph is a forest and this always completes.
export function topoOrder(dir, valid, W, H) {
  const N = W * H;
  const indeg = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (!valid[i]) continue;
    const j = receiverOf(i, dir, W);
    if (j >= 0) indeg[j]++;
  }
  const order = new Int32Array(N);
  let head = 0, tail = 0;
  for (let i = 0; i < N; i++) if (valid[i] && indeg[i] === 0) order[tail++] = i;
  while (head < tail) {
    const i = order[head++];
    const j = receiverOf(i, dir, W);
    if (j >= 0 && --indeg[j] === 0) order[tail++] = j;
  }
  return order.subarray(0, tail);
}

export function receiverOf(i, dir, W) {
  const d = dir[i];
  if (d === NO_DIR) return -1;
  const r = (i / W) | 0, c = i - r * W;
  return (r + D8_DR[d]) * W + c + D8_DC[d];
}

// ---- PNG codec (exact; no colour management, no premultiplied alpha) -------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };   // gray, RGB, gray+alpha, RGBA
function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

// `planes`: array of typed arrays (one per channel, length W*H, values fit
// the bit depth). colorType from the channel count: 1→gray, 3→RGB, 4→RGBA.
export function encodePng(planes, W, H, bitDepth = 8) {
  const nch = planes.length;
  const colorType = { 1: 0, 2: 4, 3: 2, 4: 6 }[nch];
  if (colorType === undefined) throw new Error("encodePng: 1–4 planes");
  const bpp = nch * (bitDepth / 8);              // bytes per pixel
  const stride = W * bpp;
  const raw = new Uint8Array(stride);
  const prev = new Uint8Array(stride);
  const out = new Uint8Array((stride + 1) * H);
  const cand = [0, 1, 2, 3, 4].map(() => new Uint8Array(stride));
  for (let r = 0; r < H; r++) {
    // serialize row (big-endian samples)
    for (let c = 0; c < W; c++) {
      for (let k = 0; k < nch; k++) {
        const v = planes[k][r * W + c];
        if (bitDepth === 16) {
          raw[c * bpp + k * 2] = (v >>> 8) & 0xff;
          raw[c * bpp + k * 2 + 1] = v & 0xff;
        } else raw[c * bpp + k] = v & 0xff;
      }
    }
    // pick the filter with the smallest sum of |signed bytes| (libpng heuristic)
    let bestF = 0, bestS = Infinity;
    for (let f = 0; f < 5; f++) {
      const o = cand[f];
      let s = 0;
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? raw[x - bpp] : 0, b = prev[x], cc = x >= bpp ? prev[x - bpp] : 0;
        let p;
        switch (f) {
          case 0: p = 0; break;
          case 1: p = a; break;
          case 2: p = b; break;
          case 3: p = (a + b) >> 1; break;
          default: p = paeth(a, b, cc);
        }
        const v = (raw[x] - p) & 0xff;
        o[x] = v;
        s += v < 128 ? v : 256 - v;
      }
      if (s < bestS) { bestS = s; bestF = f; }
    }
    out[r * (stride + 1)] = bestF;
    out.set(cand[bestF], r * (stride + 1) + 1);
    prev.set(raw);
  }
  const chunks = [];
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), Buffer.from(data)]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    chunks.push(len, td, crc);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = bitDepth; ihdr[9] = colorType; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  chunk("IHDR", ihdr);
  chunk("IDAT", deflateSync(out, { level: 9 }));
  chunk("IEND", Buffer.alloc(0));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ...chunks]);
}

// Mirror of the page's decoder (synchronous zlib here; the page inflates
// with DecompressionStream("deflate")). Returns { W, H, bitDepth, planes }.
export function decodePng(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let p = 8, W = 0, H = 0, bitDepth = 8, colorType = 0;
  const idat = [];
  while (p < u8.length) {
    const len = dv.getUint32(p);
    const type = String.fromCharCode(u8[p + 4], u8[p + 5], u8[p + 6], u8[p + 7]);
    const data = u8.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") {
      W = dv.getUint32(p + 8); H = dv.getUint32(p + 12);
      bitDepth = u8[p + 16]; colorType = u8[p + 17];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    p += 12 + len;
  }
  const z = inflateSync(Buffer.concat(idat.map((d) => Buffer.from(d))));
  return unfilterPng(new Uint8Array(z.buffer, z.byteOffset, z.byteLength), W, H, bitDepth, colorType);
}

export function unfilterPng(z, W, H, bitDepth, colorType) {
  const nch = CHANNELS[colorType];
  const bpp = nch * (bitDepth / 8), stride = W * bpp;
  const cur = new Uint8Array(stride), prev = new Uint8Array(stride);
  const planes = [];
  for (let k = 0; k < nch; k++) planes.push(bitDepth === 16 ? new Uint16Array(W * H) : new Uint8Array(W * H));
  for (let r = 0; r < H; r++) {
    const f = z[r * (stride + 1)], base = r * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      let pr;
      switch (f) {
        case 0: pr = 0; break;
        case 1: pr = a; break;
        case 2: pr = b; break;
        case 3: pr = (a + b) >> 1; break;
        default: pr = paeth(a, b, c);
      }
      cur[x] = (z[base + x] + pr) & 0xff;
    }
    for (let c = 0; c < W; c++) for (let k = 0; k < nch; k++) {
      planes[k][r * W + c] = bitDepth === 16
        ? (cur[c * bpp + 2 * k] << 8) | cur[c * bpp + 2 * k + 1]
        : cur[c * bpp + k];
    }
    prev.set(cur);
  }
  return { W, H, bitDepth, planes };
}
