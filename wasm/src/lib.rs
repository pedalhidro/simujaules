// Simujaules — in-browser WebAssembly build of the native engine.
//
// `include!` pastes backend/src/main.rs VERBATIM into this crate, so the wasm
// engine IS the backend engine: same cost model, radix heap, f32/f64 round
// trips, request validation (parse_grid_body). JS-worker parity is exactly what
// backend/test-backend.mjs guarantees for the native binary, and wasm/
// test-wasm.mjs re-checks it through wasm-worker.js. Never put engine logic
// here — change main.rs and rebuild (./build.sh), or the browser and the
// backend drift apart.
//
// ABI (no wasm-bindgen; `usize` is the pointer width — u32 on wasm32, u64 on
// wasm64, i.e. a JS BigInt there):
//   alloc(len) -> ptr        a buffer the page fills with the SAME framed bytes
//                            as POST /density | /single (see main.rs header)
//   run(ptr, len, kind) -> status
//                            CONSUMES the buffer (freed right after parsing, so
//                            its space is reused by the search). kind 0 =
//                            density PARTIAL (raw accumulators of the given refs,
//                            for the app's worker-pool merge), kind 1 = single
//                            source. status 0 = ok, else an HTTP-style code with
//                            the message at err_ptr/err_len.
//   out_count() / out_ptr(i) / out_len(i)
//                            the result arrays, as byte ranges in linear memory:
//                              kind 0 → density f64×N (Σ passes/N), energy_sum
//                                       f64×N, energy_count u32×N[, matrix f32 ×
//                                       refs·cols when requested]
//                              kind 1 → energy f32×N[, passes f64×N when
//                                       want_passes]
//   release()                drop the results (the page copies them out first)
//   free(ptr, len)           return an alloc()ed buffer that was never run
//
// A panic or an allocation failure traps (panic = abort on these targets); the
// worker then discards the instance and falls back to the JS engine.
#![allow(dead_code, unused_imports)]

include!("../../backend/src/main.rs");

use std::cell::RefCell;

enum Buf {
    F64(Vec<f64>),
    F32(Vec<f32>),
    U32(Vec<u32>),
}

impl Buf {
    fn bytes(&self) -> &[u8] {
        match self {
            Buf::F64(v) => bytemuck::cast_slice(v),
            Buf::F32(v) => bytemuck::cast_slice(v),
            Buf::U32(v) => bytemuck::cast_slice(v),
        }
    }
}

thread_local! {
    static OUT: RefCell<Vec<Buf>> = RefCell::new(Vec::new());
    static ERR: RefCell<String> = RefCell::new(String::new());
}

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    // with_capacity(len) allocates EXACTLY len (so run() can rebuild the Vec
    // with capacity == len); the page overwrites every byte before run().
    let mut v: Vec<u8> = Vec::with_capacity(len);
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

#[no_mangle]
pub unsafe extern "C" fn free(ptr: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(ptr, 0, len));
}

#[no_mangle]
pub extern "C" fn release() {
    OUT.with(|o| o.borrow_mut().clear());
    ERR.with(|e| e.borrow_mut().clear());
}

#[no_mangle]
pub extern "C" fn out_count() -> usize {
    OUT.with(|o| o.borrow().len())
}

#[no_mangle]
pub extern "C" fn out_ptr(i: usize) -> *const u8 {
    OUT.with(|o| o.borrow().get(i).map_or(std::ptr::null(), |b| b.bytes().as_ptr()))
}

#[no_mangle]
pub extern "C" fn out_len(i: usize) -> usize {
    OUT.with(|o| o.borrow().get(i).map_or(0, |b| b.bytes().len()))
}

#[no_mangle]
pub extern "C" fn err_ptr() -> *const u8 {
    ERR.with(|e| e.borrow().as_ptr())
}

#[no_mangle]
pub extern "C" fn err_len() -> usize {
    ERR.with(|e| e.borrow().len())
}

fn fail(code: u16, msg: String) -> u32 {
    ERR.with(|e| *e.borrow_mut() = msg);
    code as u32
}

#[no_mangle]
pub unsafe extern "C" fn run(ptr: *mut u8, len: usize, kind: u32) -> u32 {
    release();
    let body = Vec::from_raw_parts(ptr, len, len);
    // Density partials need refs; single-source uses `src` instead (/single).
    let parsed = parse_grid_body(&body, kind == 0);
    // Free the framed copy BEFORE the search allocates: the parsed height/mask
    // are owned copies, and dlmalloc reuses this hole for the scratch buffers,
    // keeping the linear-memory high-water mark (which never shrinks) lower.
    drop(body);
    let (params, height, dem_mask, net_eff_mask, portals) = match parsed {
        Ok(v) => v,
        Err((code, msg)) => return fail(code, msg),
    };
    let grid = Grid {
        height: &height,
        mask: net_eff_mask.as_deref().unwrap_or(&dem_mask),
        h: params.h,
        w: params.w,
        dx: params.dx,
        dy: params.dy,
    };
    let mv = build_moves(params.n_dirs, params.w, params.dx, params.dy);
    let bufs = match kind {
        0 => {
            // dem_mask rides along for maximize's height range (raw-mask JS parity).
            let (acc, matrix) = compute_density_acc(&grid, &dem_mask, &params, &portals, &mv);
            let mut b = vec![Buf::F64(acc.density), Buf::F64(acc.energy_sum), Buf::U32(acc.energy_count)];
            if let Some(m) = matrix {
                b.push(Buf::F32(m));
            }
            b
        }
        1 => {
            // Same rejection as handle_single: maximize is browser-only (the JS
            // engine owns the inverted single-source field).
            if params.maximize {
                return fail(400, r#"{"error":"maximize is not served by the wasm engine"}"#.to_string());
            }
            let (energy, passes) = compute_single(&grid, &params, &portals, &mv);
            let mut b = vec![Buf::F32(energy)];
            if params.want_passes {
                b.push(Buf::F64(passes));
            }
            b
        }
        _ => return fail(400, format!(r#"{{"error":"unknown kind {}"}}"#, kind)),
    };
    OUT.with(|o| *o.borrow_mut() = bufs);
    0
}
