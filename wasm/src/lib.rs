//! Asymmetric Dijkstra over a DEM grid, exposed to JS via wasm-bindgen.
//!
//! Mirrors energy-worker.js exactly so behavior is identical. Cost model
//! per directed edge u -> v with `dh = h_v - h_u`:
//!
//!   if dh >= 0: edge = alpha * dist + beta * dh
//!   else:       edge = max(0, alpha * dist - eta * beta * |dh|)
//!
//! `reverse=true` scores edges in the opposite direction (energy *to* the
//! seed), used for "to destination" mode and for the second leg of round
//! trip.
//!
//! Buffers (height/mask/energy/parents) are allocated once at construction
//! and held inside `EnergySolver`. JS reads/writes them via memory views,
//! so DEM upload and result fetch are zero-copy across the wasm boundary.

use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct EnergySolver {
    h: usize,
    w: usize,
    height: Vec<f32>,
    mask: Vec<u8>,
    energy: Vec<f32>,
    parents: Vec<i32>,
    settled: Vec<u8>,
}

#[wasm_bindgen]
impl EnergySolver {
    #[wasm_bindgen(constructor)]
    pub fn new(h: u32, w: u32) -> Self {
        let h = h as usize;
        let w = w as usize;
        let n = h.checked_mul(w).expect("H * W overflow");
        Self {
            h,
            w,
            height: vec![0.0_f32; n],
            mask: vec![0_u8; n],
            energy: vec![f32::INFINITY; n],
            parents: vec![-1_i32; n],
            settled: vec![0_u8; n],
        }
    }

    pub fn cell_count(&self) -> u32 {
        (self.h * self.w) as u32
    }

    pub fn height_ptr(&self) -> u32 {
        self.height.as_ptr() as u32
    }

    pub fn mask_ptr(&self) -> u32 {
        self.mask.as_ptr() as u32
    }

    pub fn energy_ptr(&self) -> u32 {
        self.energy.as_ptr() as u32
    }

    pub fn parents_ptr(&self) -> u32 {
        self.parents.as_ptr() as u32
    }

    /// Run Dijkstra from `(seed_r, seed_c)`.
    ///
    /// `reverse=true` flips the height delta so the cost reflects the cost
    /// of arriving *at* the seed from each cell. `track_parents=true` fills
    /// the `parents` buffer for path reconstruction.
    #[allow(clippy::too_many_arguments)]
    pub fn run(
        &mut self,
        seed_r: u32,
        seed_c: u32,
        dx: f32,
        dy: f32,
        alpha: f32,
        beta: f32,
        eta: f32,
        reverse: bool,
        track_parents: bool,
        e_max: f32, // 0 = no budget; >0 = stop expanding past this
    ) {
        let h = self.h;
        let w = self.w;
        let n = h * w;

        // Reset state. parents only need clearing if we're going to read them.
        for v in self.energy.iter_mut() {
            *v = f32::INFINITY;
        }
        for v in self.settled.iter_mut() {
            *v = 0;
        }
        if track_parents {
            for v in self.parents.iter_mut() {
                *v = -1;
            }
        }

        let seed_r = seed_r as usize;
        let seed_c = seed_c as usize;
        if seed_r >= h || seed_c >= w {
            return;
        }
        let seed_idx = seed_r * w + seed_c;
        if self.mask[seed_idx] == 0 {
            return;
        }
        self.energy[seed_idx] = 0.0;

        let diag = (dx * dx + dy * dy).sqrt();
        // 8-neighbor offsets, matching energy-worker.js order.
        let drs: [i32; 8] = [-1, -1, -1, 0, 0, 1, 1, 1];
        let dcs: [i32; 8] = [-1, 0, 1, -1, 1, -1, 0, 1];
        let dists: [f32; 8] = [diag, dy, diag, dx, dx, diag, dy, diag];

        // Manual binary min-heap on parallel Vecs (priority + payload).
        // Avoids tuple allocations and matches the JS implementation 1:1.
        let init_cap = if n < 65_536 { n.max(16) } else { 65_536 };
        let mut hp: Vec<f32> = Vec::with_capacity(init_cap);
        let mut hi: Vec<u32> = Vec::with_capacity(init_cap);
        hp.push(0.0);
        hi.push(seed_idx as u32);

        let h_i32 = h as i32;
        let w_i32 = w as i32;

        while !hp.is_empty() {
            // -- pop min --
            let g = hp[0];
            let idx = hi[0] as usize;
            let last = hp.len() - 1;
            if last > 0 {
                hp[0] = hp[last];
                hi[0] = hi[last];
            }
            hp.pop();
            hi.pop();
            // sift down
            let len = hp.len();
            if len > 1 {
                let mut i = 0_usize;
                loop {
                    let l = 2 * i + 1;
                    let r = 2 * i + 2;
                    let mut s = i;
                    if l < len && hp[l] < hp[s] {
                        s = l;
                    }
                    if r < len && hp[r] < hp[s] {
                        s = r;
                    }
                    if s == i {
                        break;
                    }
                    hp.swap(s, i);
                    hi.swap(s, i);
                    i = s;
                }
            }

            // Filter stale heap entries via a per-cell `settled` flag rather
            // than `g > self.energy[idx]`. Strict-greater-than is fragile in
            // the presence of equal-priority duplicates (and matches the JS
            // worker's bug-fix shape, so the two implementations stay in
            // structural lockstep).
            if self.settled[idx] != 0 {
                continue;
            }
            self.settled[idx] = 1;
            // Drop the unused `g` warning while we're here.
            let _ = g;

            let r = idx / w;
            let c = idx % w;
            let h_here = self.height[idx];

            for k in 0..8 {
                let nr = r as i32 + drs[k];
                let nc = c as i32 + dcs[k];
                if nr < 0 || nr >= h_i32 || nc < 0 || nc >= w_i32 {
                    continue;
                }
                let n_idx = (nr as usize) * w + (nc as usize);
                if self.mask[n_idx] == 0 {
                    continue;
                }
                // Skip already-settled neighbours. Symmetric to the settled-
                // flag staleness check; required for parents-tracking modes
                // (passes count) where a stray relax can corrupt the tree.
                if self.settled[n_idx] != 0 {
                    continue;
                }

                let h_nbr = self.height[n_idx];
                let dh = if reverse { h_here - h_nbr } else { h_nbr - h_here };
                let dist = dists[k];

                let edge = if dh >= 0.0 {
                    alpha * dist + beta * dh
                } else {
                    let e = alpha * dist - eta * beta * (-dh);
                    if e < 0.0 {
                        0.0
                    } else {
                        e
                    }
                };

                let tentative = g + edge;
                // Energy budget. With e_max <= 0, no budget is enforced.
                if e_max > 0.0 && tentative > e_max {
                    continue;
                }
                if tentative < self.energy[n_idx] {
                    self.energy[n_idx] = tentative;
                    if track_parents {
                        self.parents[n_idx] = idx as i32;
                    }
                    // -- push (sift up) --
                    hp.push(tentative);
                    hi.push(n_idx as u32);
                    let mut i = hp.len() - 1;
                    while i > 0 {
                        let parent = (i - 1) / 2;
                        if hp[parent] <= hp[i] {
                            break;
                        }
                        hp.swap(parent, i);
                        hi.swap(parent, i);
                        i = parent;
                    }
                }
            }
        }
    }
}
