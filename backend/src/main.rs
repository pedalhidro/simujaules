// simujoules-backend — optional native compute server for the density mode.
//
// The browser app works entirely without this binary (it falls back to its
// in-browser worker pool); the "Use native backend" toggle in the density
// panel is OFF by default. When enabled, the app POSTs the DEM + parameters
// to /density and this server runs one Dijkstra-with-passes per reference
// point, parallelised across cores with rayon, and streams back the merged
// density + mean-energy fields.
//
// The cost model, passes (shortest-path-tree subtree) accumulation, and
// density normalisation are ports of energy-worker.js — keep the two in
// sync. f32/f64 conversions mirror the JS Float32Array round trips exactly,
// so energies match the JS worker bit-for-bit (test-backend.mjs enforces
// this). The priority queue is a radix heap rather than the JS binary heap;
// it extracts exact f64 minima, but pops EXACT cost ties in a different
// order — where several optimal trees exist, passes may pick a different
// (equally valid) one.
//
// Parallel layout: refs are split into min(threads, K) contiguous slices;
// each slice owns ONE set of grid-sized scratch buffers reused across its
// refs (allocating ~25 bytes/cell per ref was the previous hot spot, and
// rayon's fold() could in the worst case materialise one 20-byte/cell
// accumulator per ref). Round mode additionally rayon::join's the
// forward/backward Dijkstras, so few-refs round runs still use idle cores.
//
// Protocol (little-endian throughout — bytemuck casts assume an LE target):
//   POST /density   (multi-reference density: one Dijkstra per ref point)
//     request body:  [u32 json_len][json Params][f32 height × N][u8 mask × N]
//                    [u8 network_mask × N  — only when has_network]
//                    [bridge portals — only when n_portals > 0]
//     Params may carry `nDirs` (4|8|16|32|64|128, default 8): the v57
//     movement-directions move set, mirrored from the JS worker's
//     buildMoves/longEdgeCost. nDirs=8 is bit-identical to the pre-0.2.0
//     engine; see Params.n_dirs for the version-gate note.
//     response body: [u32 json_len][json {"elapsed_ms":…,"refs":…[,"matrix":K]}]
//                    [f64 passes × N][f32 energy × N]
//                    [f32 matrix × K² — only when Params.want_matrix (and not
//                    maximize): the pairwise accessibility matrix, row-major
//                    over the ORIGINAL ref order (row i = ref i's energy
//                    sampled at every ref cell; refs skipped as off-grid/
//                    off-mask keep their index with an all-Infinity row —
//                    exactly like the JS densityField's refCells sampling).
//                    "matrix":K in the meta announces its presence.]
//   POST /single    (single-source energy field: from/to/round, energy+passes)
//     request body:  same framing as /density, driven by Params.src +
//                    Params.want_passes instead of ref_points
//     response body: [u32 json_len][json {"elapsed_ms":…,"passes":bool}]
//                    [f32 energy × N][f64 passes × N — only when want_passes;
//                    f64 like the JS worker's Float64Array subtreePasses]
//   GET /health → {"ok":true,"version":…,"cores":…,"mem_budget_bytes":…,
//                  "idle_seconds":…}  (idle_seconds = agora − último cálculo)
//
// Both compute endpoints are ports of energy-worker.js (density() / the
// from/to/round single-point path) — keep cost model, f32 storage, and
// passes accumulation in sync; test-backend.mjs enforces bit-parity.
//
// Usage: cargo run --release [-- 127.0.0.1:8077]

use rayon::prelude::*;
use serde::Deserialize;
use std::collections::HashMap;
use std::io::{Read, Write}; // Take/read_to_end on the request body reader; Write for gzip
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tiny_http::{Header, Method, Response, Server};

// Carimbo (unix segundos) do último CÁLCULO recebido (/density ou /single) — e
// NÃO de /health/OPTIONS. Inicializado com o horário de boot em main(). É lido
// pelo /health (idle_seconds = agora − este carimbo) e, por tabela, pelo
// idle-watchdog da VM, que desliga a instância quando fica ociosa demais (ver
// vm/README.md). CRÍTICO carimbar SÓ em cálculo: se /health também carimbasse, o
// próprio poll periódico do watchdog zeraria o relógio e a VM nunca desligaria.
// Não toca o caminho de cálculo; é só observabilidade pro backstop de custo.
static LAST_COMPUTE_AT: AtomicU64 = AtomicU64::new(0);

// Segundos de relógio de parede (epoch). 0 se o relógio estiver antes de 1970.
fn unix_now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// The v2 leg-energy cost bundle (mirrors energy-worker.js's `cost`). Physics is
/// folded once in app.js and shipped identically here, so the engines stay
/// bit-parity. See v2_edge().
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Cost {
    a_roll: f64,    // m·g·Crr / k_eff       (J per ground metre, always)
    a_aero: f64,    // ½·ρ·CdA·v_f² / k_eff   (J per ground metre, only OFF climbs)
    beta: f64,      // m·g / k_eff           (J per metre of climb)
    climb_thr: f64, // climb-grade threshold (grade ≥ this ⇒ drop aero)
    ab_ratio: f64,  // Crr + ½ρCdA·v_f²/(m·g) (flat-resistance grade, = α/β)
    eps_offset: f64, // empirical descent-recovery offset (≈0.13)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Params {
    h: usize,
    w: usize,
    dx: f64,
    dy: f64,
    cost: Cost,
    #[serde(default)]
    e_max: f64,
    /// Round mode only: "leg" (default) caps each direction at e_max;
    /// "total" masks round-trip sums beyond e_max to Infinity (the per-leg
    /// searches still run with e_max — a leg can never exceed the total).
    #[serde(default)]
    e_max_mode: String,
    /// "from" | "to" | "round" — direction of each reference's Dijkstra (also
    /// the direction of the single-source search on /single).
    density_mode: String,
    /// [[r, c], …] pixel coordinates of the reference points. Unused on /single.
    #[serde(default)]
    ref_points: Vec<[i64; 2]>,
    /// /single only: [r, c] pixel coordinates of the single source point.
    #[serde(default)]
    src: [i64; 2],
    /// /single only: also return the per-cell passes count (subtree sizes).
    #[serde(default)]
    want_passes: bool,
    #[serde(default)]
    has_network: bool,
    #[serde(default)]
    maximize: bool,
    /// Number of bridge portal edges appended after the masks, in order:
    /// portalU (i32×P), portalV (i32×P), portalLenM (f64×P).
    #[serde(default)]
    n_portals: usize,
    /// /density only: also return the pairwise ref↔ref accessibility matrix
    /// (f32 × K², appended after the energy field; "matrix":K in the meta).
    /// Ignored under maximize — mirrors the JS worker.
    #[serde(default)]
    want_matrix: bool,
    /// v57 movement directions: 4 | 8 | 16 | 32 | 64 | 128 (Farey heading
    /// ladders, long moves profile-integrated — see build_moves /
    /// energy-worker.js buildMoves). Default 8 = the classic engine.
    /// WIRE-COMPAT NOTE: this Params struct does NOT set
    /// #[serde(deny_unknown_fields)], so serde silently IGNORES fields it
    /// doesn't know — a pre-0.2.0 binary ACCEPTS an nDirs request and
    /// computes the 8-dir field. The app therefore gates nDirs≠8 backend
    /// dispatch on /health "version" >= 0.2.0. parse_grid_request rejects
    /// values outside the whitelist with a 400 and forces 8 under maximize
    /// (mirroring the JS worker's nDirsEff).
    #[serde(default = "default_n_dirs")]
    n_dirs: u32,
}

fn default_n_dirs() -> u32 {
    8
}

struct Grid<'a> {
    height: &'a [f32],
    mask: &'a [u8],
    h: usize,
    w: usize,
    dx: f64,
    dy: f64,
}

/// Monotone radix heap keyed on the raw IEEE-754 bits of the (non-negative,
/// finite) f64 priority — to_bits() is order-preserving there, so min
/// extraction is EXACT, no quantisation. Dijkstra's priorities are monotone
/// (every push is ≥ the last extracted min because edges are ≥ 0), which is
/// the one precondition a radix heap needs. O(1) push, amortised O(64) pop,
/// and bucket scans are linear — far friendlier to the cache than a binary
/// heap's pointer-chasing sift, typically 1.5–2× on grid Dijkstra.
///
/// Tie note vs the JS worker's binary heap: equal-priority entries pop in a
/// different order. Energies are unaffected (ties have equal E by
/// definition); the passes field can differ only where two paths have
/// EXACTLY equal f64 cost, in which case both trees are valid optima.
struct RadixHeap {
    buckets: Vec<Vec<(u64, u32)>>, // 65: bucket 0 holds keys == last
    spare: Vec<(u64, u32)>,        // reusable scratch for redistribution
    last: u64,                     // key of the last extracted minimum
    len: usize,
}

impl RadixHeap {
    fn new() -> Self {
        RadixHeap { buckets: (0..65).map(|_| Vec::new()).collect(), spare: Vec::new(), last: 0, len: 0 }
    }
    fn clear(&mut self) {
        for b in &mut self.buckets {
            b.clear();
        }
        self.last = 0;
        self.len = 0;
    }
    #[inline]
    fn bucket_of(key: u64, last: u64) -> usize {
        // Index = position of the highest bit where key differs from last.
        (64 - (key ^ last).leading_zeros()) as usize
    }
    #[inline]
    fn push(&mut self, p: f64, v: u32) {
        let key = p.to_bits();
        debug_assert!(key >= self.last, "radix heap requires monotone keys");
        self.buckets[Self::bucket_of(key, self.last)].push((key, v));
        self.len += 1;
    }
    fn pop(&mut self) -> Option<(f64, u32)> {
        if self.len == 0 {
            return None;
        }
        if self.buckets[0].is_empty() {
            // Advance `last` to the min of the first non-empty bucket and
            // redistribute it: every entry lands in a strictly lower bucket
            // (the radix invariant), the min itself in bucket 0.
            let i = (1..65).find(|&i| !self.buckets[i].is_empty()).unwrap();
            let mut tmp = std::mem::take(&mut self.spare);
            std::mem::swap(&mut tmp, &mut self.buckets[i]);
            self.last = tmp.iter().map(|e| e.0).min().unwrap();
            for &(k, v) in &tmp {
                self.buckets[Self::bucket_of(k, self.last)].push((k, v));
            }
            tmp.clear();
            self.spare = tmp;
        }
        let (k, v) = self.buckets[0].pop().unwrap();
        self.len -= 1;
        Some((f64::from_bits(k), v))
    }
}

/// Grid-sized working memory for one Dijkstra, allocated once per ref
/// slice and reset (fill, not realloc) between refs. e/passes double as
/// the per-ref outputs read by Acc::accumulate*.
struct Scratch {
    e: Vec<f32>,
    parents: Vec<i32>,
    settled: Vec<u8>,
    order: Vec<u32>,
    // f32 (not f64): matches the JS densityField's Float32Array passes, and
    // subtree counts widen exactly into the f64 `Acc.density` below — so the
    // DENSITY path stays bit-parity while saving 4 B/cell. The /single path
    // does NOT use this field: the JS single-source branch returns Float64Array
    // passes (counts exceed 2^24 on big DEMs, where f32 would round), so
    // compute_single accumulates in f64 via subtree_passes_f64 instead.
    passes: Vec<f32>,
    // Which parent links used a LONG grid move (passes stamping over the
    // swept cells; portals and unit moves never stamp). EMPTY (0 bytes, not
    // n) when the move set has no long moves — nDirs=8 keeps the documented
    // 17 B/cell Scratch footprint, mirroring the JS worker's conditional
    // parentLong allocation.
    parent_long: Vec<u8>,
    heap: RadixHeap,
}

impl Scratch {
    fn new(n: usize, has_long: bool) -> Self {
        Scratch {
            e: vec![f32::INFINITY; n],
            parents: vec![-1; n],
            settled: vec![0; n],
            order: Vec::with_capacity(n),
            passes: vec![0.0; n],
            parent_long: if has_long { vec![0; n] } else { Vec::new() },
            heap: RadixHeap::new(),
        }
    }
    fn reset(&mut self) {
        self.e.fill(f32::INFINITY);
        self.parents.fill(-1);
        self.settled.fill(0);
        self.order.clear();
        self.passes.fill(0.0);
        self.parent_long.fill(0);
        self.heap.clear();
    }
}

/// Dijkstra — port of energy-worker.js dijkstra() with wantTree = true.
/// Energies land in s.e (f32, like the JS Float32Array, with the same
/// settled-flag staleness handling so the two implementations settle cells
/// identically); parents + settle order are kept for a subsequent
/// subtree_passes() call (round mode needs both legs' energies before it
/// knows which endpoints count, so the accumulation is a separate step).
/// Bridge portal edges: cell → [(to, fwd_cost, bwd_cost)]. fwd is the real cost
/// in this direction, bwd the reverse — a `reverse` search uses bwd, mirroring
/// the grid dh sign flip. Built identically to the JS worker's buildPortalAdj
/// so costs match bit-for-bit (parity). The cells under a deck are untouched.
type PortalAdj = HashMap<u32, Vec<(u32, f64, f64)>>;

/// THE single per-edge cost — a byte-identical port of energy-worker.js's v2Edge
/// (same operation order so the bit-parity test holds). `dist` = ground length,
/// `dh` = signed rise (m).
///
/// The trailing `max(0, e)` on descents is provably dead code: given the
/// grade-local `eps = clamp01(min(1, ab_ratio/s) - eps_offset)`, the descent
/// cost is bounded below by +epsOffset*a_roll*dist > 0 for every parameter
/// bundle (see bicycling-energy-model journal Entry 18 / the `descFloor`
/// derivation in energy-worker.js's A* heuristic, ~617-637; 1.78M-combo sweep,
/// global min pre-clamp = +4.1e-4 kJ). It is kept ONLY for JS/Rust bit-parity
/// defense — never remove it on one side alone, and never remove it at all
/// without re-running the Entry 18 proof against the changed formula.
#[inline]
fn v2_edge(dist: f64, dh: f64, c: &Cost) -> f64 {
    if dh >= 0.0 {
        let aero = if dh < c.climb_thr * dist { c.a_aero * dist } else { 0.0 };
        return c.a_roll * dist + aero + c.beta * dh;
    }
    let ndh = -dh;
    let mut eps = c.ab_ratio * dist / ndh;
    if eps > 1.0 {
        eps = 1.0;
    }
    eps -= c.eps_offset;
    if eps < 0.0 {
        eps = 0.0;
    }
    let e = c.a_roll * dist + c.a_aero * dist - eps * c.beta * ndh;
    if e < 0.0 {
        0.0
    } else {
        e
    }
}

fn portal_cost(len_m: f64, dh: f64, p: &Params) -> f64 {
    v2_edge(len_m, dh, &p.cost)
}

/// JS `Math.hypot(x, y)` mirror — V8's BUILTIN(MathHypot): abs, normalise by
/// the max, Kahan-compensated sum of squares, then sqrt(sum)·max. NOT the
/// same as libm's `f64::hypot`, which differs by 1 ulp on many of the
/// long-move distances (measured: knight move at dx=dy=30 already differs) —
/// and a 1-ulp edge-cost difference flips near-tie relaxations, breaking
/// passes parity with the JS worker. test-backend.mjs runs the reference on
/// Node (V8), so THIS is the bit-parity target. Finite inputs only (move
/// distances) — the NaN/Infinity/zero special cases are irrelevant here
/// except max==0, kept for completeness.
#[inline]
fn js_hypot(x: f64, y: f64) -> f64 {
    let (ax, ay) = (x.abs(), y.abs());
    let mut max = 0.0f64;
    if max < ax {
        max = ax;
    }
    if max < ay {
        max = ay;
    }
    if max == 0.0 {
        return 0.0;
    }
    let mut sum = 0.0f64;
    let mut compensation = 0.0f64;
    for v in [ax, ay] {
        let n = v / max;
        let summand = n * n - compensation;
        let preliminary = sum + summand;
        compensation = (preliminary - sum) - summand;
        sum = preliminary;
    }
    sum.sqrt() * max
}

/// JS `Math.round` mirror: exact halves round toward +∞ (Rust's f64::round
/// rounds them away from zero — differs for negative halves, which the sweep
/// templates of negative-dr/dc long moves do hit). x − floor(x) is exact for
/// the small rationals used here, so this is the spec semantics.
#[inline]
fn js_round(x: f64) -> f64 {
    let f = x.floor();
    if x - f >= 0.5 {
        f + 1.0
    } else {
        f
    }
}

/// Move set (grid neighborhood, 4–128 directions) — port of
/// energy-worker.js's buildMoves(): Farey/Stern–Brocot heading ladders, THE
/// FIRST 8 MOVES OF EVERY SET ≥ 8 ARE THE CLASSIC 8 IN THE CLASSIC ORDER
/// (that property is what keeps nDirs=8 bit-identical to the pre-0.2.0
/// engine — same moves, same relaxation order, same exact dist expressions).
/// Long moves (max(|dr|,|dc|) > 1) are PROFILE-INTEGRATED (long_edge_cost);
/// `sweep_by_delta` maps a long move's flat-index delta to the intermediate
/// cells its segment sweeps (for the passes stamping).
struct Moves {
    k: usize,
    drs: Vec<i64>,
    dcs: Vec<i64>,
    d_idx: Vec<i64>,
    dists: Vec<f64>,
    sub_n: Vec<i32>,
    is_long: Vec<u8>,
    max_r: i64,
    sweep_by_delta: HashMap<i64, Vec<i64>>,
    has_long: bool,
}

fn build_moves(n_dirs: u32, w: usize, dx: f64, dy: f64) -> Moves {
    let mut vecs: Vec<(i64, i64)>;
    if n_dirs == 4 {
        vecs = vec![(-1, 0), (0, -1), (0, 1), (1, 0)];
    } else {
        // classic 8 first, classic order (the bit-parity anchor for nDirs = 8)
        vecs = vec![(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)];
        let level = match n_dirs {
            16 => 1,
            32 => 2,
            64 => 3,
            128 => 4,
            _ => 0,
        };
        if level > 0 {
            // Farey mediant ladder over the first octant, then the 4 sign ×
            // swap images of each vector, deduped in insertion order — the
            // JS Set-of-"r,c"-strings dedupe, same order.
            let mut oct: Vec<(i64, i64)> = vec![(1, 0), (1, 1)];
            for _ in 0..level {
                let mut next = Vec::with_capacity(oct.len() * 2 - 1);
                for i in 0..oct.len() - 1 {
                    next.push(oct[i]);
                    next.push((oct[i].0 + oct[i + 1].0, oct[i].1 + oct[i + 1].1));
                }
                next.push(*oct.last().unwrap());
                oct = next;
            }
            let mut seen: std::collections::HashSet<(i64, i64)> = vecs.iter().copied().collect();
            for &(a, b) in &oct {
                for (dr, dc) in [(a, b), (b, a)] {
                    for sr in [1i64, -1] {
                        for sc in [1i64, -1] {
                            let v = (dr * sr, dc * sc);
                            if seen.insert(v) {
                                vecs.push(v);
                            }
                        }
                    }
                }
            }
        }
    }
    let k = vecs.len();
    let diag = js_hypot(dx, dy);
    let mut drs = vec![0i64; k];
    let mut dcs = vec![0i64; k];
    let mut d_idx = vec![0i64; k];
    let mut dists = vec![0f64; k];
    let mut sub_n = vec![0i32; k];
    let mut is_long = vec![0u8; k];
    let mut sweep_by_delta: HashMap<i64, Vec<i64>> = HashMap::new();
    let mut max_r = 1i64;
    for (kk, &(dr, dc)) in vecs.iter().enumerate() {
        drs[kk] = dr;
        dcs[kk] = dc;
        d_idx[kk] = dr * w as i64 + dc;
        // Unit moves reuse the EXACT legacy expressions (dx / dy / hypot) —
        // the nDirs=8 default must stay bit-identical to the 0.1.x engine.
        dists[kk] = if dr == 0 {
            dx * dc.abs() as f64
        } else if dc == 0 {
            dy * dr.abs() as f64
        } else if dr.abs() == 1 && dc.abs() == 1 {
            diag
        } else {
            js_hypot(dr as f64 * dy, dc as f64 * dx)
        };
        let m = dr.abs().max(dc.abs());
        if m > 1 {
            is_long[kk] = 1;
            sub_n[kk] = (2 * m) as i32;
            max_r = max_r.max(m);
            // supercover-ish template of intermediate cells (relative to the
            // edge START) — passes stamping over the cells a long move
            // crosses. First-occurrence dedupe = the JS Set(cells) order.
            let mut cells: Vec<i64> = Vec::new();
            for s in 1..sub_n[kk] {
                let rr = js_round(dr as f64 * s as f64 / sub_n[kk] as f64) as i64;
                let cc = js_round(dc as f64 * s as f64 / sub_n[kk] as f64) as i64;
                if (rr != 0 || cc != 0) && !(rr == dr && cc == dc) {
                    let d = rr * w as i64 + cc;
                    if !cells.contains(&d) {
                        cells.push(d);
                    }
                }
            }
            sweep_by_delta.insert(d_idx[kk], cells);
        }
    }
    Moves { k, drs, dcs, d_idx, dists, sub_n, is_long, max_r, sweep_by_delta, has_long: max_r > 1 }
}

/// Profile-integrated cost of one long move (r,c) → (r+dr, c+dc) — port of
/// energy-worker.js's longEdgeCost, same op order: bilinear height samples
/// every ~1 cell (heights f32-widened to f64 exactly like the JS
/// Float32Array reads), v2_edge per sub-segment, f64 accumulation. `flip`
/// negates each sub-step's dh (reverse travel). Any sample whose bilinear
/// support touches an unpassable cell blocks the move (returns Infinity) —
/// the long-move analog of the unit mask check. A long move costed from its
/// endpoints' Δh alone would flatten the relief it crosses — deliberately
/// impossible here, mirror the JS.
fn long_edge_cost(
    height: &[f32],
    mask: &[u8],
    h: usize,
    w: usize,
    r: usize,
    c: usize,
    dr: i64,
    dc: i64,
    dist_m: f64,
    n: i32,
    flip: bool,
    cost: &Cost,
) -> f64 {
    let sub = dist_m / n as f64;
    let mut e = 0.0f64;
    let mut h_prev = height[r * w + c] as f64;
    for s in 1..=n {
        let hs: f64;
        if s == n {
            let idx = (r as i64 + dr) as usize * w + (c as i64 + dc) as usize;
            hs = height[idx] as f64;
        } else {
            let fr = r as f64 + dr as f64 * s as f64 / n as f64;
            let fc = c as f64 + dc as f64 * s as f64 / n as f64;
            let r1 = fr.floor().max(0.0).min((h - 2) as f64) as usize;
            let c1 = fc.floor().max(0.0).min((w - 2) as f64) as usize;
            let b0 = r1 * w + c1;
            if mask[b0] == 0 || mask[b0 + 1] == 0 || mask[b0 + w] == 0 || mask[b0 + w + 1] == 0 {
                return f64::INFINITY;
            }
            let tr = fr - r1 as f64;
            let tc = fc - c1 as f64;
            hs = height[b0] as f64 * (1.0 - tr) * (1.0 - tc)
                + height[b0 + 1] as f64 * (1.0 - tr) * tc
                + height[b0 + w] as f64 * tr * (1.0 - tc)
                + height[b0 + w + 1] as f64 * tr * tc;
        }
        e += v2_edge(sub, if flip { h_prev - hs } else { hs - h_prev }, cost);
        h_prev = hs;
    }
    e
}

/// Per-direction long-edge cost tables for ONE travel direction (rev):
/// indexed by move k (Some only for long moves), each a full-grid f64 array
/// T[u] = long_edge_cost from cell u — Infinity where an endpoint is masked
/// or the profile is blocked. Same construction as the JS densityField's
/// longTables, so values are BIT-IDENTICAL to on-demand integration
/// (test-worker-pool.mjs asserts that equivalence on the JS side). Unlike
/// the JS workers (one table set per worker), Rust threads share memory:
/// compute_density builds this ONCE per request and shares it read-only
/// across all rayon slices — per-slice copies would multiply the 8·N bytes
/// per long direction by the slice count. Rust uses tables whenever the set
/// has long moves (the JS ≥3-refs amortisation heuristic is a per-worker-
/// memory tradeoff that doesn't apply to a shared table); /single keeps
/// on-demand integration like the JS dijkstra() — one or two searches never
/// pay back a full-grid table, especially under a budget.
type LongTable = Vec<Option<Vec<f64>>>;

fn build_long_table(height: &[f32], mask: &[u8], h: usize, w: usize, mv: &Moves, rev: bool, cost: &Cost) -> LongTable {
    (0..mv.k)
        .into_par_iter()
        .map(|k| {
            if mv.is_long[k] == 0 {
                return None;
            }
            let mut t = vec![f64::INFINITY; h * w];
            let (dr, dc) = (mv.drs[k], mv.dcs[k]);
            let r0 = (-dr).max(0) as usize;
            let r1 = (h as i64 - dr.max(0)).max(0) as usize;
            let c0 = (-dc).max(0) as usize;
            let c1 = (w as i64 - dc.max(0)).max(0) as usize;
            for r in r0..r1 {
                let base = r * w;
                for c in c0..c1 {
                    let u = base + c;
                    if mask[u] == 0 || mask[(u as i64 + mv.d_idx[k]) as usize] == 0 {
                        continue;
                    }
                    t[u] = long_edge_cost(height, mask, h, w, r, c, dr, dc, mv.dists[k], mv.sub_n[k], rev, cost);
                }
            }
            Some(t)
        })
        .collect()
}

// phu/phv: per-portal deck-END elevations (from OSM `ele`). NaN means "no mapped
// ele" → fall back to the DEM height at the abutment cell. Must match the JS
// buildPortalAdj fallback exactly for parity.
fn build_portals(pu: &[i32], pv: &[i32], pl: &[f64], phu: &[f64], phv: &[f64], height: &[f32], mask: &[u8], p: &Params) -> PortalAdj {
    let mut adj: PortalAdj = HashMap::new();
    let n = mask.len() as i32;
    for i in 0..pu.len() {
        let (u, v, l) = (pu[i], pv[i], pl[i]);
        if u < 0 || v < 0 || u >= n || v >= n || u == v {
            continue;
        }
        let (uu, vv) = (u as usize, v as usize);
        if mask[uu] == 0 || mask[vv] == 0 {
            continue;
        }
        let hu = if phu[i].is_nan() { height[uu] as f64 } else { phu[i] };
        let hv = if phv[i].is_nan() { height[vv] as f64 } else { phv[i] };
        let cost_uv = portal_cost(l, hv - hu, p);
        let cost_vu = portal_cost(l, hu - hv, p);
        adj.entry(u as u32).or_default().push((v as u32, cost_uv, cost_vu));
        adj.entry(v as u32).or_default().push((u as u32, cost_vu, cost_uv));
    }
    adj
}

fn dijkstra_tree(
    g: &Grid,
    seed_r: usize,
    seed_c: usize,
    p: &Params,
    reverse: bool,
    max_edge_cost: f64,
    portals: &PortalAdj,
    mv: &Moves,
    // Long-edge cost table for THIS travel direction (rev), shared read-only
    // across rayon slices — None = integrate on demand (the /single path,
    // mirroring the JS dijkstra()). Values are bit-identical either way.
    tbl: Option<&LongTable>,
    s: &mut Scratch,
) {
    s.reset();
    let (h, w) = (g.h, g.w);
    let mk = mv.k;
    let max_r = mv.max_r;
    let track_long = !s.parent_long.is_empty();

    let seed_idx = seed_r * w + seed_c;
    s.e[seed_idx] = 0.0;
    s.heap.push(0.0, seed_idx as u32);

    while let Some((gcost, idx32)) = s.heap.pop() {
        let idx = idx32 as usize;
        if s.settled[idx] != 0 {
            continue;
        }
        s.settled[idx] = 1;
        s.order.push(idx32);

        let r = idx / w;
        let c = idx - r * w;
        let h_here = g.height[idx] as f64;
        // Interior test uses the move set's max offset radius (1 for the
        // classic 8) so `inner` guarantees EVERY move lands in-bounds.
        let inner = r as i64 >= max_r
            && (r as i64) < h as i64 - max_r
            && c as i64 >= max_r
            && (c as i64) < w as i64 - max_r;

        for k in 0..mk {
            let n_idx = if inner {
                (idx as i64 + mv.d_idx[k]) as usize
            } else {
                let nr = r as i64 + mv.drs[k];
                let nc = c as i64 + mv.dcs[k];
                if nr < 0 || nr >= h as i64 || nc < 0 || nc >= w as i64 {
                    continue;
                }
                (nr * w as i64 + nc) as usize
            };
            if g.mask[n_idx] == 0 || s.settled[n_idx] != 0 {
                continue;
            }

            let mut edge;
            if mv.is_long[k] != 0 {
                // Long move: profile-integrated (maximize never has long
                // moves — parse_grid_request forces nDirs=8 under maximize,
                // like the JS worker's nDirsEff).
                edge = match tbl {
                    Some(t) => t[k].as_ref().map_or(f64::INFINITY, |arr| arr[idx]),
                    None => long_edge_cost(
                        g.height, g.mask, h, w, r, c, mv.drs[k], mv.dcs[k], mv.dists[k], mv.sub_n[k], reverse,
                        &p.cost,
                    ),
                };
                if edge == f64::INFINITY {
                    continue;
                }
            } else {
                let h_nbr = g.height[n_idx] as f64;
                let dh = if reverse { h_here - h_nbr } else { h_nbr - h_here };
                edge = v2_edge(mv.dists[k], dh, &p.cost);
            }
            if p.maximize {
                edge = (max_edge_cost - edge).max(0.0);
            }

            let tentative = gcost + edge;
            if p.e_max > 0.0 && tentative > p.e_max {
                continue;
            }
            // Compare in f64 against the f32-widened stored value — exactly
            // what the JS `tentative < E[nIdx]` does — so near-tie relaxation
            // decisions (and therefore parents/passes) match the worker.
            if tentative < s.e[n_idx] as f64 {
                s.e[n_idx] = tentative as f32;
                s.parents[n_idx] = idx as i32;
                if track_long {
                    s.parent_long[n_idx] = mv.is_long[k];
                }
                s.heap.push(tentative, n_idx as u32);
            }
        }

        // Bridge portal edges (deck shortcuts) — relaxed exactly like grid
        // edges. Monotone-safe (edge ≥ 0 ⇒ tentative ≥ gcost), so the radix
        // heap invariant holds. Cells under the deck are never touched.
        if let Some(plist) = portals.get(&(idx as u32)) {
            for &(to, fwd, bwd) in plist {
                let n_idx = to as usize;
                if s.settled[n_idx] != 0 {
                    continue;
                }
                let mut edge = if reverse { bwd } else { fwd };
                if p.maximize {
                    edge = (max_edge_cost - edge).max(0.0);
                }
                let tentative = gcost + edge;
                if p.e_max > 0.0 && tentative > p.e_max {
                    continue;
                }
                if tentative < s.e[n_idx] as f64 {
                    s.e[n_idx] = tentative as f32;
                    s.parents[n_idx] = idx as i32;
                    if track_long {
                        // portal, not a long grid move — must never stamp
                        s.parent_long[n_idx] = 0;
                    }
                    s.heap.push(tentative, n_idx as u32);
                }
            }
        }
    }

}

/// Subtree accumulation over the reverse settle order (see the JS worker
/// for why this equals "number of optimal paths through each cell").
/// `include` selects which cells count as trajectory ENDPOINTS — round mode
/// passes the "round trip feasible / within budget" mask so only displayed
/// destinations contribute. Intermediate cells need no filtering: an
/// over-budget corridor cell still carries legs serving in-budget cells.
fn subtree_passes(s: &mut Scratch, include: Option<&[u8]>) {
    match include {
        Some(inc) => {
            for &i in &s.order {
                s.passes[i as usize] = f32::from(inc[i as usize]);
            }
        }
        None => {
            for &i in &s.order {
                s.passes[i as usize] = 1.0;
            }
        }
    }
    for &i in s.order.iter().rev() {
        let par = s.parents[i as usize];
        if par >= 0 {
            s.passes[par as usize] += s.passes[i as usize];
        }
    }
}

/// f64 twin of subtree_passes for the /single response: the JS worker's
/// single-source branch returns a Float64Array (subtreePasses — counts exceed
/// 2^24 on big DEMs, where f32 would round), so /single accumulates AND ships
/// f64. Density keeps the f32 Scratch.passes (which matches the JS
/// densityField's Float32Array). Reads the Scratch's parents/order without
/// touching its f32 passes.
fn subtree_passes_f64(s: &Scratch, include: Option<&[u8]>) -> Vec<f64> {
    let mut passes = vec![0.0f64; s.e.len()];
    match include {
        Some(inc) => {
            for &i in &s.order {
                passes[i as usize] = f64::from(inc[i as usize]);
            }
        }
        None => {
            for &i in &s.order {
                passes[i as usize] = 1.0;
            }
        }
    }
    for &i in s.order.iter().rev() {
        let par = s.parents[i as usize];
        if par >= 0 {
            passes[par as usize] += passes[i as usize];
        }
    }
    passes
}

/// Port of energy-worker.js's stampLongPasses: long moves carry flow OVER
/// their intermediate cells without stepping through them — stamp each used
/// long edge's flow (the child's subtree count) onto the cells its segment
/// sweeps. Exact JS mirror, including the load-bearing details:
///   - flows are read BEFORE any stamp lands (two-phase: collect, then
///     apply in collection order) — a swept cell's own subtree count must
///     not contaminate other edges' flows;
///   - only parent links marked long stamp (portals and unit moves never —
///     parent_long is 0 for both);
///   - stamps land only on cells SETTLED by this search (an unsettled
///     intermediate under eMax is outside `order`, so density's targeted
///     accumulate/reset would leak it into the next ref).
/// f32 variant (density): the apply step widens to f64 and rounds the sum
/// back to f32 — JS Float32Array `+=` semantics, bit-exact.
fn stamp_long_passes_f32(s: &mut Scratch, sweep: &HashMap<i64, Vec<i64>>) {
    if s.parent_long.is_empty() || sweep.is_empty() {
        return;
    }
    let mut si: Vec<u32> = Vec::new();
    let mut sv: Vec<f32> = Vec::new();
    for &idx32 in &s.order {
        let idx = idx32 as usize;
        if s.parent_long[idx] == 0 {
            continue;
        }
        let par = s.parents[idx];
        if par < 0 {
            continue;
        }
        let Some(sw) = sweep.get(&(idx as i64 - par as i64)) else { continue };
        let flow = s.passes[idx];
        if !(flow > 0.0) {
            continue;
        }
        for &d in sw {
            let cell = (par as i64 + d) as usize;
            if s.settled[cell] == 0 {
                continue;
            }
            si.push(cell as u32);
            sv.push(flow);
        }
    }
    for i in 0..si.len() {
        let cell = si[i] as usize;
        s.passes[cell] = (s.passes[cell] as f64 + sv[i] as f64) as f32;
    }
}

/// f64 twin for the /single passes (JS Float64Array — plain f64 adds).
fn stamp_long_passes_f64(passes: &mut [f64], s: &Scratch, sweep: &HashMap<i64, Vec<i64>>) {
    if s.parent_long.is_empty() || sweep.is_empty() {
        return;
    }
    let mut si: Vec<u32> = Vec::new();
    let mut sv: Vec<f64> = Vec::new();
    for &idx32 in &s.order {
        let idx = idx32 as usize;
        if s.parent_long[idx] == 0 {
            continue;
        }
        let par = s.parents[idx];
        if par < 0 {
            continue;
        }
        let Some(sw) = sweep.get(&(idx as i64 - par as i64)) else { continue };
        let flow = passes[idx];
        if !(flow > 0.0) {
            continue;
        }
        for &d in sw {
            let cell = (par as i64 + d) as usize;
            if s.settled[cell] == 0 {
                continue;
            }
            si.push(cell as u32);
            sv.push(flow);
        }
    }
    for i in 0..si.len() {
        passes[si[i] as usize] += sv[i];
    }
}

struct Acc {
    density: Vec<f64>,
    energy_sum: Vec<f64>,
    energy_count: Vec<u32>,
}

impl Acc {
    fn new(n: usize) -> Self {
        Acc { density: vec![0.0; n], energy_sum: vec![0.0; n], energy_count: vec![0; n] }
    }
    /// One "from"/"to" ref: density += passes/N, energy summed where reachable.
    fn accumulate(&mut self, s: &Scratch) {
        let n = self.density.len();
        let nf = n as f64;
        for i in 0..n {
            self.density[i] += s.passes[i] as f64 / nf;
            if s.e[i].is_finite() {
                self.energy_sum[i] += s.e[i] as f64;
                self.energy_count[i] += 1;
            }
        }
    }
    /// One "round" ref from its forward + backward runs. First builds the
    /// include mask — both legs finite, and within total_cap when set
    /// (eMaxMode = "total"; like the JS worker, the f64 sum is compared
    /// BEFORE the f32 rounding) — adding energy for included cells. Then
    /// computes FILTERED passes for both legs (each leg's long-move stamping
    /// runs right after its subtree walk, like the JS densityField), so only
    /// displayed (round-trip-feasible) destinations count as endpoints.
    fn accumulate_round(
        &mut self,
        fwd: &mut Scratch,
        bwd: &mut Scratch,
        include: &mut [u8],
        total_cap: f64,
        sweep: &HashMap<i64, Vec<i64>>,
    ) {
        let n = self.density.len();
        let nf = n as f64;
        for i in 0..n {
            let fe = fwd.e[i];
            let be = bwd.e[i];
            let mut ok = fe.is_finite() && be.is_finite();
            if ok {
                let s = fe as f64 + be as f64;
                if total_cap > 0.0 && s > total_cap {
                    ok = false;
                } else {
                    self.energy_sum[i] += (s as f32) as f64;
                    self.energy_count[i] += 1;
                }
            }
            include[i] = ok as u8;
        }
        subtree_passes(fwd, Some(include));
        stamp_long_passes_f32(fwd, sweep);
        subtree_passes(bwd, Some(include));
        stamp_long_passes_f32(bwd, sweep);
        for i in 0..n {
            self.density[i] += (fwd.passes[i] as f64 + bwd.passes[i] as f64) / nf;
        }
    }
    fn merge(mut self, other: Acc) -> Acc {
        for i in 0..self.density.len() {
            self.density[i] += other.density[i];
            self.energy_sum[i] += other.energy_sum[i];
            self.energy_count[i] += other.energy_count[i];
        }
        self
    }
}

// Total system memory in bytes, std-only (no extra crates). macOS via
// `sysctl -n hw.memsize`; Linux via /proc/meminfo `MemAvailable` (the
// realistic budget) falling back to `MemTotal`. None if neither works.
fn detect_total_mem_bytes() -> Option<u64> {
    // Linux: prefer MemAvailable, else MemTotal (values are in kB).
    if let Ok(s) = std::fs::read_to_string("/proc/meminfo") {
        let mut total = None;
        for line in s.lines() {
            if let Some(rest) = line.strip_prefix("MemAvailable:") {
                if let Some(kb) = rest.split_whitespace().next().and_then(|v| v.parse::<u64>().ok()) {
                    return Some(kb * 1024);
                }
            }
            if let Some(rest) = line.strip_prefix("MemTotal:") {
                total = rest.split_whitespace().next().and_then(|v| v.parse::<u64>().ok());
            }
        }
        if let Some(kb) = total {
            return Some(kb * 1024);
        }
    }
    // macOS: sysctl hw.memsize → bytes.
    if let Ok(out) = std::process::Command::new("sysctl").args(["-n", "hw.memsize"]).output() {
        if let Ok(s) = String::from_utf8(out.stdout) {
            if let Ok(b) = s.trim().parse::<u64>() {
                return Some(b);
            }
        }
    }
    None
}

// Memory budget (bytes) usable for per-slice scratch+accumulator allocations.
// `SIMU_MAX_MEM_GB` (or the `--max-mem-gb N` CLI flag, parsed in main) is the
// authoritative override; otherwise detect system RAM and reserve a fixed
// working set (the request body + height/mask copies + output buffers are all
// live alongside the slices in handle_density). Floors at 2 GB so we always
// run at least one slice.
fn density_mem_budget_bytes() -> u64 {
    if let Ok(s) = std::env::var("SIMU_MAX_MEM_GB") {
        if let Ok(g) = s.trim().parse::<f64>() {
            if g > 0.0 {
                return (g * 1e9 * 0.8) as u64;
            }
        }
    }
    let total = detect_total_mem_bytes().unwrap_or(8_000_000_000);
    // ~3 GB reserved for the live request body + DEM copies + output vecs.
    total.saturating_sub(3_000_000_000).max(2_000_000_000)
}

fn compute_density(
    g: &Grid,
    dem_mask: &[u8],
    p: &Params,
    portals: &PortalAdj,
    mv: &Moves,
) -> (Vec<f64>, Vec<f32>, Option<Vec<f32>>) {
    let n = g.h * g.w;

    // Same MAX_EDGE_COST bound as the JS worker's maximize mode. JS-parity
    // requirement: energy-worker.js derives the height range from the RAW DEM
    // mask BEFORE effMask exists (~lines 1329-1346), so this scans `dem_mask`,
    // NOT g.mask (the DEM AND network effective mask) — a network that
    // excludes the DEM's height extremes must not shrink the range, or the
    // engines invert against different maxEdgeCost and diverge wholesale.
    let max_edge_cost = if p.maximize {
        let (mut min_h, mut max_h) = (f64::INFINITY, f64::NEG_INFINITY);
        for i in 0..n {
            if dem_mask[i] != 0 {
                let v = g.height[i] as f64;
                min_h = min_h.min(v);
                max_h = max_h.max(v);
            }
        }
        let dh = if min_h.is_finite() && max_h.is_finite() { max_h - min_h } else { 0.0 };
        // Worst per-edge cost = rolling + flat aero over the diagonal + full climb.
        ((p.cost.a_roll + p.cost.a_aero) * g.dx.hypot(g.dy) + p.cost.beta * dh.max(1e-6)) * 1.001
    } else {
        0.0
    };

    // Off-grid / off-mask refs are skipped, like the JS worker — but their
    // ORIGINAL index rides along: the accessibility matrix keys rows by the
    // original ref order (a skipped ref keeps its index as an all-Infinity
    // row), so the JS worker and this port agree per index even when refs
    // are dropped. Slice boundaries below still cover only live refs, so
    // the f64 accumulation order (and its bit-parity) is unchanged.
    let refs: Vec<(usize, usize, usize)> = p
        .ref_points
        .iter()
        .enumerate()
        .filter(|(_, rc)| {
            let (r, c) = (rc[0], rc[1]);
            r >= 0
                && (r as usize) < g.h
                && c >= 0
                && (c as usize) < g.w
                && g.mask[r as usize * g.w + c as usize] != 0
        })
        .map(|(k, rc)| (k, rc[0] as usize, rc[1] as usize))
        .collect();

    // Accessibility matrix sampling targets: every ORIGINAL ref's flat cell
    // (−1 = off-grid), mirroring the JS worker's matrixCells. Off-mask cells
    // stay valid targets — they just never settle, reading Infinity.
    let want_matrix = p.want_matrix && !p.maximize;
    let kk = p.ref_points.len();
    let sample_cells: Vec<i64> = if want_matrix {
        p.ref_points
            .iter()
            .map(|rc| {
                let (r, c) = (rc[0], rc[1]);
                if r >= 0 && (r as usize) < g.h && c >= 0 && (c as usize) < g.w {
                    (r as usize * g.w + c as usize) as i64
                } else {
                    -1
                }
            })
            .collect()
    } else {
        Vec::new()
    };

    let round = p.density_mode == "round";
    let reverse = p.density_mode == "to";
    let total_cap = if round && p.e_max_mode == "total" && p.e_max > 0.0 { p.e_max } else { 0.0 };

    // Long-edge cost tables (nDirs > 8 only): one full-grid f64 array per
    // long move per travel direction, computed ONCE per request and shared
    // READ-ONLY across all rayon slices (unlike the JS workers, which each
    // build their own — Rust threads share memory, so per-slice tables
    // would multiply the footprint by the slice count). Non-round builds
    // only the direction it searches; round builds both.
    let tbl_fwd: Option<LongTable> = if mv.has_long && (round || !reverse) {
        Some(build_long_table(g.height, g.mask, g.h, g.w, mv, false, &p.cost))
    } else {
        None
    };
    let tbl_bwd: Option<LongTable> = if mv.has_long && (round || reverse) {
        Some(build_long_table(g.height, g.mask, g.h, g.w, mv, true, &p.cost))
    } else {
        None
    };

    // Cap concurrent slices by a memory budget so high ref counts on huge
    // DEMs don't OOM-crash. Each concurrent slice holds full-N buffers:
    //   Scratch ≈ 17·n (e4 + parents4 + settled1 + order4 + passes4)
    //             + 1·n more (parent_long) when the move set has long moves,
    //   Acc     ≈ 20·n (density8 + energy_sum8 + energy_count4).
    // Round runs two Scratch (s_f + s_b) plus an `include` Uint8 (n bytes).
    // The shared long-edge tables cost (revs × n_long_moves × 8 × n) bytes
    // ONCE per request — subtracted from the budget BEFORE dividing by
    // per_slice, since they're live alongside every slice.
    // Fewer slices just means more refs processed serially per slice (the
    // Scratch is already reused across a slice's refs), so the OUTPUT is
    // unchanged — only wall time grows. SIMU_MAX_MEM_GB / --max-mem-gb /
    // RAYON_NUM_THREADS are the manual levers (see README).
    let n64 = n as u64;
    let scratch_bytes = (17 + mv.has_long as u64) * n64;
    let acc_bytes = 20 * n64;
    // .max(1) guards the divisor: handle_density already rejects n==0, but a
    // zero per_slice here would panic the request loop (defensive belt).
    let per_slice = (if round { 2 * scratch_bytes + acc_bytes + n64 } else { scratch_bytes + acc_bytes }).max(1);
    let n_long = mv.is_long.iter().filter(|&&b| b != 0).count() as u64;
    let n_revs = tbl_fwd.is_some() as u64 + tbl_bwd.is_some() as u64;
    let table_bytes = n_revs * n_long * 8 * n64;
    let mem_cap = (density_mem_budget_bytes().saturating_sub(table_bytes) / per_slice).max(1) as usize;
    let n_slices = refs.len()
        .min(rayon::current_num_threads())
        .min(mem_cap)
        .max(1);
    // Echo the request shape (budget / mode / network-constrained) so the log
    // makes each compute self-describing. Emax=∞ means no budget (full grid).
    let emax_str = if p.e_max > 0.0 { format!("{:.0}", p.e_max) } else { "∞".to_string() };
    let net_type = if p.has_network { "vector" } else { "raster" };
    eprintln!(
        "[density] {} refs, Emax={}, mode={}, type={}, dirs={}, {}×{} grid, per-slice ≈ {:.1} GB, tables ≈ {:.1} GB, budget ≈ {:.1} GB → {} slice(s)",
        refs.len(), emax_str, p.density_mode, net_type, mv.k, g.w, g.h,
        per_slice as f64 / 1e9, table_bytes as f64 / 1e9, density_mem_budget_bytes() as f64 / 1e9, n_slices,
    );

    let results: Vec<(Acc, Vec<(usize, Vec<f32>)>)> = (0..n_slices)
        .into_par_iter()
        .map(|sl| {
            let lo = sl * refs.len() / n_slices;
            let hi = (sl + 1) * refs.len() / n_slices;
            let mut acc = Acc::new(n);
            // Accessibility rows this slice produced, keyed by ORIGINAL ref
            // index (disjoint across slices — scatter order is irrelevant).
            let mut rows: Vec<(usize, Vec<f32>)> = Vec::new();
            if round {
                // Forward/backward are independent — join them so round runs
                // with fewer refs than cores still spread across the machine.
                let mut s_f = Scratch::new(n, mv.has_long);
                let mut s_b = Scratch::new(n, mv.has_long);
                let mut include = vec![0u8; n];
                for &(orig_k, r, c) in &refs[lo..hi] {
                    rayon::join(
                        || dijkstra_tree(g, r, c, p, false, max_edge_cost, portals, mv, tbl_fwd.as_ref(), &mut s_f),
                        || dijkstra_tree(g, r, c, p, true, max_edge_cost, portals, mv, tbl_bwd.as_ref(), &mut s_b),
                    );
                    if want_matrix {
                        // Masked round-trip total — same predicate + f32
                        // rounding as accumulate_round / the JS worker.
                        let mut row = vec![f32::INFINITY; kk];
                        for (j, &cj) in sample_cells.iter().enumerate() {
                            if cj < 0 {
                                continue;
                            }
                            let fe = s_f.e[cj as usize];
                            let be = s_b.e[cj as usize];
                            if fe.is_finite() && be.is_finite() {
                                let sum = fe as f64 + be as f64;
                                if !(total_cap > 0.0 && sum > total_cap) {
                                    row[j] = sum as f32;
                                }
                            }
                        }
                        rows.push((orig_k, row));
                    }
                    acc.accumulate_round(&mut s_f, &mut s_b, &mut include, total_cap, &mv.sweep_by_delta);
                }
            } else {
                let mut s = Scratch::new(n, mv.has_long);
                let tbl = if reverse { tbl_bwd.as_ref() } else { tbl_fwd.as_ref() };
                for &(orig_k, r, c) in &refs[lo..hi] {
                    dijkstra_tree(g, r, c, p, reverse, max_edge_cost, portals, mv, tbl, &mut s);
                    if want_matrix {
                        let mut row = vec![f32::INFINITY; kk];
                        for (j, &cj) in sample_cells.iter().enumerate() {
                            if cj >= 0 {
                                row[j] = s.e[cj as usize];
                            }
                        }
                        rows.push((orig_k, row));
                    }
                    subtree_passes(&mut s, None);
                    stamp_long_passes_f32(&mut s, &mv.sweep_by_delta);
                    acc.accumulate(&s);
                }
            }
            (acc, rows)
        })
        .collect();

    // Sequential slice-order merge — deterministic across runs. Matrix rows
    // scatter into their original-index slots (rows of refs the filter
    // dropped stay all-Infinity, matching the JS worker).
    let mut matrix = if want_matrix { Some(vec![f32::INFINITY; kk * kk]) } else { None };
    let mut acc_opt: Option<Acc> = None;
    for (a, rows) in results {
        if let Some(m) = matrix.as_mut() {
            for (orig_k, row) in rows {
                m[orig_k * kk..(orig_k + 1) * kk].copy_from_slice(&row);
            }
        }
        acc_opt = Some(match acc_opt {
            Some(prev) => prev.merge(a),
            None => a,
        });
    }
    let acc = acc_opt.unwrap_or_else(|| Acc::new(n));

    let mut density = acc.density;
    for v in density.iter_mut() {
        *v /= n as f64;
    }
    let energy: Vec<f32> = (0..n)
        .map(|i| {
            if acc.energy_count[i] > 0 {
                (acc.energy_sum[i] / acc.energy_count[i] as f64) as f32
            } else {
                f32::INFINITY
            }
        })
        .collect();
    (density, energy, matrix)
}

/// Single-source energy field — port of energy-worker.js's from/to/round
/// single-point path (the non-density branch). Returns the raw per-cell energy
/// (NOT averaged like density) and, when `want_passes`, the per-cell passes
/// count (subtree sizes) as f64 — the JS branch returns Float64Array, and
/// counts exceed 2^24 on big DEMs where f32 would round (density's f32 passes
/// stay untouched; they mirror the JS densityField's Float32Array).
/// Maximize/top-N/path stay browser-only (the backend produces no routes;
/// handle_single rejects maximize with a 400), so this is energy + passes
/// only. Round mode sums the forward + backward legs (masking over-budget
/// sums in "total" mode) and filters passes to round-trip-feasible endpoints
/// — exactly like the worker.
fn compute_single(g: &Grid, p: &Params, portals: &PortalAdj, mv: &Moves) -> (Vec<f32>, Vec<f64>) {
    let n = g.h * g.w;
    let (sr, sc) = (p.src[0], p.src[1]);
    // Off-grid seed → empty field (defensive; the app always sends a valid cell).
    if sr < 0 || sr >= g.h as i64 || sc < 0 || sc >= g.w as i64 {
        return (vec![f32::INFINITY; n], vec![0.0; n]);
    }
    let (sr, sc) = (sr as usize, sc as usize);
    let round = p.density_mode == "round";
    let reverse = p.density_mode == "to";
    let total_cap = if round && p.e_max_mode == "total" && p.e_max > 0.0 { p.e_max } else { 0.0 };
    // Maximize is excluded from single-source backend (the inverted field is a
    // browser-only mode), so max_edge_cost is unused here.
    let max_edge_cost = 0.0;
    // Long moves integrate ON DEMAND here (tbl = None), mirroring the JS
    // dijkstra(): one or two searches never amortise a full-grid table
    // (under a budget the table would cost more than the search itself).
    // Values are bit-identical either way.

    if round {
        let mut s_f = Scratch::new(n, mv.has_long);
        let mut s_b = Scratch::new(n, mv.has_long);
        dijkstra_tree(g, sr, sc, p, false, max_edge_cost, portals, mv, None, &mut s_f);
        dijkstra_tree(g, sr, sc, p, true, max_edge_cost, portals, mv, None, &mut s_b);
        let mut energy = vec![f32::INFINITY; n];
        let mut include = vec![0u8; n];
        for i in 0..n {
            let fe = s_f.e[i];
            let be = s_b.e[i];
            if fe.is_finite() && be.is_finite() {
                // Compare the f64 sum against the cap BEFORE the f32 rounding,
                // mirroring the JS worker (and the density round path).
                let s = fe as f64 + be as f64;
                if !(total_cap > 0.0 && s > total_cap) {
                    energy[i] = s as f32;
                    include[i] = 1;
                }
            }
        }
        let passes = if p.want_passes {
            // f64 leg sum, like the JS worker's `passes[i] += pb[i]` on
            // Float64Arrays. Each leg stamps its long-move sweeps right
            // after its subtree walk, BEFORE the legs sum — JS order.
            let mut pf = subtree_passes_f64(&s_f, Some(&include));
            stamp_long_passes_f64(&mut pf, &s_f, &mv.sweep_by_delta);
            let mut pb = subtree_passes_f64(&s_b, Some(&include));
            stamp_long_passes_f64(&mut pb, &s_b, &mv.sweep_by_delta);
            (0..n).map(|i| pf[i] + pb[i]).collect()
        } else {
            vec![0.0; n]
        };
        (energy, passes)
    } else {
        let mut s = Scratch::new(n, mv.has_long);
        dijkstra_tree(g, sr, sc, p, reverse, max_edge_cost, portals, mv, None, &mut s);
        let energy = s.e.clone();
        let passes = if p.want_passes {
            let mut pp = subtree_passes_f64(&s, None);
            stamp_long_passes_f64(&mut pp, &s, &mv.sweep_by_delta);
            pp
        } else {
            vec![0.0; n]
        };
        (energy, passes)
    }
}

fn cors_headers() -> Vec<Header> {
    vec![
        Header::from_bytes("Access-Control-Allow-Origin", "*").unwrap(),
        Header::from_bytes("Access-Control-Allow-Methods", "POST, GET, OPTIONS").unwrap(),
        Header::from_bytes("Access-Control-Allow-Headers", "Content-Type").unwrap(),
    ]
}

fn respond_json(req: tiny_http::Request, status: u16, body: &str) {
    let mut res = Response::from_string(body).with_status_code(status);
    for hd in cors_headers() {
        res.add_header(hd);
    }
    res.add_header(Header::from_bytes("Content-Type", "application/json").unwrap());
    let _ = req.respond(res);
}

/// True if the request opted into a gzipped response via `X-Simu-Gzip: 1` — a
/// CUSTOM header set only by the orchestrator (Cloud path). We do NOT key off
/// `Accept-Encoding` because browsers send it automatically, which would gzip the
/// Localhost path (same machine → pure waste) and perturb the parity test.
fn wants_gzip(req: &tiny_http::Request) -> bool {
    req.headers()
        .iter()
        .any(|h| h.field.equiv("X-Simu-Gzip") && h.value.as_str() == "1")
}

/// True if the request body arrived gzip-compressed (`Content-Encoding: gzip`).
fn body_is_gzip(req: &tiny_http::Request) -> bool {
    req.headers()
        .iter()
        .any(|h| h.field.equiv("Content-Encoding") && h.value.as_str().eq_ignore_ascii_case("gzip"))
}

fn gzip_bytes(data: &[u8]) -> std::io::Result<Vec<u8>> {
    let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    enc.write_all(data)?;
    enc.finish()
}

/// Send an octet-stream payload, gzipping it (`Content-Encoding: gzip`) when the
/// caller opted in. Level-1 (fast): on the sparse, bounded-eMax fields that
/// dominate, it shrinks the body many-fold cheaply; it never touches the COMPUTED
/// values (compute path stays bit-parity — the parity test never sets X-Simu-Gzip).
fn respond_binary(req: tiny_http::Request, out: Vec<u8>, want_gz: bool) {
    let (body, gz) = if want_gz {
        match gzip_bytes(&out) {
            Ok(z) => (z, true),
            Err(_) => (out, false),
        }
    } else {
        (out, false)
    };
    let mut res = Response::from_data(body);
    for hd in cors_headers() {
        res.add_header(hd);
    }
    res.add_header(Header::from_bytes("Content-Type", "application/octet-stream").unwrap());
    if gz {
        res.add_header(Header::from_bytes("Content-Encoding", "gzip").unwrap());
    }
    let _ = req.respond(res);
}

// Ceiling on the request body (covers the largest supported DEMs:
// ~6 bytes/cell × ~135 M cells ≈ 0.8 GB, so 2 GiB is generous). Without it, a
// bogus Content-Length pre-allocs an enormous Vec (abort on alloc failure) and
// read_to_end would stream unbounded data — a trivial DoS.
const MAX_BODY: u64 = 2 * 1024 * 1024 * 1024;

/// Read + frame-parse a /density or /single body into (params, height,
/// dem_mask, net_eff_mask, portals). The framing, masks, and portal layout are
/// identical for both endpoints. `net_eff_mask` is Some(DEM AND network) when
/// has_network, else None (use dem_mask as-is) — the RAW dem_mask is returned
/// alongside because maximize must derive its height range from it (JS parity:
/// energy-worker.js computes maxEdgeCost over the raw mask BEFORE effMask,
/// ~line 1330). On malformed input returns (http_status, json_error_body);
/// the caller keeps `req` to send the response. `require_refs` rejects an empty
/// ref_points list (/density needs them; /single uses `src` instead).
fn parse_grid_request(
    req: &mut tiny_http::Request,
    require_refs: bool,
) -> Result<(Params, Vec<f32>, Vec<u8>, Option<Vec<u8>>, PortalAdj), (u16, String)> {
    let declared = req.body_length().unwrap_or(0) as u64;
    if declared > MAX_BODY {
        return Err((413, r#"{"error":"body too large"}"#.to_string()));
    }
    let mut body = Vec::with_capacity(declared.min(MAX_BODY) as usize);
    // Hard-cap the read so a client streaming more than it declared can't grow
    // the body unbounded. An over-long body truncates at MAX_BODY and then
    // fails the exact-length check below (→ 400).
    if req.as_reader().take(MAX_BODY).read_to_end(&mut body).is_err() {
        return Err((400, r#"{"error":"body read failed"}"#.to_string()));
    }
    // The orchestrator gzips the upload (Content-Encoding: gzip) to shrink the
    // expensive laptop→VM hop. Decompress before parsing. The decompressed read
    // is itself capped at MAX_BODY (anti gzip-bomb).
    if body_is_gzip(req) {
        let mut dec = Vec::new();
        if flate2::read::GzDecoder::new(&body[..])
            .take(MAX_BODY)
            .read_to_end(&mut dec)
            .is_err()
        {
            return Err((400, r#"{"error":"gzip decode failed"}"#.to_string()));
        }
        body = dec;
    }
    if body.len() < 4 {
        return Err((400, r#"{"error":"truncated body"}"#.to_string()));
    }
    let json_len = u32::from_le_bytes(body[0..4].try_into().unwrap()) as usize;
    if body.len() < 4 + json_len {
        return Err((400, r#"{"error":"truncated json"}"#.to_string()));
    }
    let mut params: Params = serde_json::from_slice(&body[4..4 + json_len])
        .map_err(|e| (400, format!(r#"{{"error":"bad params: {}"}}"#, e)))?;
    // Defense-in-depth mirror of energy-worker.js's eMaxEff: the kJ budget has
    // no meaning against maximize's inverted (maxEdgeCost-scaled) costs, so a
    // stale/non-app client sending both together must not silently prune the
    // whole field. app.js already sends eMax=0 under maximize; this guards
    // any other caller (backend/test-backend.mjs, a future orchestrator path).
    if params.maximize {
        params.e_max = 0.0;
    }
    // v57 move directions: whitelist. Reject anything else loudly — the JS
    // worker silently coerces invalid values to 8 (nDirsEff), but a backend
    // doing that would hand a non-app client a silently different move set.
    if ![4u32, 8, 16, 32, 64, 128].contains(&params.n_dirs) {
        return Err((400, format!(r#"{{"error":"nDirs {} not in {{4,8,16,32,64,128}}"}}"#, params.n_dirs)));
    }
    // Maximize forces the classic 8 (mirror of the JS worker's nDirsEff):
    // the inversion bound maxEdgeCost is a single-grid-edge property, so a
    // long move would invert to a clamped-0 free shortcut — the same
    // degeneracy that excludes portals from maximize.
    if params.maximize {
        params.n_dirs = 8;
    }
    let n = params.h * params.w;
    // An empty grid (h or w == 0) is meaningless and would make per_slice == 0
    // in compute_density → a divide-by-zero panic that, on this single-threaded
    // request loop, takes down the whole server. Reject it up front.
    if n == 0 {
        return Err((400, r#"{"error":"empty grid (h or w is 0)"}"#.to_string()));
    }
    let masks = if params.has_network { 2 } else { 1 };
    // Bridge portals append portalU (i32×P) + portalV (i32×P) + portalLenM (f64×P)
    // + portalHU (f64×P) + portalHV (f64×P) = 32 bytes/portal.
    let portal_bytes = params.n_portals * 32;
    let expected = 4 + json_len + 4 * n + masks * n + portal_bytes;
    if body.len() != expected {
        return Err((400, format!(r#"{{"error":"body length {} != expected {}"}}"#, body.len(), expected)));
    }
    if require_refs && params.ref_points.is_empty() {
        return Err((400, r#"{"error":"no ref points"}"#.to_string()));
    }

    let mut off = 4 + json_len;
    // Single memcpy into an owned (and therefore aligned) buffer — the
    // payload offset inside `body` is arbitrary, so casting in place isn't
    // sound; copying through the byte view of the destination is.
    let mut height = vec![0f32; n];
    bytemuck::cast_slice_mut::<f32, u8>(&mut height).copy_from_slice(&body[off..off + 4 * n]);
    off += 4 * n;
    let dem_mask: Vec<u8> = body[off..off + n].to_vec();
    off += n;
    // Effective mask = DEM mask AND network mask, like the JS worker. None
    // when no network ships (the callers then run on dem_mask directly).
    let net_eff_mask: Option<Vec<u8>> = if params.has_network {
        let net = &body[off..off + n];
        off += n;
        Some((0..n).map(|i| (dem_mask[i] != 0 && net[i] != 0) as u8).collect())
    } else {
        None
    };
    let eff_mask: &[u8] = net_eff_mask.as_deref().unwrap_or(&dem_mask);
    // Bridge portals (optional). Built on the effective mask + the height array,
    // identically to the JS worker, so portal costs match bit-for-bit.
    let pc = params.n_portals;
    let portals: PortalAdj = if pc > 0 {
        let mut pu = vec![0i32; pc];
        bytemuck::cast_slice_mut::<i32, u8>(&mut pu).copy_from_slice(&body[off..off + 4 * pc]);
        off += 4 * pc;
        let mut pv = vec![0i32; pc];
        bytemuck::cast_slice_mut::<i32, u8>(&mut pv).copy_from_slice(&body[off..off + 4 * pc]);
        off += 4 * pc;
        let mut pl = vec![0f64; pc];
        bytemuck::cast_slice_mut::<f64, u8>(&mut pl).copy_from_slice(&body[off..off + 8 * pc]);
        off += 8 * pc;
        let mut phu = vec![0f64; pc];
        bytemuck::cast_slice_mut::<f64, u8>(&mut phu).copy_from_slice(&body[off..off + 8 * pc]);
        off += 8 * pc;
        let mut phv = vec![0f64; pc];
        bytemuck::cast_slice_mut::<f64, u8>(&mut phv).copy_from_slice(&body[off..off + 8 * pc]);
        off += 8 * pc;
        // Excluded from maximize mode (mirrors energy-worker.js): a long deck
        // cost would invert against the single-grid-edge maxEdgeCost to a
        // clamped-0 free max-cost shortcut. Still read the bytes to advance off.
        if params.maximize {
            HashMap::new()
        } else {
            build_portals(&pu, &pv, &pl, &phu, &phv, &height, eff_mask, &params)
        }
    } else {
        HashMap::new()
    };
    let _ = off;
    Ok((params, height, dem_mask, net_eff_mask, portals))
}

fn handle_density(mut req: tiny_http::Request) {
    let t0 = Instant::now();
    let (params, height, dem_mask, net_eff_mask, portals) = match parse_grid_request(&mut req, true) {
        Ok(v) => v,
        Err((code, msg)) => return respond_json(req, code, &msg),
    };
    let n = params.h * params.w;
    let grid = Grid {
        height: &height,
        mask: net_eff_mask.as_deref().unwrap_or(&dem_mask),
        h: params.h,
        w: params.w,
        dx: params.dx,
        dy: params.dy,
    };
    // dem_mask rides along for maximize's height range (raw-mask JS parity).
    let mv = build_moves(params.n_dirs, params.w, params.dx, params.dy);
    let (density, energy, matrix) = compute_density(&grid, &dem_mask, &params, &portals, &mv);

    // "matrix":K announces the appended f32×K² accessibility matrix — its
    // absence tells a newer app this binary predates the feature (the app
    // then degrades to "KPI unavailable" instead of misreading the payload).
    let matrix_field = match &matrix {
        Some(_) => format!(r#","matrix":{}"#, params.ref_points.len()),
        None => String::new(),
    };
    let mut meta = format!(
        r#"{{"elapsed_ms":{:.1},"refs":{}{}}}"#,
        t0.elapsed().as_secs_f64() * 1000.0,
        params.ref_points.len(),
        matrix_field
    );
    // Pad the JSON (trailing spaces are valid) so the binary payload starts
    // 8-byte aligned — the app can then create Float64/Float32 views
    // directly on the response buffer instead of slice-copying ~12 bytes
    // per cell (1.6 GB of copies on a 135 M-cell DEM).
    while (4 + meta.len()) % 8 != 0 {
        meta.push(' ');
    }
    let matrix_len = matrix.as_ref().map_or(0, |m| m.len());
    let mut out = Vec::with_capacity(4 + meta.len() + 8 * n + 4 * n + 4 * matrix_len);
    out.extend_from_slice(&(meta.len() as u32).to_le_bytes());
    out.extend_from_slice(meta.as_bytes());
    out.extend_from_slice(bytemuck::cast_slice(&density));
    out.extend_from_slice(bytemuck::cast_slice(&energy));
    if let Some(m) = &matrix {
        out.extend_from_slice(bytemuck::cast_slice(m));
    }

    eprintln!(
        "[density] {}×{} grid, {} refs, mode={}, {:.0} ms",
        params.w,
        params.h,
        params.ref_points.len(),
        params.density_mode,
        t0.elapsed().as_secs_f64() * 1000.0
    );

    let want_gz = wants_gzip(&req);
    respond_binary(req, out, want_gz);
}

// POST /single — single-source energy field (the non-density modes' fast path).
// Same framed request as /density (it reuses parse_grid_request), but driven by
// `src` + `want_passes` instead of `ref_points`. Response:
//   [u32 json_len][json {"elapsed_ms":…,"passes":bool}]
//   [f32 energy × N]            (always)
//   [f64 passes × N]            (only when want_passes — f64 like the JS
//                                worker's Float64Array subtreePasses; counts
//                                exceed 2^24 on big DEMs, f32 would round)
// No JSON padding: the app slice-copies both arrays (cheap for a single search),
// so the views don't need alignment.
fn handle_single(mut req: tiny_http::Request) {
    let t0 = Instant::now();
    let (params, height, dem_mask, net_eff_mask, portals) = match parse_grid_request(&mut req, false) {
        Ok(v) => v,
        Err((code, msg)) => return respond_json(req, code, &msg),
    };
    // Maximize is browser-only by design (the backend produces no inverted
    // field on /single) — reject loudly instead of silently computing a
    // degenerate max_edge_cost=0 field.
    if params.maximize {
        return respond_json(
            req,
            400,
            r#"{"error":"maximize is browser-only; /single does not support it"}"#,
        );
    }
    let n = params.h * params.w;
    let grid = Grid {
        height: &height,
        mask: net_eff_mask.as_deref().unwrap_or(&dem_mask),
        h: params.h,
        w: params.w,
        dx: params.dx,
        dy: params.dy,
    };
    let mv = build_moves(params.n_dirs, params.w, params.dx, params.dy);
    let (energy, passes) = compute_single(&grid, &params, &portals, &mv);

    let meta = format!(
        r#"{{"elapsed_ms":{:.1},"passes":{}}}"#,
        t0.elapsed().as_secs_f64() * 1000.0,
        params.want_passes
    );
    let mut out = Vec::with_capacity(4 + meta.len() + 4 * n + if params.want_passes { 8 * n } else { 0 });
    out.extend_from_slice(&(meta.len() as u32).to_le_bytes());
    out.extend_from_slice(meta.as_bytes());
    out.extend_from_slice(bytemuck::cast_slice(&energy));
    if params.want_passes {
        out.extend_from_slice(bytemuck::cast_slice(&passes));
    }

    eprintln!(
        "[single] {}×{} grid, src=({},{}), mode={}, passes={}, {:.0} ms",
        params.w,
        params.h,
        params.src[0],
        params.src[1],
        params.density_mode,
        params.want_passes,
        t0.elapsed().as_secs_f64() * 1000.0
    );

    let want_gz = wants_gzip(&req);
    respond_binary(req, out, want_gz);
}

fn main() {
    // Args: an optional bind address (first non-flag arg) and an optional
    // `--max-mem-gb N` that caps the per-request slice memory budget (it just
    // sets SIMU_MAX_MEM_GB, the single source of truth read in
    // density_mem_budget_bytes). RAYON_NUM_THREADS also bounds parallelism.
    let mut addr = "127.0.0.1:8077".to_string();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut i = 0;
    while i < args.len() {
        if args[i] == "--max-mem-gb" && i + 1 < args.len() {
            std::env::set_var("SIMU_MAX_MEM_GB", &args[i + 1]);
            i += 2;
        } else {
            addr = args[i].clone();
            i += 1;
        }
    }
    let server = Server::http(&addr).unwrap_or_else(|e| {
        eprintln!("failed to bind {}: {}", addr, e);
        std::process::exit(1);
    });
    eprintln!(
        "simujoules-backend listening on http://{} ({} cores, density mem budget ≈ {:.1} GB). \
         Enable \"Use native backend\" in the app's parameters panel to use it.",
        addr,
        rayon::current_num_threads(),
        density_mem_budget_bytes() as f64 / 1e9,
    );

    // Inicializa o relógio de ociosidade com o horário de boot: uma VM
    // recém-ligada que ainda não recebeu cálculo mede ociosidade desde o boot (e
    // não desde 1970), dando margem pro upload inicial do DEM antes do primeiro
    // /density — e ainda assim se desliga sozinha se nunca for usada.
    LAST_COMPUTE_AT.store(unix_now_secs(), Ordering::SeqCst);

    for req in server.incoming_requests() {
        match (req.method().clone(), req.url().to_string().as_str()) {
            (Method::Options, _) => {
                let mut res = Response::empty(204);
                for hd in cors_headers() {
                    res.add_header(hd);
                }
                let _ = req.respond(res);
            }
            (Method::Get, "/health") => {
                // `mem_budget_bytes` lets the app's compute-time estimate
                // replicate this server's slice cap (n_slices ≈
                // min(refs, cores, mem_budget / per_slice)) instead of
                // assuming all cores parallelise — the dominant error on huge
                // DEMs, where each slice's ~5 GB scratch limits concurrency to
                // 1-2 regardless of core count. See estimateRunTime in app.js.
                // idle_seconds = agora − último cálculo (/density|/single), ou
                // desde o boot se nada rodou ainda (>= 0). /health NÃO carimba,
                // então o valor cresce de verdade entre cálculos e o watchdog
                // (poll periódico) desliga a VM quando passa de IDLE_MAX_S.
                let now = unix_now_secs();
                let last = LAST_COMPUTE_AT.load(Ordering::SeqCst);
                let idle_seconds = now.saturating_sub(last);
                respond_json(
                    req,
                    200,
                    &format!(
                        r#"{{"ok":true,"version":"{}","cores":{},"mem_budget_bytes":{},"idle_seconds":{}}}"#,
                        env!("CARGO_PKG_VERSION"),
                        rayon::current_num_threads(),
                        density_mem_budget_bytes(),
                        idle_seconds
                    ),
                );
            }
            // Carimba o relógio de ociosidade aqui (cálculo real), na chegada
            // da requisição — ver LAST_COMPUTE_AT — E DE NOVO ao final, depois
            // que o handler termina de responder. tiny_http serve requisições
            // sequencialmente, então /health fica inacessível durante o cálculo
            // (ociosidade corretamente conta como "ocupado"); sem o carimbo de
            // conclusão, um cálculo grande em nuvem (>15 min, o normal em DEMs
            // enormes — ver CLAUDE.md sobre a serialização 3-8x do slice cap)
            // faz idle_seconds saltar pra duração inteira da requisição assim
            // que ela termina, e o watchdog periódico pode desligar a VM no
            // intervalo curto até a próxima requisição (ex.: as duas chamadas
            // sequenciais de startDensityCompare em app.js).
            (Method::Post, "/density") => {
                LAST_COMPUTE_AT.store(unix_now_secs(), Ordering::SeqCst);
                handle_density(req);
                LAST_COMPUTE_AT.store(unix_now_secs(), Ordering::SeqCst);
            }
            (Method::Post, "/single") => {
                LAST_COMPUTE_AT.store(unix_now_secs(), Ordering::SeqCst);
                handle_single(req);
                LAST_COMPUTE_AT.store(unix_now_secs(), Ordering::SeqCst);
            }
            _ => respond_json(req, 404, r#"{"error":"not found"}"#),
        }
    }
}
