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
//     response body: [u32 json_len][json {"elapsed_ms":…,"refs":…}]
//                    [f64 passes × N][f32 energy × N]
//   POST /single    (single-source energy field: from/to/round, energy+passes)
//     request body:  same framing as /density, driven by Params.src +
//                    Params.want_passes instead of ref_points
//     response body: [u32 json_len][json {"elapsed_ms":…,"passes":bool}]
//                    [f32 energy × N][f32 passes × N — only when want_passes]
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
    // f32 (not f64): subtree counts are exact integers up to 2^24 and only
    // ever divided into the f64 `Acc.density` (widened below), so this is
    // bit-parity-safe vs the JS worker on the test grid while saving 4 B/cell.
    passes: Vec<f32>,
    heap: RadixHeap,
}

impl Scratch {
    fn new(n: usize) -> Self {
        Scratch {
            e: vec![f32::INFINITY; n],
            parents: vec![-1; n],
            settled: vec![0; n],
            order: Vec::with_capacity(n),
            passes: vec![0.0; n],
            heap: RadixHeap::new(),
        }
    }
    fn reset(&mut self) {
        self.e.fill(f32::INFINITY);
        self.parents.fill(-1);
        self.settled.fill(0);
        self.order.clear();
        self.passes.fill(0.0);
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
    s: &mut Scratch,
) {
    s.reset();
    let (h, w) = (g.h, g.w);
    let diag = g.dx.hypot(g.dy);
    let drs: [i64; 8] = [-1, -1, -1, 0, 0, 1, 1, 1];
    let dcs: [i64; 8] = [-1, 0, 1, -1, 1, -1, 0, 1];
    let dists: [f64; 8] = [diag, g.dy, diag, g.dx, g.dx, diag, g.dy, diag];
    let d_idx: [i64; 8] = core::array::from_fn(|k| drs[k] * w as i64 + dcs[k]);

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
        let inner = r > 0 && r < h - 1 && c > 0 && c < w - 1;

        for k in 0..8 {
            let n_idx = if inner {
                (idx as i64 + d_idx[k]) as usize
            } else {
                let nr = r as i64 + drs[k];
                let nc = c as i64 + dcs[k];
                if nr < 0 || nr >= h as i64 || nc < 0 || nc >= w as i64 {
                    continue;
                }
                (nr * w as i64 + nc) as usize
            };
            if g.mask[n_idx] == 0 || s.settled[n_idx] != 0 {
                continue;
            }

            let h_nbr = g.height[n_idx] as f64;
            let dh = if reverse { h_here - h_nbr } else { h_nbr - h_here };
            let dist = dists[k];

            let mut edge = v2_edge(dist, dh, &p.cost);
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
    /// computes FILTERED passes for both legs, so only displayed
    /// (round-trip-feasible) destinations count as trajectory endpoints.
    fn accumulate_round(
        &mut self,
        fwd: &mut Scratch,
        bwd: &mut Scratch,
        include: &mut [u8],
        total_cap: f64,
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
        subtree_passes(bwd, Some(include));
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

fn compute_density(g: &Grid, p: &Params, portals: &PortalAdj) -> (Vec<f64>, Vec<f32>) {
    let n = g.h * g.w;

    // Same MAX_EDGE_COST bound as the JS worker's maximize mode.
    let max_edge_cost = if p.maximize {
        let (mut min_h, mut max_h) = (f64::INFINITY, f64::NEG_INFINITY);
        for i in 0..n {
            if g.mask[i] != 0 {
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

    // Off-grid / off-mask refs are skipped, like the JS worker.
    let refs: Vec<(usize, usize)> = p
        .ref_points
        .iter()
        .filter(|rc| {
            let (r, c) = (rc[0], rc[1]);
            r >= 0
                && (r as usize) < g.h
                && c >= 0
                && (c as usize) < g.w
                && g.mask[r as usize * g.w + c as usize] != 0
        })
        .map(|rc| (rc[0] as usize, rc[1] as usize))
        .collect();

    let round = p.density_mode == "round";
    let reverse = p.density_mode == "to";
    let total_cap = if round && p.e_max_mode == "total" && p.e_max > 0.0 { p.e_max } else { 0.0 };

    // Cap concurrent slices by a memory budget so high ref counts on huge
    // DEMs don't OOM-crash. Each concurrent slice holds full-N buffers:
    //   Scratch ≈ 17·n (e4 + parents4 + settled1 + order4 + passes4),
    //   Acc     ≈ 20·n (density8 + energy_sum8 + energy_count4).
    // Round runs two Scratch (s_f + s_b) plus an `include` Uint8 (n bytes).
    // Fewer slices just means more refs processed serially per slice (the
    // Scratch is already reused across a slice's refs), so the OUTPUT is
    // unchanged — only wall time grows. SIMU_MAX_MEM_GB / --max-mem-gb /
    // RAYON_NUM_THREADS are the manual levers (see README).
    let n64 = n as u64;
    let scratch_bytes = 17 * n64;
    let acc_bytes = 20 * n64;
    // .max(1) guards the divisor: handle_density already rejects n==0, but a
    // zero per_slice here would panic the request loop (defensive belt).
    let per_slice = (if round { 2 * scratch_bytes + acc_bytes + n64 } else { scratch_bytes + acc_bytes }).max(1);
    let mem_cap = (density_mem_budget_bytes() / per_slice).max(1) as usize;
    let n_slices = refs.len()
        .min(rayon::current_num_threads())
        .min(mem_cap)
        .max(1);
    // Echo the request shape (budget / mode / network-constrained) so the log
    // makes each compute self-describing. Emax=∞ means no budget (full grid).
    let emax_str = if p.e_max > 0.0 { format!("{:.0}", p.e_max) } else { "∞".to_string() };
    let net_type = if p.has_network { "vector" } else { "raster" };
    eprintln!(
        "[density] {} refs, Emax={}, mode={}, type={}, {}×{} grid, per-slice ≈ {:.1} GB, budget ≈ {:.1} GB → {} slice(s)",
        refs.len(), emax_str, p.density_mode, net_type, g.w, g.h,
        per_slice as f64 / 1e9, density_mem_budget_bytes() as f64 / 1e9, n_slices,
    );

    let accs: Vec<Acc> = (0..n_slices)
        .into_par_iter()
        .map(|sl| {
            let lo = sl * refs.len() / n_slices;
            let hi = (sl + 1) * refs.len() / n_slices;
            let mut acc = Acc::new(n);
            if round {
                // Forward/backward are independent — join them so round runs
                // with fewer refs than cores still spread across the machine.
                let mut s_f = Scratch::new(n);
                let mut s_b = Scratch::new(n);
                let mut include = vec![0u8; n];
                for &(r, c) in &refs[lo..hi] {
                    rayon::join(
                        || dijkstra_tree(g, r, c, p, false, max_edge_cost, portals, &mut s_f),
                        || dijkstra_tree(g, r, c, p, true, max_edge_cost, portals, &mut s_b),
                    );
                    acc.accumulate_round(&mut s_f, &mut s_b, &mut include, total_cap);
                }
            } else {
                let mut s = Scratch::new(n);
                for &(r, c) in &refs[lo..hi] {
                    dijkstra_tree(g, r, c, p, reverse, max_edge_cost, portals, &mut s);
                    subtree_passes(&mut s, None);
                    acc.accumulate(&s);
                }
            }
            acc
        })
        .collect();

    // Sequential slice-order merge — deterministic across runs.
    let acc = accs.into_iter().reduce(Acc::merge).unwrap_or_else(|| Acc::new(n));

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
    (density, energy)
}

/// Single-source energy field — port of energy-worker.js's from/to/round
/// single-point path (the non-density branch). Returns the raw per-cell energy
/// (NOT averaged like density) and, when `want_passes`, the per-cell passes
/// count (subtree sizes). Maximize/top-N/path stay browser-only (the backend
/// produces no routes), so this is energy + passes only. Round mode sums the
/// forward + backward legs (masking over-budget sums in "total" mode) and
/// filters passes to round-trip-feasible endpoints — exactly like the worker.
fn compute_single(g: &Grid, p: &Params, portals: &PortalAdj) -> (Vec<f32>, Vec<f32>) {
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

    if round {
        let mut s_f = Scratch::new(n);
        let mut s_b = Scratch::new(n);
        dijkstra_tree(g, sr, sc, p, false, max_edge_cost, portals, &mut s_f);
        dijkstra_tree(g, sr, sc, p, true, max_edge_cost, portals, &mut s_b);
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
            subtree_passes(&mut s_f, Some(&include));
            subtree_passes(&mut s_b, Some(&include));
            (0..n).map(|i| s_f.passes[i] + s_b.passes[i]).collect()
        } else {
            vec![0.0; n]
        };
        (energy, passes)
    } else {
        let mut s = Scratch::new(n);
        dijkstra_tree(g, sr, sc, p, reverse, max_edge_cost, portals, &mut s);
        let energy = s.e.clone();
        let passes = if p.want_passes {
            subtree_passes(&mut s, None);
            s.passes.clone()
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
/// eff_mask, portals). The framing, masks, and portal layout are identical for
/// both endpoints. On malformed input returns (http_status, json_error_body);
/// the caller keeps `req` to send the response. `require_refs` rejects an empty
/// ref_points list (/density needs them; /single uses `src` instead).
fn parse_grid_request(
    req: &mut tiny_http::Request,
    require_refs: bool,
) -> Result<(Params, Vec<f32>, Vec<u8>, PortalAdj), (u16, String)> {
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
    let params: Params = serde_json::from_slice(&body[4..4 + json_len])
        .map_err(|e| (400, format!(r#"{{"error":"bad params: {}"}}"#, e)))?;
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
    let dem_mask = &body[off..off + n];
    off += n;
    // Effective mask = DEM mask AND network mask, like the JS worker.
    let eff_mask: Vec<u8> = if params.has_network {
        let net = &body[off..off + n];
        off += n;
        (0..n).map(|i| (dem_mask[i] != 0 && net[i] != 0) as u8).collect()
    } else {
        dem_mask.to_vec()
    };
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
            build_portals(&pu, &pv, &pl, &phu, &phv, &height, &eff_mask, &params)
        }
    } else {
        HashMap::new()
    };
    let _ = off;
    Ok((params, height, eff_mask, portals))
}

fn handle_density(mut req: tiny_http::Request) {
    let t0 = Instant::now();
    let (params, height, eff_mask, portals) = match parse_grid_request(&mut req, true) {
        Ok(v) => v,
        Err((code, msg)) => return respond_json(req, code, &msg),
    };
    let n = params.h * params.w;
    let grid = Grid {
        height: &height,
        mask: &eff_mask,
        h: params.h,
        w: params.w,
        dx: params.dx,
        dy: params.dy,
    };
    let (density, energy) = compute_density(&grid, &params, &portals);

    let mut meta = format!(
        r#"{{"elapsed_ms":{:.1},"refs":{}}}"#,
        t0.elapsed().as_secs_f64() * 1000.0,
        params.ref_points.len()
    );
    // Pad the JSON (trailing spaces are valid) so the binary payload starts
    // 8-byte aligned — the app can then create Float64/Float32 views
    // directly on the response buffer instead of slice-copying ~12 bytes
    // per cell (1.6 GB of copies on a 135 M-cell DEM).
    while (4 + meta.len()) % 8 != 0 {
        meta.push(' ');
    }
    let mut out = Vec::with_capacity(4 + meta.len() + 8 * n + 4 * n);
    out.extend_from_slice(&(meta.len() as u32).to_le_bytes());
    out.extend_from_slice(meta.as_bytes());
    out.extend_from_slice(bytemuck::cast_slice(&density));
    out.extend_from_slice(bytemuck::cast_slice(&energy));

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
//   [f32 passes × N]            (only when want_passes)
// No JSON padding: the app slice-copies both arrays (cheap for a single search),
// so the f32 views don't need alignment.
fn handle_single(mut req: tiny_http::Request) {
    let t0 = Instant::now();
    let (params, height, eff_mask, portals) = match parse_grid_request(&mut req, false) {
        Ok(v) => v,
        Err((code, msg)) => return respond_json(req, code, &msg),
    };
    let n = params.h * params.w;
    let grid = Grid {
        height: &height,
        mask: &eff_mask,
        h: params.h,
        w: params.w,
        dx: params.dx,
        dy: params.dy,
    };
    let (energy, passes) = compute_single(&grid, &params, &portals);

    let meta = format!(
        r#"{{"elapsed_ms":{:.1},"passes":{}}}"#,
        t0.elapsed().as_secs_f64() * 1000.0,
        params.want_passes
    );
    let mut out = Vec::with_capacity(4 + meta.len() + 4 * n + if params.want_passes { 4 * n } else { 0 });
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
            // Carimba o relógio de ociosidade SÓ aqui (cálculo real), na chegada
            // da requisição — ver LAST_COMPUTE_AT. Um cálculo longo conta a
            // ociosidade desde a chegada, então IDLE_MAX_S deve folgar acima da
            // duração de um cálculo único (o alvo roda em poucos minutos << 900 s).
            (Method::Post, "/density") => {
                LAST_COMPUTE_AT.store(unix_now_secs(), Ordering::SeqCst);
                handle_density(req)
            }
            (Method::Post, "/single") => {
                LAST_COMPUTE_AT.store(unix_now_secs(), Ordering::SeqCst);
                handle_single(req)
            }
            _ => respond_json(req, 404, r#"{"error":"not found"}"#),
        }
    }
}
